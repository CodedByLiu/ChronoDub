import { mkdirSync, rmSync } from 'fs'
import { join, basename, extname } from 'path'
import { BrowserWindow, powerSaveBlocker } from 'electron'
import type { Cue, Segment, TimeWindow, AppConfig, TaskStatus } from '../../types'
import { parseSubtitleFile, saveSubtitleFile } from './subtitle-parser'
import { translateSegments, applyTerminologyToChinese } from './deepseek'
import { ffprobe, muxVideoWithAudio } from './ffmpeg'
import {
  buildSegments,
  buildTimeWindows,
  calibrateCPS,
  assignBudgets,
  classifySegmentRisk,
  synthesizeWithFallback,
  assembleToWav,
  type AssemblerSegment,
  type FallbackContext,
  type SegmentRisk,
} from './audio-processor'
import { tmpdir } from 'os'
import { deleteTaskCues, saveTaskCues } from '../task-cue-store'
import {
  getTaskSnapshot,
  updateTaskCountdownSnapshot,
  updateTaskErrorSnapshot,
  updateTaskStatusSnapshot,
} from '../task-registry'
import { clearReviewCountdown, runReviewSession, type ReviewSessionState } from './review-session'

// ─── Task state management ──────────────────────

interface TaskState extends ReviewSessionState {
  cancelled: boolean
  pauseRequested: boolean
  currentStatus: TaskStatus
  pauseResolver: (() => void) | null
}

const activeTasks = new Map<string, TaskState>()
let currentConcurrentPipelineLimit = 2

interface QueuedTaskEntry {
  taskId: string
  videoPath: string
  subtitlePath: string
  config: AppConfig
}

const pendingTasks: QueuedTaskEntry[] = []
const queuedTaskIds = new Set<string>()
const pendingResumeTaskIds: string[] = []
const queuedResumeTaskIds = new Set<string>()
const BLOCK_SLEEP_STATUSES = new Set<TaskStatus>([
  'parsing',
  'translating',
  'synthesizing',
  'assembling',
  'encoding',
])
const LAST_WORK_STATUSES = new Set<TaskStatus>([
  'parsing',
  'translating',
  'reviewing',
  'synthesizing',
  'assembling',
  'encoding',
])
const SYNTHESIS_SEGMENT_TIMEOUT_MS = 180_000
let sleepBlockerId: number | null = null

function getConcurrentPipelineLimit(config?: AppConfig): number {
  const value = config?.maxConcurrentTasks
  if (value === 2 || value === 4 || value === 6 || value === 8) return value
  return 2
}

function validateTaskConfig(config: AppConfig): string | null {
  if (!config.selectedVoice?.trim()) return '未选择 TTS 声音，请先在配置面板中选择语音'
  if (!config.deepseekKey?.trim()) return '未填写 DeepSeek API Key，请先在配置面板中完成配置'
  if (!config.outputDir?.trim()) return '未选择输出目录，请先设置输出目录'
  return null
}

function getTaskState(taskId: string): TaskState {
  let state = activeTasks.get(taskId)
  if (!state) {
    state = {
      cancelled: false,
      paused: false,
      pauseRequested: false,
      currentStatus: 'waiting',
      pauseResolver: null,
      reviewResolver: null,
      reviewRejecter: null,
      chineseCues: [],
      countdownTimer: null,
      countdownRemaining: null,
    }
    activeTasks.set(taskId, state)
  }
  return state
}

function cleanupTask(taskId: string): void {
  const state = activeTasks.get(taskId)
  if (state) clearReviewCountdown(state)
  activeTasks.delete(taskId)
  removeQueuedResumeTask(taskId)
  updateSleepBlocker()
}

function updateSleepBlocker(): void {
  const shouldBlockSleep = Array.from(activeTasks.values()).some(
    (state) =>
      !state.cancelled && !state.paused && BLOCK_SLEEP_STATUSES.has(state.currentStatus)
  )

  if (shouldBlockSleep) {
    if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) return
    sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    return
  }

  if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) {
    powerSaveBlocker.stop(sleepBlockerId)
  }
  sleepBlockerId = null
}

