import { app } from 'electron'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import type { VideoTask } from '../types'

interface TaskSnapshotFile {
  version: 1
  tasks: VideoTask[]
}

const IN_FLIGHT_STATUSES = new Set([
  'parsing',
  'translating',
  'reviewing',
  'synthesizing',
  'assembling',
  'encoding',
])

function getTaskStorePath(): string {
  return join(app.getPath('userData'), 'tasks.json')
}

function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function loadTaskSnapshots(): VideoTask[] {
  try {
    const filePath = getTaskStorePath()
    if (!existsSync(filePath)) return []
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as TaskSnapshotFile
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tasks)) return []
    return parsed.tasks
  } catch {
    return []
  }
}

export function saveTaskSnapshots(tasks: VideoTask[]): void {
  try {
    const filePath = getTaskStorePath()
    ensureParentDir(filePath)
    const payload: TaskSnapshotFile = {
      version: 1,
      tasks,
    }
    writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
  } catch (err) {
    console.error('Failed to save task snapshots:', err)
  }
}

export function normalizeInterruptedTasks(tasks: VideoTask[]): VideoTask[] {
  return tasks.map((task) => {
    if (!IN_FLIGHT_STATUSES.has(task.status)) return task
    return {
      ...task,
      status: 'paused',
      countdownRemaining: undefined,
    }
  })
}
