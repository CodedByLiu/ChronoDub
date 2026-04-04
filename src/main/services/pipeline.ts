import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { BrowserWindow, powerSaveBlocker } from 'electron'
import type { Cue, AppConfig, TaskStatus } from '../../types'
import { parseSubtitleFile, saveSubtitleFile } from './subtitle-parser'
import { translateSegments, applyTerminologyToChinese } from './deepseek'
import { burnSubtitlesIntoVideo, ffprobe, muxVideoWithAudio } from './ffmpeg'
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
import {
  computeSegmentTranslationBudget,
  joinCueTextsForSpeech,
  retimeSegmentCues,
  splitSegmentTextAcrossCues,
} from './subtitle-timing'
import { reserveOutputTarget, type ReservedOutputTarget } from './output-path'
import { saveAssSubtitleFile } from './subtitle-renderer'
import { TaskScheduler, type ScheduledTaskEntry } from './task-scheduler'
import { getRuntimeConfig, setRuntimeConfig } from '../runtime-config-store'

// ─── Task state management ──────────────────────

interface TaskState extends ReviewSessionState {
  cancelled: boolean
  pauseRequested: boolean
  currentStatus: TaskStatus
  pauseResolver: (() => void) | null
}

const activeTasks = new Map<string, TaskState>()
let currentConcurrentPipelineLimit = 2
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
  if (state?.cancelled) {
    void deleteTaskCues(taskId)
  }
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

const scheduler = new TaskScheduler({
  getRunnableActiveCount,
  resumeTaskNow: resumePausedTaskNow,
  runTask: (task: ScheduledTaskEntry) => {
    const config = getRuntimeConfig()
    void runPipeline(task.taskId, task.videoPath, task.subtitlePath, config)
  },
  reportQueued: (taskId, progress) => {
    reportProgress(taskId, 'queued', progress)
  },
})

function removeQueuedTask(taskId: string): boolean {
  return scheduler.removeQueuedTask(taskId)
}

function removeQueuedResumeTask(taskId: string): boolean {
  return scheduler.removeQueuedResume(taskId)
}

function listQueuedTaskIds(): string[] {
  return scheduler.listQueuedTaskIds()
}

function listQueuedResumeTaskIds(): string[] {
  return scheduler.listQueuedResumeTaskIds()
}

function startNextQueuedTasks(): void {
  scheduler.process()
}

function enqueueTask(task: ScheduledTaskEntry, front = false): void {
  if (activeTasks.has(task.taskId) || scheduler.hasQueuedTask(task.taskId)) return
  scheduler.enqueueTask(task, front)
}

function enqueuePausedTaskForResume(taskId: string): void {
  if (!activeTasks.has(taskId)) return
  const last = lastWorkStatus.get(taskId)
  scheduler.enqueueResume(taskId, last?.progress ?? 0)
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

function reportTaskError(taskId: string, message: string, detail?: string): void {
  updateTaskErrorSnapshot(taskId, message, detail)
  sendToRenderer('task:error', taskId, message, detail)
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() || ''
}

function collectErrorText(err: unknown, seen = new Set<unknown>()): string[] {
  if (err == null || seen.has(err)) return []

  if (typeof err === 'string') {
    const text = firstLine(err)
    return text ? [text] : []
  }

  if (typeof err !== 'object') return []
  seen.add(err)

  const parts: string[] = []
  const record = err as {
    message?: unknown
    code?: unknown
    syscall?: unknown
    address?: unknown
    port?: unknown
    cause?: unknown
    errors?: unknown
  }

  if (typeof record.message === 'string') {
    const text = firstLine(record.message)
    if (text) parts.push(text)
  }
  if (typeof record.code === 'string') parts.push(record.code)
  if (typeof record.syscall === 'string') parts.push(record.syscall)
  if (typeof record.address === 'string') parts.push(record.address)
  if (typeof record.port === 'number') parts.push(String(record.port))
  if (record.cause !== undefined) parts.push(...collectErrorText(record.cause, seen))
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) {
      parts.push(...collectErrorText(item, seen))
    }
  }

  return parts
}

