import type { AppConfig, Cue, TaskStatus } from '../../types'

export interface ReviewSessionState {
  paused: boolean
  chineseCues: Cue[]
  countdownTimer: ReturnType<typeof setInterval> | null
  countdownRemaining: number | null
  reviewResolver: ((cues: Cue[]) => void) | null
  reviewRejecter: ((err: Error) => void) | null
}

interface ReviewSessionCallbacks {
  persistCues: (data: { englishCues?: Cue[]; chineseCues?: Cue[] }) => Promise<void>
  onReady: (englishCues: Cue[], chineseCues: Cue[]) => void
  onProgress: (status: TaskStatus, progress: number) => void
  onCountdown: (remaining: number) => void
}

export async function runReviewSession(
  taskId: string,
  state: ReviewSessionState,
  englishCues: Cue[],
  chineseCues: Cue[],
  config: AppConfig,
  callbacks: ReviewSessionCallbacks
): Promise<Cue[]> {
  state.chineseCues = [...chineseCues]
  await callbacks.persistCues({ englishCues, chineseCues })

  callbacks.onReady(englishCues, chineseCues)
  callbacks.onProgress('reviewing', 50)

  if (config.reviewMode === 'auto') {
    return autoReview(taskId, state, config.autoReviewCountdown, callbacks.onCountdown)
  }
  return manualReview(state)
}

export function clearReviewCountdown(state: ReviewSessionState): void {
  if (state.countdownTimer) {
    clearInterval(state.countdownTimer)
    state.countdownTimer = null
  }
  state.countdownRemaining = null
}

function autoReview(
  taskId: string,
  state: ReviewSessionState,
  countdownSec: number,
  onCountdown: (remaining: number) => void
): Promise<Cue[]> {
  return new Promise((resolve, reject) => {
    state.reviewResolver = resolve
    state.reviewRejecter = reject
    state.countdownRemaining = countdownSec
    onCountdown(countdownSec)

    state.countdownTimer = setInterval(() => {
      if (state.paused) return

      const nextRemaining = Math.max(0, (state.countdownRemaining ?? 0) - 1)
      state.countdownRemaining = nextRemaining
      onCountdown(nextRemaining)

      if (nextRemaining > 0) return

      clearReviewCountdown(state)
      state.reviewResolver = null
      state.reviewRejecter = null
      resolve(state.chineseCues)
    }, 1000)
  })
}

function manualReview(state: ReviewSessionState): Promise<Cue[]> {
  return new Promise((resolve, reject) => {
    state.reviewResolver = resolve
    state.reviewRejecter = reject
  })
}
