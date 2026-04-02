import type { TaskStatus, VideoTask } from '../types'
import { loadTaskSnapshotsSync, normalizeInterruptedTasks, saveTaskSnapshots } from './task-store'

const TASK_SAVE_DEBOUNCE_MS = 300

let initialized = false
const taskMap = new Map<string, VideoTask>()
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveChain: Promise<void> = Promise.resolve()

function cloneTask(task: VideoTask): VideoTask {
  return {
    ...task,
    ...(task.detail ? { detail: task.detail } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.countdownRemaining !== undefined ? { countdownRemaining: task.countdownRemaining } : {}),
  }
}

function isSameTaskSnapshot(a: VideoTask | undefined, b: VideoTask): boolean {
  return (
    !!a &&
    a.id === b.id &&
    a.videoPath === b.videoPath &&
    a.videoName === b.videoName &&
    a.subtitlePath === b.subtitlePath &&
    a.status === b.status &&
    a.progress === b.progress &&
    a.detail === b.detail &&
    a.countdownRemaining === b.countdownRemaining &&
    a.error === b.error
  )
}

function ensureInitialized(): void {
  if (initialized) return
  const tasks = normalizeInterruptedTasks(loadTaskSnapshotsSync())
  taskMap.clear()
  for (const task of tasks) {
    taskMap.set(task.id, cloneTask(task))
  }
  initialized = true
}

function schedulePersist(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const snapshot = getTaskSnapshots()
    saveChain = saveChain.then(() => saveTaskSnapshots(snapshot)).catch((err) => {
      console.error('Failed to persist task registry:', err)
    })
  }, TASK_SAVE_DEBOUNCE_MS)
}

export function getTaskSnapshots(): VideoTask[] {
  ensureInitialized()
  return Array.from(taskMap.values()).map(cloneTask)
}

export function getTaskSnapshot(taskId: string): VideoTask | undefined {
  ensureInitialized()
  const task = taskMap.get(taskId)
  return task ? cloneTask(task) : undefined
}

export function registerTasks(tasks: VideoTask[]): void {
  ensureInitialized()
  let changed = false
  for (const task of tasks) {
    const sanitized = cloneTask(task)
    const current = taskMap.get(task.id)
    if (isSameTaskSnapshot(current, sanitized)) continue
    taskMap.set(task.id, sanitized)
    changed = true
  }
  if (changed) schedulePersist()
}

export function updateTaskSnapshot(
  taskId: string,
  update: Partial<VideoTask> | ((task: VideoTask) => VideoTask)
): void {
  ensureInitialized()
  const current = taskMap.get(taskId)
  if (!current) return

  const next =
    typeof update === 'function'
      ? cloneTask(update(cloneTask(current)))
      : cloneTask({ ...current, ...update })

  taskMap.set(taskId, next)
  schedulePersist()
}

export function updateTaskStatusSnapshot(
  taskId: string,
  status: TaskStatus,
  progress: number,
  detail?: string
): void {
  updateTaskSnapshot(taskId, (task) => ({
    ...task,
    status,
    progress,
    ...(detail !== undefined ? { detail } : { detail: undefined }),
    ...(status !== 'reviewing' && status !== 'paused' ? { countdownRemaining: undefined } : {}),
  }))
}

export function updateTaskErrorSnapshot(taskId: string, message: string): void {
  updateTaskSnapshot(taskId, (task) => ({
    ...task,
    status: 'error',
    progress: 0,
    error: message,
    detail: undefined,
    countdownRemaining: undefined,
  }))
}

export function updateTaskCountdownSnapshot(taskId: string, remaining: number): void {
  updateTaskSnapshot(taskId, { countdownRemaining: remaining })
}

export function updateTaskSubtitlePathSnapshot(taskId: string, subtitlePath: string): void {
  updateTaskSnapshot(taskId, { subtitlePath })
}

export function replaceTaskSubtitlePathSnapshot(taskId: string, subtitlePath: string): void {
  updateTaskSnapshot(taskId, (task) => ({
    ...task,
    subtitlePath,
    status: 'waiting',
    progress: 0,
    detail: undefined,
    error: undefined,
    countdownRemaining: undefined,
  }))
}

export function removeTaskSnapshot(taskId: string): void {
  ensureInitialized()
  if (!taskMap.delete(taskId)) return
  schedulePersist()
}

export function removeTaskSnapshots(taskIds: string[]): void {
  ensureInitialized()
  let changed = false
  for (const taskId of taskIds) {
    if (taskMap.delete(taskId)) changed = true
  }
  if (changed) schedulePersist()
}

export function normalizeInterruptedTaskSnapshots(): VideoTask[] {
  ensureInitialized()
  const normalized = normalizeInterruptedTasks(getTaskSnapshots())
  taskMap.clear()
  for (const task of normalized) {
    taskMap.set(task.id, cloneTask(task))
  }
  schedulePersist()
  return normalized
}