function extractTaskErrorDetail(err: unknown): string | undefined {
  const uniqueParts = Array.from(new Set(collectErrorText(err).map((item) => item.trim()).filter(Boolean)))
  if (uniqueParts.length === 0) return undefined

  const detail = uniqueParts.join(' | ')
  return detail.length > 500 ? `${detail.slice(0, 497)}...` : detail
}

function extractDeepseekStatus(text: string): number | null {
  const match = text.match(/deepseek api\s+(\d{3})/i)
  return match ? Number(match[1]) : null
}

type ErrorArea =
  | '字幕翻译'
  | '语音合成'
  | '音频拼接'
  | '视频封装'
  | '字幕解析'
  | '视频分析'
  | '视频处理'
  | '处理过程'

function inferErrorArea(status: TaskStatus | undefined, haystack: string, rawMessage: string): ErrorArea {
  if (status === 'translating' || /deepseek|translation|chat\/completions/i.test(haystack)) {
    return '字幕翻译'
  }

  if (
    status === 'synthesizing' ||
    /tts|speech\.platform\.bing\.com|readaloud|websocket/i.test(haystack)
  ) {
    return '语音合成'
  }

  if (status === 'assembling') return '音频拼接'
  if (status === 'encoding') return '视频封装'
  if (status === 'parsing' || /subtitle|srt|ass|vtt/i.test(rawMessage)) return '字幕解析'
  if (/ffprobe/i.test(rawMessage)) return '视频分析'
  if (/ffmpeg/i.test(rawMessage)) return '视频处理'

  return '处理过程'
}

function formatTaskError(area: ErrorArea, reason: string, action?: string): string {
  return action ? `${area}：${reason}，${action}` : `${area}：${reason}`
}

function networkAreaName(area: ErrorArea): string {
  if (area === '字幕翻译') return '翻译服务'
  if (area === '语音合成') return '语音合成服务'
  return area
}

