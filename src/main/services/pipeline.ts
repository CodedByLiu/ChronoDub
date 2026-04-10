import type { AppConfig } from '../../types'
import { getRuntimeConfig } from '../runtime-config-store'
import {
  cancelAllTasks,
  cancelTask,
  pauseAllActiveTasks,
  pauseTask,
  resumeAllTasks,
  resumeTask,
  setPipelineRunner,
  startTasks,
  updateConcurrentPipelineLimit,
} from './pipeline-control'
import { runPipeline } from './pipeline-runner'
import { confirmReview, saveReviewCues } from './pipeline-review'
import { clearTaskTranslationRuntime } from './pipeline-translation-cache'

setPipelineRunner(runPipeline)

export { startTasks, pauseTask, pauseAllActiveTasks, resumeTask, resumeAllTasks }
export { cancelTask, cancelAllTasks, updateConcurrentPipelineLimit }
export { saveReviewCues, confirmReview, runPipeline }

export function clearTaskTranslationState(taskId: string, persistCache = true): void {
  clearTaskTranslationRuntime(taskId, persistCache)
}

export function retryFailedTranslations(taskId: string, config?: AppConfig): void {
  if (!taskId.trim()) return
  resumeTask(taskId, config ?? getRuntimeConfig())
}
