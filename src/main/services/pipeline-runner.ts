import type { AppConfig } from '../../types'
import { extractTaskErrorDetail, normalizeTaskError } from './pipeline-error'
import {
  checkCancelled,
  cleanupTask,
  getTaskState,
  startNextQueuedTasks,
  validateTaskConfig,
} from './pipeline-control'
import { activeTasks, lastWorkStatus } from './pipeline-store'
import { reportProgress, reportTaskError } from './pipeline-progress'
import { hydrateTaskTranslationCache } from './pipeline-translation-cache'
import { runTranslationStage } from './pipeline-stage-translation'
import { runSynthesisStage } from './pipeline-stage-synthesis'
import { runOutputStage } from './pipeline-stage-output'

export async function runPipeline(
  taskId: string,
  videoPath: string,
  subtitlePath: string,
  config: AppConfig
): Promise<void> {
  getTaskState(taskId)

  try {
    const configError = validateTaskConfig(config)
    if (configError) throw new Error(configError)
    hydrateTaskTranslationCache(taskId, config.outputDir, videoPath)

    const translation = await runTranslationStage({
      taskId,
      videoPath,
      subtitlePath,
      config,
    })
    checkCancelled(taskId)

    const synthesis = await runSynthesisStage({
      taskId,
      videoPath,
      config,
      translation,
    })
    checkCancelled(taskId)

    await runOutputStage({
      taskId,
      videoPath,
      config,
      probeResult: translation.probeResult,
      englishCues: translation.englishCues,
      finalizedCues: synthesis.finalizedCues,
      segments: translation.segments,
      assemblerSegments: synthesis.assemblerSegments,
    })
  } catch (err: any) {
    if (err?.message === 'TASK_CANCELLED') {
      return
    }
    const failedStatus = activeTasks.get(taskId)?.currentStatus
    console.error(`Pipeline failed [${taskId}]:`, err)
    reportProgress(taskId, 'error', 0)
    const message = normalizeTaskError(err, failedStatus)
    const detail = extractTaskErrorDetail(err)
    reportTaskError(taskId, message, detail && detail !== message ? detail : undefined)
  } finally {
    cleanupTask(taskId)
    lastWorkStatus.delete(taskId)
    startNextQueuedTasks()
  }
}