function removeQueuedTask(taskId: string): boolean {
  const index = pendingTasks.findIndex((task) => task.taskId === taskId)
  if (index < 0) return false
  pendingTasks.splice(index, 1)
  queuedTaskIds.delete(taskId)
  return true
}

function removeQueuedResumeTask(taskId: string): boolean {
  const index = pendingResumeTaskIds.findIndex((id) => id === taskId)
  if (index < 0) return false
  pendingResumeTaskIds.splice(index, 1)
  queuedResumeTaskIds.delete(taskId)
  return true
}

function getRunnableActiveCount(): number {
  let count = 0
  for (const state of activeTasks.values()) {
    if (!state.cancelled && !state.paused) count++
  }
  return count
}

function resumePausedTaskNow(taskId: string): boolean {
  const state = activeTasks.get(taskId)
  if (!state || state.cancelled) return false

  state.pauseRequested = false
  state.paused = false
  if (state.pauseResolver) {
    state.pauseResolver()
    state.pauseResolver = null
  }

  const last = lastWorkStatus.get(taskId)
  if (last) {
    reportProgress(taskId, last.status, last.progress, last.detail)
  } else {
    reportProgress(taskId, 'synthesizing', 55)
  }
  updateSleepBlocker()
  return true
}

function startNextQueuedTasks(): void {
  while (getRunnableActiveCount() < currentConcurrentPipelineLimit) {
    const nextResumeTaskId = pendingResumeTaskIds.shift()
    if (nextResumeTaskId) {
      queuedResumeTaskIds.delete(nextResumeTaskId)
      if (resumePausedTaskNow(nextResumeTaskId)) continue
    }

    const nextTask = pendingTasks.shift()
    if (!nextTask) return
    queuedTaskIds.delete(nextTask.taskId)
    void runPipeline(nextTask.taskId, nextTask.videoPath, nextTask.subtitlePath, nextTask.config)
  }
}

function enqueueTask(task: QueuedTaskEntry, front = false): void {
  if (activeTasks.has(task.taskId) || queuedTaskIds.has(task.taskId)) return

  if (front) pendingTasks.unshift(task)
  else pendingTasks.push(task)

  queuedTaskIds.add(task.taskId)
  reportProgress(task.taskId, 'queued', 0)
  startNextQueuedTasks()
}

function enqueuePausedTaskForResume(taskId: string): void {
  if (queuedResumeTaskIds.has(taskId) || !activeTasks.has(taskId)) return
  pendingResumeTaskIds.push(taskId)
  queuedResumeTaskIds.add(taskId)
  const last = lastWorkStatus.get(taskId)
  reportProgress(taskId, 'queued', last?.progress ?? 0)
}

function checkCancelled(taskId: string): void {
  const state = activeTasks.get(taskId)
  if (state?.cancelled) throw new Error('TASK_CANCELLED')
}

