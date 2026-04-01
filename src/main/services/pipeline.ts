import { mkdirSync, rmSync } from 'fs'
import { join, basename, extname } from 'path'
import { BrowserWindow } from 'electron'
import type { Cue, Segment, TimeWindow, AppConfig, TaskStatus } from '../../types'
import { parseSubtitleFile, saveSubtitleFile } from './subtitle-parser'
import { translateSegments, applyTerminologyToChinese } from './deepseek'
import { ffprobe, muxVideoWithAudio } from './ffmpeg'
import {
  buildSegments,
  buildTimeWindows,
  calibrateCPS,
  assignBudgets,
  synthesizeWithFallback,
  assembleToWav,
  type AssemblerSegment,
  type FallbackContext,
} from './audio-processor'
import { tmpdir } from 'os'
import { loadTaskSnapshots } from '../task-store'

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

const ASCII_WORD_CHAR_RE = /[A-Za-z0-9_./#+-]/
const PREFERRED_SPLIT_AFTER_RE = /[\s,.;:!?，。；：！？、）)\]}]/
const PREFERRED_SPLIT_BEFORE_RE = /[\s（([{]/

function isAsciiWordChar(ch: string | undefined): boolean {
  return !!ch && ASCII_WORD_CHAR_RE.test(ch)
}

function isSafeSplitBoundary(text: string, index: number): boolean {
  const prev = text[index - 1]
  const next = text[index]
  if (!prev || !next) return true
  return !(isAsciiWordChar(prev) && isAsciiWordChar(next))
}

function isPreferredSplitBoundary(text: string, index: number): boolean {
  const prev = text[index - 1]
  const next = text[index]
  if (!prev || !next) return true
  if (PREFERRED_SPLIT_AFTER_RE.test(prev) || PREFERRED_SPLIT_BEFORE_RE.test(next)) return true
  return isSafeSplitBoundary(text, index)
}

function findSplitBoundary(text: string, target: number, min: number, max: number): number {
  const clamped = Math.max(min, Math.min(max, target))
  const maxRadius = Math.max(clamped - min, max - clamped)

  for (let radius = 0; radius <= maxRadius; radius++) {
    const left = clamped - radius
    const right = clamped + radius

    if (left >= min && isPreferredSplitBoundary(text, left)) return left
    if (right <= max && right !== left && isPreferredSplitBoundary(text, right)) return right
  }

  for (let radius = 0; radius <= maxRadius; radius++) {
    const left = clamped - radius
    const right = clamped + radius

    if (left >= min && isSafeSplitBoundary(text, left)) return left
    if (right <= max && right !== left && isSafeSplitBoundary(text, right)) return right
  }

  return clamped
}

function splitSegmentTextAcrossCues(text: string, cues: Cue[]): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (cues.length === 0) return []
  if (cues.length === 1) return [normalized]
  if (!normalized) return Array(cues.length).fill('')

  const weights = cues.map((cue) => Math.max(1, cue.endUs - cue.startUs))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)

  const boundaries: number[] = []
  let consumedWeight = 0
  let lastBoundary = 0

  for (let i = 0; i < cues.length - 1; i++) {
    consumedWeight += weights[i]
    const target = Math.round((normalized.length * consumedWeight) / totalWeight)
    const remainingParts = cues.length - i - 1
    const min = lastBoundary + 1
    const max = normalized.length - remainingParts
    const boundary = findSplitBoundary(normalized, target, min, max)
    boundaries.push(boundary)
    lastBoundary = boundary
  }

  const pieces: string[] = []
  let start = 0
  for (const boundary of boundaries) {
    pieces.push(normalized.slice(start, boundary).trim())
    start = boundary
  }
  pieces.push(normalized.slice(start).trim())

  return pieces
}

function joinCueTextsForSpeech(parts: string[]): string {
  let text = ''

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue

    if (!text) {
      text = trimmed
      continue
    }

    const prev = text[text.length - 1]
    const next = trimmed[0]
    text += isAsciiWordChar(prev) && isAsciiWordChar(next) ? ` ${trimmed}` : trimmed
  }

  return text
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

export function resumeTask(taskId: string, config?: AppConfig): void {
  const state = activeTasks.get(taskId)
  if (state) {
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
    return
  }

  if (!config) return
  const task = loadTaskSnapshots().find((t) => t.id === taskId)
  if (!task?.subtitlePath) return
  runPipeline(taskId, task.videoPath, task.subtitlePath, config)
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

export function pauseAllActiveTasks(): void {
  for (const [taskId, state] of activeTasks) {
    if (state.cancelled || state.paused) continue
    pauseTask(taskId)
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

    // Step 6: Translate with DeepSeek at segment granularity
    reportProgress(taskId, 'translating', 20)
    const segmentBudgetMap = new Map<number, number>()
    for (const w of windows) {
      segmentBudgetMap.set(w.segmentId, Math.max(1, w.budgetChars))
    }

    const translations = await translateSegments(
      segments.map((segment) => ({ id: segment.id, text: segment.textEn })),
      config.deepseekKey,
      config.dictionary,
      segmentBudgetMap,
      async () => {
        await checkPaused(taskId)
        checkCancelled(taskId)
      }
    )
    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    const englishCueMap = new Map<number, Cue>(englishCues.map((cue) => [cue.id, cue]))
    const translatedCueTextMap = new Map<number, string>()

    for (const segment of segments) {
      const raw = translations.get(segment.id) || segment.textEn
      const segmentText = applyTerminologyToChinese(segment.textEn, raw, config.dictionary)
      const segmentCues = segment.cueIds
        .map((cueId) => englishCueMap.get(cueId))
        .filter((cue): cue is Cue => !!cue)
      const cueTexts = splitSegmentTextAcrossCues(segmentText, segmentCues)

      segmentCues.forEach((cue, index) => {
        translatedCueTextMap.set(cue.id, cueTexts[index] || '')
      })
    }

    const chineseCues: Cue[] = englishCues.map((cue) => ({
      ...cue,
      text: translatedCueTextMap.get(cue.id) || cue.text,
    }))

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
      seg.textZh = joinCueTextsForSpeech(seg.cueIds.map((id) => cueTextMap.get(id) || ''))
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

export function startTasks(
  taskIds: string[],
  tasks: Array<{ videoPath: string; subtitlePath: string | null }>,
  config: AppConfig
): void {
  for (let i = 0; i < taskIds.length; i++) {
    const taskId = taskIds[i]
    const task = tasks[i]
    if (activeTasks.has(taskId)) continue
    if (!task?.subtitlePath) {
      reportProgress(taskId, 'error', 0)
      sendToRenderer('task:error', taskId, '未关联字幕文件')
      continue
    }
    runPipeline(taskId, task.videoPath, task.subtitlePath, config)
  }
}
