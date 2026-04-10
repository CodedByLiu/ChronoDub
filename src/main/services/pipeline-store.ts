import type { TaskStatus } from '../../types'
import type { TranslationIssueItem } from './deepseek'
import type { ReviewSessionState } from './review-session'

export interface TaskState extends ReviewSessionState {
  cancelled: boolean
  pauseRequested: boolean
  currentStatus: TaskStatus
  pauseResolver: (() => void) | null
}

export interface TaskTranslationCacheEntry {
  configSignature: string
  translations: Map<number, string>
}

export const activeTasks = new Map<string, TaskState>()
export const taskSegmentTranslationCache = new Map<string, TaskTranslationCacheEntry>()
export const taskTranslationIssues = new Map<string, TranslationIssueItem[]>()
export const lastWorkStatus = new Map<string, { status: TaskStatus; progress: number; detail?: string }>()

export const BLOCK_SLEEP_STATUSES = new Set<TaskStatus>([
  'parsing',
  'translating',
  'synthesizing',
  'assembling',
  'encoding',
])

export const LAST_WORK_STATUSES = new Set<TaskStatus>([
  'parsing',
  'translating',
  'reviewing',
  'synthesizing',
  'assembling',
  'encoding',
])

export const SYNTHESIS_SEGMENT_TIMEOUT_MS = 180_000