async function checkPaused(taskId: string): Promise<void> {
  const state = activeTasks.get(taskId)
  if (!state || (!state.paused && !state.pauseRequested)) return
  if (!state.paused) {
    state.pauseRequested = false
    state.paused = true
    updateSleepBlocker()
    startNextQueuedTasks()
  }
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

const lastWorkStatus = new Map<string, { status: TaskStatus; progress: number; detail?: string }>()

function reportProgress(taskId: string, status: TaskStatus, progress: number, detail?: string): void {
  const state = activeTasks.get(taskId)
  const pausePending =
    !!state &&
    (state.pauseRequested || state.paused) &&
    status !== 'paused' &&
    status !== 'queued' &&
    status !== 'completed' &&
    status !== 'error'

  if (state && !pausePending) {
    state.currentStatus = status
  }
  if (LAST_WORK_STATUSES.has(status)) {
    lastWorkStatus.set(taskId, { status, progress, detail })
  }
  if (pausePending) {
    return
  }
  updateTaskStatusSnapshot(taskId, status, progress, detail)
  updateSleepBlocker()
  sendToRenderer('task:progress', taskId, status, progress, detail)
}

function reportReviewCountdown(taskId: string, remaining: number): void {
  updateTaskCountdownSnapshot(taskId, remaining)
  sendToRenderer('task:review-countdown', taskId, remaining)
}

function reportTaskError(taskId: string, message: string): void {
  updateTaskErrorSnapshot(taskId, message)
  sendToRenderer('task:error', taskId, message)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null

  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ─── Review checkpoint ──────────────────────────

async function reviewCheckpoint(
  taskId: string,
  englishCues: Cue[],
  chineseCues: Cue[],
  config: AppConfig
): Promise<Cue[]> {
  const state = getTaskState(taskId)
  return runReviewSession(taskId, state, englishCues, chineseCues, config, {
    persistCues: (data) => saveTaskCues(taskId, data),
    onReady: (readyEnglishCues, readyChineseCues) => {
      sendToRenderer('task:review-ready', taskId, readyEnglishCues, readyChineseCues)
    },
    onProgress: (status, progress) => reportProgress(taskId, status, progress),
    onCountdown: (remaining) => reportReviewCountdown(taskId, remaining),
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

function computeSegmentTranslationBudget(windowBudget: number, risk: SegmentRisk): number {
  // The window budget already includes a safety factor. Give the translator a small
  // amount of room so natural Chinese does not get compressed too early.
  const slackRatio = risk === 'high' ? 0.02 : risk === 'medium' ? 0.05 : 0.1
  const maxSlack = risk === 'high' ? 2 : risk === 'medium' ? 4 : 6
  const slack = Math.min(maxSlack, Math.max(1, Math.ceil(windowBudget * slackRatio)))
  return Math.max(1, windowBudget + slack)
}

// ─── Public API for IPC handlers ────────────────

export async function saveReviewCues(taskId: string, cues: Cue[]): Promise<void> {
  const state = activeTasks.get(taskId)
  if (state) state.chineseCues = cues
  await saveTaskCues(taskId, { chineseCues: cues })
}

export async function confirmReview(taskId: string, cues: Cue[]): Promise<void> {
  const state = activeTasks.get(taskId)
  await saveTaskCues(taskId, { chineseCues: cues })
  if (!state) return

  state.chineseCues = cues
  clearReviewCountdown(state)
  if (state.reviewResolver) {
    state.reviewResolver(cues)
    state.reviewResolver = null
    state.reviewRejecter = null
  }
}

function getPauseDetail(currentStatus: TaskStatus): string | undefined {
  if (currentStatus === 'synthesizing') return '暂停中，等待当前片段合成结束'
  if (
    currentStatus === 'parsing' ||
    currentStatus === 'translating' ||
    currentStatus === 'assembling' ||
    currentStatus === 'encoding'
  ) {
    return '暂停中，等待当前步骤结束'
  }
  return undefined
}

function pauseQueuedTask(taskId: string): boolean {
  const removedQueuedTask = removeQueuedTask(taskId)
  const removedQueuedResume = removeQueuedResumeTask(taskId)

  if (!removedQueuedTask && !removedQueuedResume) return false

  const state = activeTasks.get(taskId)
  if (state) {
    state.pauseRequested = false
    state.paused = true
  }

  const snapshot = getTaskSnapshot(taskId)
  const last = lastWorkStatus.get(taskId)
  const progress = last?.progress ?? snapshot?.progress ?? 0
  reportProgress(taskId, 'paused', progress)
  return true
}

function pauseTaskInternal(taskId: string, refillQueue: boolean): void {
  if (pauseQueuedTask(taskId)) return

  const state = activeTasks.get(taskId)
  if (!state || state.cancelled || state.paused || state.pauseRequested) return

  removeQueuedResumeTask(taskId)
  const last = lastWorkStatus.get(taskId)
  const progress = last?.progress ?? 0
  const detail = getPauseDetail(state.currentStatus)

  if (state.currentStatus === 'reviewing') {
    state.paused = true
    reportProgress(taskId, 'paused', progress, detail)
    if (refillQueue) startNextQueuedTasks()
    return
  }

  state.pauseRequested = true
  reportProgress(taskId, 'paused', progress, detail)
}

export function pauseTask(taskId: string): void {
  pauseTaskInternal(taskId, true)
}

export function resumeTask(taskId: string, config?: AppConfig): void {
  if (config) {
    currentConcurrentPipelineLimit = getConcurrentPipelineLimit(config)
  }

  const state = activeTasks.get(taskId)
  if (state) {
    if (state.cancelled) return
    removeQueuedResumeTask(taskId)

    if (state.pauseRequested && !state.paused) {
      state.pauseRequested = false
      const last = lastWorkStatus.get(taskId)
      if (last) reportProgress(taskId, last.status, last.progress, last.detail)
      updateSleepBlocker()
      return
    }

    if (!state.paused) return

    if (getRunnableActiveCount() < currentConcurrentPipelineLimit) {
      resumePausedTaskNow(taskId)
    } else {
      enqueuePausedTaskForResume(taskId)
    }
    return
  }

  if (!config) return
  if (queuedTaskIds.has(taskId)) return
  const task = getTaskSnapshot(taskId)
  if (!task?.subtitlePath) return
  enqueueTask(
    {
      taskId,
      videoPath: task.videoPath,
      subtitlePath: task.subtitlePath,
      config,
    },
    true
  )
}

export function cancelAllTasks(taskIds: string[]): void {
  for (const id of taskIds) {
    cancelTask(id)
  }
}

export function cancelTask(taskId: string): void {
  if (removeQueuedTask(taskId)) {
    void deleteTaskCues(taskId)
    return
  }
  removeQueuedResumeTask(taskId)

  const state = activeTasks.get(taskId)
  if (!state) {
    void deleteTaskCues(taskId)
    return
  }

  state.cancelled = true
  updateSleepBlocker()
  clearReviewCountdown(state)
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
  const queuedTaskIdsToPause = Array.from(queuedTaskIds)
  const queuedResumeTaskIdsToPause = Array.from(queuedResumeTaskIds)
  const taskIdsToPause: string[] = []

  for (const taskId of queuedTaskIdsToPause) {
    pauseQueuedTask(taskId)
  }

  for (const taskId of queuedResumeTaskIdsToPause) {
    pauseQueuedTask(taskId)
  }

  for (const [taskId, state] of activeTasks) {
    if (state.cancelled || state.paused || state.pauseRequested) continue
    taskIdsToPause.push(taskId)
  }

  for (const taskId of taskIdsToPause) {
    pauseTaskInternal(taskId, false)
  }
}

export function resumeAllTasks(taskIds: string[], config?: AppConfig): void {
  if (!Array.isArray(taskIds) || taskIds.length === 0 || !config) return
  currentConcurrentPipelineLimit = getConcurrentPipelineLimit(config)

  for (const taskId of taskIds) {
    if (typeof taskId !== 'string' || !taskId.trim()) continue
    resumeTask(taskId, config)
  }
}

export function updateConcurrentPipelineLimit(config?: AppConfig): void {
  currentConcurrentPipelineLimit = getConcurrentPipelineLimit(config)
  startNextQueuedTasks()
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
    const configError = validateTaskConfig(config)
    if (configError) throw new Error(configError)

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
    const segmentRiskMap = new Map<number, SegmentRisk>()
    for (const w of windows) {
      const seg = segments[w.segmentId]
      segmentRiskMap.set(seg.id, classifySegmentRisk(seg, w.windowUs))
    }

    // Step 6: Translate with DeepSeek at segment granularity
    reportProgress(taskId, 'translating', 20)
    const segmentBudgetMap = new Map<number, number>()
    for (const w of windows) {
      const risk = segmentRiskMap.get(w.segmentId) ?? 'medium'
      segmentBudgetMap.set(w.segmentId, computeSegmentTranslationBudget(w.budgetChars, risk))
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
    reportProgress(taskId, 'synthesizing', 55, '正在准备音频合成')
    const assemblerSegments: AssemblerSegment[] = []
    const totalSegments = segments.length

    for (let i = 0; i < totalSegments; i++) {
      checkCancelled(taskId)
      await checkPaused(taskId)
      checkCancelled(taskId)

      const seg = segments[i]
      const win = windows[i]
      const text = seg.textZh || ''
      const synthProgress = 55 + Math.round(((i + 1) / totalSegments) * 25)
      const segmentDetail = `正在合成第 ${i + 1}/${totalSegments} 段音频`

      reportProgress(taskId, 'synthesizing', Math.max(55, synthProgress - 1), segmentDetail)

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
        risk: segmentRiskMap.get(seg.id) ?? 'medium',
        segmentIndex: i,
        segments: assemblerSegments,
        windows,
      }

      const audio = await withTimeout(
        synthesizeWithFallback(ctx),
        SYNTHESIS_SEGMENT_TIMEOUT_MS,
        `音频合成超时：第 ${i + 1}/${totalSegments} 段等待超过 ${Math.round(SYNTHESIS_SEGMENT_TIMEOUT_MS / 1000)} 秒`
      )

      assemblerSegments.push({
        startUs: win.startUs,
        deadlineUs: win.deadlineUs,
        pcm: audio.pcm,
      })

      reportProgress(taskId, 'synthesizing', synthProgress, segmentDetail)
    }

    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    // Step 10: Assemble audio track
    reportProgress(taskId, 'assembling', 82, '正在拼接整条配音轨道')
    tempDir = join(tmpdir(), `chronodub-${taskId}`)
    mkdirSync(tempDir, { recursive: true })
    const wavPath = join(tempDir, 'dubbed.wav')
    await assembleToWav(assemblerSegments, probeResult.durationUs, wavPath)
    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    // Step 11: FFmpeg mux
    reportProgress(taskId, 'encoding', 88, '正在封装输出视频')
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
    reportProgress(taskId, 'encoding', 95, '正在写出字幕和结果文件')
    const outputSubPath = join(outputDir, videoName + '.srt')
    saveSubtitleFile(outputSubPath, reviewedCues)
    await saveTaskCues(taskId, { englishCues, chineseCues: reviewedCues })

    // Done
    reportProgress(taskId, 'completed', 100, '处理完成')
  } catch (err: any) {
    if (err?.message === 'TASK_CANCELLED') {
      return
    }
    console.error(`Pipeline 失败 [${taskId}]:`, err)
    reportProgress(taskId, 'error', 0)
    const message =
      typeof err?.message === 'string' && err.message.trim()
        ? err.message
        : typeof err === 'string' && err.trim()
          ? err
          : '未知错误'
    reportTaskError(taskId, message)
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
    startNextQueuedTasks()
  }
}

export function startTasks(
  taskIds: string[],
  tasks: Array<{ videoPath: string; subtitlePath: string | null }>,
  config: AppConfig
): void {
  const configError = validateTaskConfig(config)
  currentConcurrentPipelineLimit = getConcurrentPipelineLimit(config)

  for (let i = 0; i < taskIds.length; i++) {
    const taskId = taskIds[i]
    const task = tasks[i]
    if (activeTasks.has(taskId) || queuedTaskIds.has(taskId)) continue
    if (configError) {
      reportProgress(taskId, 'error', 0)
      sendToRenderer('task:error', taskId, configError)
      continue
    }
    if (!task?.subtitlePath) {
      reportProgress(taskId, 'error', 0)
      sendToRenderer('task:error', taskId, '未关联字幕文件')
      continue
    }
    enqueueTask({
      taskId,
      videoPath: task.videoPath,
      subtitlePath: task.subtitlePath,
      config,
    })
  }
}
