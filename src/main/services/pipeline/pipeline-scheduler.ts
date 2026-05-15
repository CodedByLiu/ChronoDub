import type { AppConfig } from '../../types'
import { getRuntimeConfig, setRuntimeConfig } from '../runtime-config-store'
import { reportProgress, reportTaskError, updateSleepBlocker } from './pipeline-progress'
import { activeTasks, lastWorkStatus } from './pipeline-store'
import { TaskScheduler, type ScheduledTaskEntry } from './task-scheduler'

let currentConcurrentPipelineLimit = 2
let pipelineRunner: ((taskId: string, videoPath: string, subtitlePath: string, config: AppConfig) => Promise<void>) | null =
  null

function cloneConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    llm: { ...config.llm },
    dictionary: config.dictionary.map((item) => ({ ...item })),
    subtitleStyle: { ...config.subtitleStyle },
  }
}

export function resolveQueuedTaskConfig(task: ScheduledTaskEntry): AppConfig {
  return cloneConfig(task.configSnapshot ?? getRuntimeConfig())
}

export function getRunnableActiveCount(): number {
  let count = 0
  for (const state of activeTasks.values()) {
    if (!state.cancelled && !state.paused) count++
  }
  return count
}

export function resumePausedTaskNow(taskId: string): boolean {
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
    if (!pipelineRunner) {
      reportProgress(task.taskId, 'error', 0)
      reportTaskError(task.taskId, '内部错误：pipeline runner 未初始化')
      return
    }
    const config = resolveQueuedTaskConfig(task)
    void pipelineRunner(task.taskId, task.videoPath, task.subtitlePath, config)
  },
  reportQueued: (taskId, progress) => {
    reportProgress(taskId, 'queued', progress)
  },
})

export function getConcurrentPipelineLimit(config?: AppConfig): number {
  const value = config?.maxConcurrentTasks
  if (value === 2 || value === 4 || value === 6 || value === 8) return value
  return 2
}

export function validateTaskConfig(config: AppConfig): string | null {
  if (!config.selectedVoice?.trim()) return '未选择 TTS 声音，请先在配置面板中选择语音'
  if (!config.llm?.baseUrl?.trim()) return '未填写 LLM Base URL，请先在配置面板中完成配置'
  if (!config.llm?.model?.trim()) return '未填写 LLM 模型名称，请先在配置面板中完成配置'
  if (!config.llm?.apiKey?.trim()) return '未填写 LLM API Key，请先在配置面板中完成配置'
  if (!config.outputDir?.trim()) return '未选择输出目录，请先设置输出目录'
  return null
}

export function setCurrentLimitFromConfig(config: AppConfig): void {
  setRuntimeConfig(config)
  currentConcurrentPipelineLimit = getConcurrentPipelineLimit(config)
  scheduler.setLimit(currentConcurrentPipelineLimit)
}

export function updateCurrentLimit(config?: AppConfig): void {
  if (config) setRuntimeConfig(config)
  currentConcurrentPipelineLimit = getConcurrentPipelineLimit(config)
  scheduler.setLimit(currentConcurrentPipelineLimit)
}

export function getCurrentLimit(): number {
  return currentConcurrentPipelineLimit
}

export function hasQueuedTask(taskId: string): boolean {
  return scheduler.hasQueuedTask(taskId)
}

export function enqueueTask(task: ScheduledTaskEntry, front = false): void {
  if (activeTasks.has(task.taskId) || scheduler.hasQueuedTask(task.taskId)) return
  scheduler.enqueueTask(
    task.configSnapshot
      ? {
          ...task,
          configSnapshot: cloneConfig(task.configSnapshot),
        }
      : task,
    front
  )
}

export function enqueuePausedTaskForResume(taskId: string): void {
  if (!activeTasks.has(taskId)) return
  const last = lastWorkStatus.get(taskId)
  scheduler.enqueueResume(taskId, last?.progress ?? 0)
}

export function startNextQueuedTasks(): void {
  scheduler.process()
}

export function removeQueuedTask(taskId: string): boolean {
  return scheduler.removeQueuedTask(taskId)
}

export function removeQueuedResumeTask(taskId: string): boolean {
  return scheduler.removeQueuedResume(taskId)
}

export function listQueuedTaskIds(): string[] {
  return scheduler.listQueuedTaskIds()
}

export function listQueuedResumeTaskIds(): string[] {
  return scheduler.listQueuedResumeTaskIds()
}

export function setPipelineRunner(
  runner: (taskId: string, videoPath: string, subtitlePath: string, config: AppConfig) => Promise<void>
): void {
  pipelineRunner = runner
}
