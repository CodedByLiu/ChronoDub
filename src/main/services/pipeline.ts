import { mkdirSync, rmSync } from 'fs'
import { join, basename, extname } from 'path'
import { BrowserWindow } from 'electron'
import type { Cue, Segment, TimeWindow, AppConfig, TaskStatus } from '../../types'
import { parseSubtitleFile, cuesToSrt, saveSubtitleFile } from './subtitle-parser'
import { translateCues, applyTerminologyToChinese } from './deepseek'
import { synthesize } from './edge-tts'
import { ffprobe, muxVideoWithAudio } from './ffmpeg'
import {
  buildSegments,
  buildTimeWindows,
  calibrateCPS,
  assignBudgets,
  processAudio,
  synthesizeWithFallback,
  assembleToWav,
  type AssemblerSegment,
  type FallbackContext,
} from './audio-processor'
import { tmpdir } from 'os'

// ─── Task state management ──────────────────────

interface TaskState {
  cancelled: boolean
  paused: boolean
  pauseResolver: (() => void) | null
  reviewResolver: ((cues: Cue[]) => void) | null
  reviewRejecter: ((err: Error) => void) | null
  chineseCues: Cue[]
  countdownTimer: ReturnType<typeof setInterval> | null
}

const activeTasks = new Map<string, TaskState>()

function getTaskState(taskId: string): TaskState {
  let state = activeTasks.get(taskId)
  if (!state) {
    state = {
      cancelled: false,
      paused: false,
      pauseResolver: null,
      reviewResolver: null,
      reviewRejecter: null,
      chineseCues: [],
      countdownTimer: null,
    }
    activeTasks.set(taskId, state)
  }
  return state
}

function cleanupTask(taskId: string): void {
  const state = activeTasks.get(taskId)
  if (state?.countdownTimer) clearInterval(state.countdownTimer)
  activeTasks.delete(taskId)
}

function checkCancelled(taskId: string): void {
  const state = activeTasks.get(taskId)
  if (state?.cancelled) throw new Error('TASK_CANCELLED')
}

async function checkPaused(taskId: string): Promise<void> {
  const state = activeTasks.get(taskId)
  if (!state?.paused) return
  await new Promise<void>((resolve) => {
    state.pauseResolver = resolve
  })
}

// ─── Progress reporting ─────────────────────────

function sendToRenderer(channel: string, ...args: unknown[]): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, ...args)
  })
}

const lastWorkStatus = new Map<string, { status: TaskStatus; progress: number }>()

function reportProgress(taskId: string, status: TaskStatus, progress: number): void {
  if (status !== 'paused' && status !== 'completed' && status !== 'error') {
    lastWorkStatus.set(taskId, { status, progress })
  }
  sendToRenderer('task:progress', taskId, status, progress)
}

// ─── Review checkpoint ──────────────────────────

async function reviewCheckpoint(
  taskId: string,
  englishCues: Cue[],
  chineseCues: Cue[],
  config: AppConfig
): Promise<Cue[]> {
  const state = getTaskState(taskId)
  state.chineseCues = [...chineseCues]

  sendToRenderer('task:review-ready', taskId, englishCues, chineseCues)
  reportProgress(taskId, 'reviewing', 50)

  if (config.reviewMode === 'auto') {
    return autoReview(taskId, state, config.autoReviewCountdown)
  }
  return manualReview(taskId, state)
}

function autoReview(taskId: string, state: TaskState, countdownSec: number): Promise<Cue[]> {
  return new Promise((resolve, reject) => {
    state.reviewResolver = resolve
    state.reviewRejecter = reject

    let remaining = countdownSec
    sendToRenderer('task:review-countdown', taskId, remaining)

    state.countdownTimer = setInterval(() => {
      remaining--
      sendToRenderer('task:review-countdown', taskId, remaining)

      if (remaining <= 0) {
        if (state.countdownTimer) clearInterval(state.countdownTimer)
        state.countdownTimer = null
        state.reviewResolver = null
        state.reviewRejecter = null
        resolve(state.chineseCues)
      }
    }, 1000)
  })
}

