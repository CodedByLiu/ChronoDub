import type { AppConfig, TaskStatus } from '../../../types'
import { getRuntimeConfig } from '../../runtime-config-store'
import { deleteTaskCues } from '../../task-cue-store'
import { getTaskSnapshot } from '../../task-registry'
import { clearReviewCountdown } from '../review-session'
import { reportProgress, reportTaskError, updateSleepBlocker } from './pipeline-progress'
import {
  clearTaskSegmentCacheOnDisk,
  clearTaskTranslationRuntime,
} from './pipeline-translation-cache'
import { activeTasks, lastWorkStatus, type TaskState } from './pipeline-store'
import {
  enqueuePausedTaskForResume,
  enqueueTask,
  getConcurrentPipelineLimit,
  getCurrentLimit,
  getRunnableActiveCount,
  hasQueuedTask,
  listQueuedResumeTaskIds,
  listQueuedTaskIds,
  removeQueuedResumeTask,
  removeQueuedTask,
  resumePausedTaskNow,
  setCurrentLimitFromConfig,
  setPipelineRunner,
  startNextQueuedTasks,
  updateCurrentLimit,
  validateTaskConfig,
} from './pipeline-scheduler'

export { getConcurrentPipelineLimit, setPipelineRunner, startNextQueuedTasks, validateTaskConfig }

export function getTaskState(taskId: string): TaskState {
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

function clearTaskSegmentCacheFromRegistry(taskId: string): void {
  const snapshot = getTaskSnapshot(taskId)
  const videoPath = snapshot?.videoPath
  if (!videoPath) return
  const outputDir = getRuntimeConfig().outputDir
  if (!outputDir) return
  clearTaskSegmentCacheOnDisk(outputDir, videoPath)
}

export function cleanupTask(taskId: string): void {
  const state = activeTasks.get(taskId)
  if (state) clearReviewCountdown(state)
  if (state?.cancelled) {
    void deleteTaskCues(taskId)
    clearTaskTranslationRuntime(taskId)
    clearTaskSegmentCacheFromRegistry(taskId)
  }
  activeTasks.delete(taskId)
  removeQueuedResumeTask(taskId)
  updateSleepBlocker()
}

export function checkCancelled(taskId: string): void {
  const state = activeTasks.get(taskId)
  if (state?.cancelled) throw new Error('TASK_CANCELLED')
}

export function isCancelled(taskId: string): boolean {
  return activeTasks.get(taskId)?.cancelled === true
}

export async function checkPaused(taskId: string): Promise<void> {
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
    setCurrentLimitFromConfig(config)
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

    if (getRunnableActiveCount() < getCurrentLimit()) {
      resumePausedTaskNow(taskId)
    } else {
      enqueuePausedTaskForResume(taskId)
    }
    return
  }

  if (!config || hasQueuedTask(taskId)) return
  const task = getTaskSnapshot(taskId)
  if (!task?.subtitlePath) return
  enqueueTask(
    {
      taskId,
      videoPath: task.videoPath,
      subtitlePath: task.subtitlePath,
      configSnapshot: config,
    },
    true
  )
}

export function cancelTask(taskId: string): void {
  if (removeQueuedTask(taskId)) {
    void deleteTaskCues(taskId)
    clearTaskTranslationRuntime(taskId)
    clearTaskSegmentCacheFromRegistry(taskId)
    return
  }
  removeQueuedResumeTask(taskId)

  const state = activeTasks.get(taskId)
  if (!state) {
    void deleteTaskCues(taskId)
    clearTaskTranslationRuntime(taskId)
    clearTaskSegmentCacheFromRegistry(taskId)
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

export function cancelAllTasks(taskIds: string[]): void {
  for (const id of taskIds) {
    cancelTask(id)
  }
}

export function pauseAllActiveTasks(): void {
  for (const taskId of listQueuedTaskIds()) {
    pauseQueuedTask(taskId)
  }
  for (const taskId of listQueuedResumeTaskIds()) {
    pauseQueuedTask(taskId)
  }
  for (const [taskId, state] of activeTasks) {
    if (state.cancelled || state.paused || state.pauseRequested) continue
    pauseTaskInternal(taskId, false)
  }
}

export function resumeAllTasks(taskIds: string[], config?: AppConfig): void {
  if (!Array.isArray(taskIds) || taskIds.length === 0 || !config) return
  setCurrentLimitFromConfig(config)

  for (const taskId of taskIds) {
    if (typeof taskId !== 'string' || !taskId.trim()) continue
    resumeTask(taskId, config)
  }
}

export function updateConcurrentPipelineLimit(config?: AppConfig): void {
  updateCurrentLimit(config)
  startNextQueuedTasks()
}

export function startTasks(
  taskIds: string[],
  tasks: Array<{ videoPath: string; subtitlePath: string | null }>,
  config: AppConfig
): void {
  const configError = validateTaskConfig(config)
  setCurrentLimitFromConfig(config)

  for (let i = 0; i < taskIds.length; i++) {
    const taskId = taskIds[i]
    const task = tasks[i]
    if (activeTasks.has(taskId) || hasQueuedTask(taskId)) continue
    if (configError) {
      reportProgress(taskId, 'error', 0)
      reportTaskError(taskId, configError)
      continue
    }
    if (!task?.subtitlePath) {
      reportProgress(taskId, 'error', 0)
      reportTaskError(taskId, '字幕解析失败：未关联字幕文件，请先选择字幕文件')
      continue
    }
    enqueueTask({
      taskId,
      videoPath: task.videoPath,
      subtitlePath: task.subtitlePath,
      configSnapshot: config,
    })
  }
}
