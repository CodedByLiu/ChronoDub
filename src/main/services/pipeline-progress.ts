import { BrowserWindow, powerSaveBlocker } from 'electron'
import type { TaskStatus } from '../../types'
import {
  activeTasks,
  BLOCK_SLEEP_STATUSES,
  LAST_WORK_STATUSES,
  lastWorkStatus,
} from './pipeline-store'
import {
  updateTaskCountdownSnapshot,
  updateTaskErrorSnapshot,
  updateTaskStatusSnapshot,
} from '../task-registry'

let sleepBlockerId: number | null = null

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, ...args)
  })
}

export function updateSleepBlocker(): void {
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

export function reportProgress(
  taskId: string,
  status: TaskStatus,
  progress: number,
  detail?: string
): void {
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

export function reportReviewCountdown(taskId: string, remaining: number): void {
  updateTaskCountdownSnapshot(taskId, remaining)
  sendToRenderer('task:review-countdown', taskId, remaining)
}

export function reportTaskError(taskId: string, message: string, detail?: string): void {
  updateTaskErrorSnapshot(taskId, message, detail)
  sendToRenderer('task:error', taskId, message, detail)
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
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