function manualReview(taskId: string, state: TaskState): Promise<Cue[]> {
  return new Promise((resolve, reject) => {
    state.reviewResolver = resolve
    state.reviewRejecter = reject
  })
}

// ─── Public API for IPC handlers ────────────────

export function saveReviewCues(taskId: string, cues: Cue[]): void {
  const state = activeTasks.get(taskId)
  if (state) state.chineseCues = cues
}

export function confirmReview(taskId: string, cues: Cue[]): void {
  const state = activeTasks.get(taskId)
  if (!state) return

  state.chineseCues = cues
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer)
    state.countdownTimer = null
  }
  if (state.reviewResolver) {
    state.reviewResolver(cues)
    state.reviewResolver = null
    state.reviewRejecter = null
  }
}

export function pauseTask(taskId: string): void {
  getTaskState(taskId).paused = true
  const last = lastWorkStatus.get(taskId)
  reportProgress(taskId, 'paused', last?.progress ?? 0)
}

export function resumeTask(taskId: string): void {
  const state = activeTasks.get(taskId)
  if (!state) return
  state.paused = false
  if (state.pauseResolver) {
    state.pauseResolver()
    state.pauseResolver = null
  }
  const last = lastWorkStatus.get(taskId)
  if (last) {
    reportProgress(taskId, last.status, last.progress)
  } else {
    reportProgress(taskId, 'synthesizing', 55)
  }
}

export function cancelAllTasks(taskIds: string[]): void {
  for (const id of taskIds) {
    cancelTask(id)
  }
}

export function cancelTask(taskId: string): void {
  const state = activeTasks.get(taskId)
  if (!state) return

  state.cancelled = true
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer)
    state.countdownTimer = null
  }
  if (state.reviewRejecter) {
    state.reviewRejecter(new Error('TASK_CANCELLED'))
    state.reviewResolver = null
    state.reviewRejecter = null
  }
  if (state.pauseResolver) {
    state.pauseResolver()
    state.pauseResolver = null
  }
}

// ─── Main pipeline ──────────────────────────────

