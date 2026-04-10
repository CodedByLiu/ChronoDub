import { app } from 'electron'
import { dirname, join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import type { VideoTask } from '../types'
import { parseTaskSnapshotFile, sanitizeTaskSnapshot, type TaskSnapshotFile } from './task-store-codec'

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

export function loadTaskSnapshotsSync(): VideoTask[] {
  try {
    const filePath = getTaskStorePath()
    if (!existsSync(filePath)) return []
    return parseTaskSnapshotFile(readFileSync(filePath, 'utf-8'))
  } catch {
    return []
  }
}

export async function saveTaskSnapshots(tasks: VideoTask[]): Promise<void> {
  try {
    const filePath = getTaskStorePath()
    await mkdir(dirname(filePath), { recursive: true })
    const payload: TaskSnapshotFile = {
      version: 1,
      tasks: tasks.map(sanitizeTaskSnapshot),
    }
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
  } catch (err) {
    console.error('Failed to save task snapshots:', err)
  }
}

export function normalizeInterruptedTasks(tasks: VideoTask[]): VideoTask[] {
  return tasks.map((task) => {
    if (task.status === 'queued') {
      return {
        ...task,
        status: 'waiting',
        progress: 0,
        countdownRemaining: undefined,
      }
    }
    if (!IN_FLIGHT_STATUSES.has(task.status)) return task
    return {
      ...task,
      status: 'paused',
      countdownRemaining: undefined,
    }
  })
}
