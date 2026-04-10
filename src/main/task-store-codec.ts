import type { TaskStatus, VideoTask } from '../types'

export interface TaskSnapshotFile {
  version: 1
  tasks: VideoTask[]
}

const TASK_STATUSES: TaskStatus[] = [
  'waiting',
  'queued',
  'parsing',
  'translating',
  'reviewing',
  'synthesizing',
  'assembling',
  'encoding',
  'completed',
  'error',
  'paused',
]

const TASK_STATUS_SET = new Set<TaskStatus>(TASK_STATUSES)

export function sanitizeTaskSnapshot(task: VideoTask): VideoTask {
  const {
    id,
    videoPath,
    videoName,
    subtitlePath,
    status,
    progress,
    detail,
    countdownRemaining,
    error,
    errorDetail,
    translationIssues,
  } = task

  return {
    id,
    videoPath,
    videoName,
    subtitlePath,
    status,
    progress,
    ...(detail ? { detail } : {}),
    ...(countdownRemaining !== undefined ? { countdownRemaining } : {}),
    ...(error ? { error } : {}),
    ...(errorDetail ? { errorDetail } : {}),
    ...(translationIssues && translationIssues.length > 0
      ? {
          translationIssues: translationIssues.map((item) => ({
            id: item.id,
            text: item.text,
            ...(typeof item.max_chars === 'number' ? { max_chars: item.max_chars } : {}),
          })),
        }
      : {}),
  }
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUS_SET.has(value as TaskStatus)
}

function parseTranslationIssues(
  raw: unknown
): Array<{ id: number; text: string; max_chars?: number }> | undefined {
  if (!Array.isArray(raw)) return undefined
  const issues: Array<{ id: number; text: string; max_chars?: number }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const issue = item as { id?: unknown; text?: unknown; max_chars?: unknown }
    if (typeof issue.id !== 'number' || !Number.isFinite(issue.id)) continue
    if (typeof issue.text !== 'string') continue
    issues.push({
      id: issue.id,
      text: issue.text,
      ...(typeof issue.max_chars === 'number' && Number.isFinite(issue.max_chars)
        ? { max_chars: issue.max_chars }
        : {}),
    })
  }
  return issues.length > 0 ? issues : undefined
}

function normalizeTaskSnapshot(raw: unknown): VideoTask | null {
  if (!raw || typeof raw !== 'object') return null
  const task = raw as Partial<VideoTask>

  if (typeof task.id !== 'string' || task.id.length === 0) return null
  if (typeof task.videoPath !== 'string' || task.videoPath.length === 0) return null
  if (typeof task.videoName !== 'string' || task.videoName.length === 0) return null
  if (task.subtitlePath !== null && typeof task.subtitlePath !== 'string') return null
  if (!isTaskStatus(task.status)) return null
  if (typeof task.progress !== 'number' || !Number.isFinite(task.progress)) return null
  const translationIssues = parseTranslationIssues(task.translationIssues)

  return sanitizeTaskSnapshot({
    id: task.id,
    videoPath: task.videoPath,
    videoName: task.videoName,
    subtitlePath: task.subtitlePath,
    status: task.status,
    progress: task.progress,
    ...(typeof task.detail === 'string' ? { detail: task.detail } : {}),
    ...(typeof task.countdownRemaining === 'number' && Number.isFinite(task.countdownRemaining)
      ? { countdownRemaining: task.countdownRemaining }
      : {}),
    ...(typeof task.error === 'string' ? { error: task.error } : {}),
    ...(typeof task.errorDetail === 'string' ? { errorDetail: task.errorDetail } : {}),
    ...(translationIssues ? { translationIssues } : {}),
  })
}

export function parseTaskSnapshotFile(raw: string): VideoTask[] {
  const parsed = JSON.parse(raw) as TaskSnapshotFile
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tasks)) return []

  const tasks: VideoTask[] = []
  for (const item of parsed.tasks) {
    const normalized = normalizeTaskSnapshot(item)
    if (normalized) tasks.push(normalized)
  }
  return tasks
}