export async function runPipeline(
  taskId: string,
  videoPath: string,
  subtitlePath: string,
  config: AppConfig
): Promise<void> {
  getTaskState(taskId)
  let tempDir: string | undefined

  try {
    // Step 1: Parse subtitles
    reportProgress(taskId, 'parsing', 5)
    const englishCues = parseSubtitleFile(subtitlePath)
    if (englishCues.length === 0) throw new Error('字幕文件为空或解析失败')
    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    // Step 2: Build segments
    reportProgress(taskId, 'parsing', 10)
    const segments = buildSegments(englishCues)
    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    // Step 3: Get video duration & build time windows
    await checkPaused(taskId)
    checkCancelled(taskId)
    const probeResult = await ffprobe(videoPath)
    const windows = buildTimeWindows(segments, probeResult.durationUs)
    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    // Step 4: CPS calibration
    reportProgress(taskId, 'parsing', 15)
    const cps = await calibrateCPS(config.selectedVoice)
    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    // Step 5: Assign budgets
    assignBudgets(windows, cps)

    // Step 6: Translate with DeepSeek
    reportProgress(taskId, 'translating', 20)
    const budgetMap = new Map<number, number>()
    for (const w of windows) {
      const seg = segments[w.segmentId]
      for (const cueId of seg.cueIds) {
        const cueCount = seg.cueIds.length
        budgetMap.set(cueId, Math.max(1, Math.floor(w.budgetChars / cueCount)))
      }
    }

    const translations = await translateCues(
      englishCues,
      config.deepseekKey,
      config.dictionary,
      budgetMap,
      async () => {
        await checkPaused(taskId)
        checkCancelled(taskId)
      },
    )
    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    const chineseCues: Cue[] = englishCues.map((cue) => {
      const raw = translations.get(cue.id) || cue.text
      const text = applyTerminologyToChinese(cue.text, raw, config.dictionary)
      return { ...cue, text }
    })

    reportProgress(taskId, 'translating', 45)

    // Step 7: Review checkpoint
    await checkPaused(taskId)
    checkCancelled(taskId)
    const reviewedCues = await reviewCheckpoint(taskId, englishCues, chineseCues, config)
    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    // Build segment text from reviewed cues
    const cueTextMap = new Map<number, string>()
    for (const c of reviewedCues) cueTextMap.set(c.id, c.text)

    for (const seg of segments) {
      seg.textZh = seg.cueIds.map((id) => cueTextMap.get(id) || '').join('')
    }

    // Step 8 & 9: TTS synthesis per segment with fallback + duration measurement
    reportProgress(taskId, 'synthesizing', 55)
    const assemblerSegments: AssemblerSegment[] = []
    const totalSegments = segments.length

    for (let i = 0; i < totalSegments; i++) {
      checkCancelled(taskId)
      await checkPaused(taskId)
      checkCancelled(taskId)

      const seg = segments[i]
      const win = windows[i]
      const text = seg.textZh || ''

      if (!text.trim()) {
        assemblerSegments.push({
          startUs: win.startUs,
          deadlineUs: win.deadlineUs,
          pcm: Buffer.alloc(0),
        })
        continue
      }

      const ctx: FallbackContext = {
        text,
        windowUs: win.windowUs,
        voice: config.selectedVoice,
        apiKey: config.deepseekKey,
        segmentIndex: i,
        segments: assemblerSegments,
        windows,
      }

      const audio = await synthesizeWithFallback(ctx)

      assemblerSegments.push({
        startUs: win.startUs,
        deadlineUs: win.deadlineUs,
        pcm: audio.pcm,
      })

      const synthProgress = 55 + Math.round(((i + 1) / totalSegments) * 25)
      reportProgress(taskId, 'synthesizing', synthProgress)
    }

    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    // Step 10: Assemble audio track
    reportProgress(taskId, 'assembling', 82)
    tempDir = join(tmpdir(), `chronodub-${taskId}`)
    mkdirSync(tempDir, { recursive: true })
    const wavPath = join(tempDir, 'dubbed.wav')
    await assembleToWav(assemblerSegments, probeResult.durationUs, wavPath)
    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    // Step 11: FFmpeg mux
    reportProgress(taskId, 'encoding', 88)
    const videoName = basename(videoPath, extname(videoPath))
    const videoExt = extname(videoPath)
    const outputDir = join(config.outputDir, videoName)
    mkdirSync(outputDir, { recursive: true })

    const outputVideoPath = join(outputDir, videoName + videoExt)
    await checkPaused(taskId)
    checkCancelled(taskId)
    await muxVideoWithAudio(videoPath, wavPath, outputVideoPath)
    checkCancelled(taskId)

    // Step 12: Save Chinese subtitle
    reportProgress(taskId, 'encoding', 95)
    const outputSubPath = join(outputDir, videoName + '.srt')
    saveSubtitleFile(outputSubPath, reviewedCues)

    // Done
    reportProgress(taskId, 'completed', 100)
  } catch (err: any) {
    if (err?.message === 'TASK_CANCELLED') {
      return
    }
    console.error(`Pipeline 失败 [${taskId}]:`, err)
    reportProgress(taskId, 'error', 0)
    sendToRenderer('task:error', taskId, err?.message || '未知错误')
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        /* noop */
      }
    }
    cleanupTask(taskId)
    lastWorkStatus.delete(taskId)
  }
}

export function startTasks(taskIds: string[], tasks: Array<{ videoPath: string; subtitlePath: string | null }>, config: AppConfig): void {
  for (let i = 0; i < taskIds.length; i++) {
    const taskId = taskIds[i]
    const task = tasks[i]
    if (!task?.subtitlePath) {
      reportProgress(taskId, 'error', 0)
      sendToRenderer('task:error', taskId, '未关联字幕文件')
      continue
    }
    runPipeline(taskId, task.videoPath, task.subtitlePath, config)
  }
}