function normalizeTaskError(err: unknown, status?: TaskStatus): string {
  const signals = collectErrorText(err)
  const haystack = signals.join(' | ').toLowerCase()
  const rawMessage = signals.find((item) => item && !/^(aggregateerror|error)$/i.test(item)) || ''
  const deepseekStatus = extractDeepseekStatus(rawMessage)
  const area = inferErrorArea(status, haystack, rawMessage)
  const serviceName = networkAreaName(area)

  if (
    haystack.includes('etimedout') ||
    haystack.includes('timed out') ||
    /连接超时|超时/.test(rawMessage)
  ) {
    if (area === '字幕翻译' || area === '语音合成') {
      return formatTaskError(area, '连接超时', '请检查网络后重试')
    }
    if (area === '视频封装') {
      return formatTaskError(area, '处理超时', '请检查磁盘空间后重试')
    }
    return formatTaskError(area, '处理超时', '请重试')
  }

  if (
    haystack.includes('enotfound') ||
    haystack.includes('eai_again') ||
    haystack.includes('getaddrinfo')
  ) {
    if (area === '字幕翻译' || area === '语音合成') {
      return formatTaskError(area, `无法连接${serviceName}`, '请检查网络或 DNS')
    }
    return formatTaskError(area, '服务地址解析失败', '请检查网络或 DNS')
  }

  if (
    haystack.includes('econnrefused') ||
    haystack.includes('econnreset') ||
    haystack.includes('network error') ||
    haystack.includes('fetch failed') ||
    haystack.includes('socket hang up') ||
    haystack.includes('proxy')
  ) {
    if (area === '字幕翻译' || area === '语音合成') {
      return formatTaskError(area, `无法连接${serviceName}`, '请检查网络或代理')
    }
    return formatTaskError(area, '网络连接失败', '请检查网络或代理')
  }

  if (deepseekStatus === 401 || /invalid api key|unauthorized|authentication/i.test(rawMessage)) {
    return formatTaskError('字幕翻译', 'DeepSeek API Key 无效', '请检查配置')
  }

  if (deepseekStatus === 403 || /forbidden/i.test(rawMessage)) {
    return formatTaskError('字幕翻译', 'DeepSeek 请求被拒绝', '请检查权限或网络环境')
  }

  if (deepseekStatus === 429 || /too many requests|rate limit/i.test(rawMessage)) {
    return formatTaskError('字幕翻译', 'DeepSeek 请求过于频繁', '请稍后重试')
  }

  if (
    (deepseekStatus !== null && deepseekStatus >= 500) ||
    /bad gateway|service unavailable|gateway timeout/i.test(rawMessage)
  ) {
    const targetArea = area === '语音合成' ? '语音合成' : '字幕翻译'
    return formatTaskError(targetArea, '服务暂时不可用', '请稍后重试')
  }

  if (/未选择 TTS 声音/i.test(rawMessage)) {
    return formatTaskError('语音合成', '未选择 TTS 声音', '请先在配置面板中选择语音')
  }
  if (/未填写 DeepSeek API Key/i.test(rawMessage)) {
    return formatTaskError('字幕翻译', '未填写 DeepSeek API Key', '请先在配置面板中完成配置')
  }
  if (/未选择输出目录/i.test(rawMessage)) {
    return formatTaskError('视频封装', '未选择输出目录', '请先设置输出目录')
  }

  if (/字幕文件为空|字幕.*解析失败|subtitle/i.test(rawMessage)) {
    return formatTaskError('字幕解析', '字幕文件无效或解析失败', '请检查字幕格式')
  }

  if (/ffmpeg|ffprobe/i.test(rawMessage) && /enoent|not recognized|not found/i.test(rawMessage)) {
    return formatTaskError('视频处理', '未找到 FFmpeg/FFprobe', '请确认已安装并加入 PATH')
  }

  if (/ffprobe/i.test(rawMessage)) {
    return formatTaskError('视频分析', '分析失败', '请检查视频文件或 FFprobe')
  }

  if (/ffmpeg/i.test(rawMessage)) {
    if (area === '视频封装') {
      return formatTaskError('视频封装', '封装失败', '请检查视频文件或 FFmpeg')
    }
    return formatTaskError('视频处理', '处理失败', '请检查视频文件或 FFmpeg')
  }

  if (/tts|speech\.platform\.bing\.com|readaloud|websocket/i.test(haystack)) {
    return formatTaskError('语音合成', '连接失败', '请检查网络或代理')
  }

  if (/aborterror|aborted/i.test(haystack)) {
    return formatTaskError(area, '请求超时', '请稍后重试')
  }

  if (!rawMessage || /^aggregateerror$/i.test(rawMessage)) {
    return formatTaskError(area, '失败', '请查看日志')
  }

  return formatTaskError(area, rawMessage)
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
    setRuntimeConfig(config)
    currentConcurrentPipelineLimit = getConcurrentPipelineLimit(config)
    scheduler.setLimit(currentConcurrentPipelineLimit)
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
  if (scheduler.hasQueuedTask(taskId)) return
  const task = getTaskSnapshot(taskId)
  if (!task?.subtitlePath) return
  enqueueTask(
    {
      taskId,
      videoPath: task.videoPath,
      subtitlePath: task.subtitlePath,
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
  const queuedTaskIdsToPause = listQueuedTaskIds()
  const queuedResumeTaskIdsToPause = listQueuedResumeTaskIds()
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
  setRuntimeConfig(config)
  currentConcurrentPipelineLimit = getConcurrentPipelineLimit(config)
  scheduler.setLimit(currentConcurrentPipelineLimit)

  for (const taskId of taskIds) {
    if (typeof taskId !== 'string' || !taskId.trim()) continue
    resumeTask(taskId, config)
  }
}

export function updateConcurrentPipelineLimit(config?: AppConfig): void {
  if (config) setRuntimeConfig(config)
  currentConcurrentPipelineLimit = getConcurrentPipelineLimit(config)
  scheduler.setLimit(currentConcurrentPipelineLimit)
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
  let reservedOutput: ReservedOutputTarget | undefined

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
    const finalizedCueMap = new Map<number, Cue>(reviewedCues.map((cue) => [cue.id, { ...cue }]))

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
      const segmentCues = seg.cueIds
        .map((cueId) => finalizedCueMap.get(cueId))
        .filter((cue): cue is Cue => !!cue)
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

      let segmentOutputCues = segmentCues.map((cue) => ({ ...cue }))
      if (audio.spokenText !== text) {
        const spokenCueTexts = splitSegmentTextAcrossCues(audio.spokenText, segmentOutputCues)
        segmentOutputCues = segmentOutputCues.map((cue, index) => ({
          ...cue,
          text: spokenCueTexts[index] || '',
        }))
      }

      const retimedSegmentCues = retimeSegmentCues(seg, win, segmentOutputCues, audio)
      for (const cue of retimedSegmentCues) {
        finalizedCueMap.set(cue.id, cue)
      }

      reportProgress(taskId, 'synthesizing', synthProgress, segmentDetail)
    }

    const finalizedCues = englishCues.map((cue) => finalizedCueMap.get(cue.id) || cue)

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
    reservedOutput = reserveOutputTarget(
      videoPath,
      config.outputDir,
      config.createVideoSubfolder,
      config.subtitleOutputMode === 'external'
    )
    mkdirSync(reservedOutput.outputDir, { recursive: true })
    await checkPaused(taskId)
    checkCancelled(taskId)
    if (config.subtitleOutputMode === 'burned') {
      const assPath = join(tempDir, 'burned.ass')
      saveAssSubtitleFile(assPath, finalizedCues, config.subtitleStyle, {
        width: probeResult.displayWidth ?? probeResult.videoWidth ?? 1920,
        height: probeResult.displayHeight ?? probeResult.videoHeight ?? 1080,
      })
      await burnSubtitlesIntoVideo(videoPath, wavPath, assPath, reservedOutput.outputVideoPath)
    } else {
      await muxVideoWithAudio(videoPath, wavPath, reservedOutput.outputVideoPath)
    }
    checkCancelled(taskId)

    // Step 12: Save Chinese subtitle
    reportProgress(taskId, 'encoding', 95, '正在写出字幕和结果文件')
    if (config.subtitleOutputMode === 'external' && reservedOutput.outputSubtitlePath) {
      saveSubtitleFile(reservedOutput.outputSubtitlePath, finalizedCues)
    }
    await saveTaskCues(taskId, { englishCues, chineseCues: finalizedCues })
    sendToRenderer('task:cues-updated', taskId, englishCues, finalizedCues)

    // Done
    reportProgress(taskId, 'completed', 100, '处理完成')
  } catch (err: any) {
    if (err?.message === 'TASK_CANCELLED') {
      return
    }
    const failedStatus = activeTasks.get(taskId)?.currentStatus
    console.error(`Pipeline 失败 [${taskId}]:`, err)
    reportProgress(taskId, 'error', 0)
    const message = normalizeTaskError(err, failedStatus)
    const detail = extractTaskErrorDetail(err)
    reportTaskError(taskId, message, detail && detail !== message ? detail : undefined)
  } finally {
    reservedOutput?.release()
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
  setRuntimeConfig(config)
  currentConcurrentPipelineLimit = getConcurrentPipelineLimit(config)
  scheduler.setLimit(currentConcurrentPipelineLimit)

  for (let i = 0; i < taskIds.length; i++) {
    const taskId = taskIds[i]
    const task = tasks[i]
    if (activeTasks.has(taskId) || scheduler.hasQueuedTask(taskId)) continue
    if (configError) {
      reportProgress(taskId, 'error', 0)
      reportTaskError(taskId, configError)
      continue
    }
    if (!task?.subtitlePath) {
      reportProgress(taskId, 'error', 0)
      reportTaskError(taskId, '字幕解析：未关联字幕文件，请先选择字幕文件')
      continue
    }
    enqueueTask({
      taskId,
      videoPath: task.videoPath,
      subtitlePath: task.subtitlePath,
    })
  }
}
