import type { AppConfig, Cue } from '../../../types'
import { saveTaskCues } from '../../task-cue-store'
import { clearReviewCountdown, runReviewSession } from '../review-session'
import { getTaskState } from './pipeline-control'
import { reportProgress, reportReviewCountdown, sendToRenderer } from './pipeline-progress'
import { activeTasks } from './pipeline-store'

function hasCjkChars(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text)
}

export function shouldApplySpokenTextRewrite(originalText: string, spokenText: string): boolean {
  const original = originalText.trim()
  const spoken = spokenText.trim()
  if (!spoken || spoken === original) return false

  const originalHasCjk = hasCjkChars(original)
  const spokenHasCjk = hasCjkChars(spoken)
  if (originalHasCjk && !spokenHasCjk) return false

  return true
}

export async function reviewCheckpoint(
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
