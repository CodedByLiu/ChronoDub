import type { TaskStatus } from '../../types'

export const TASK_ROW_HEIGHT = 88
export const TASK_ROW_OVERSCAN = 8
export const GRID_COLUMNS = 'minmax(0,30fr) minmax(0,25fr) minmax(0,15fr) minmax(0,30fr)'

export const ELAPSED_STATUSES = new Set<TaskStatus>([
  'parsing',
  'translating',
  'synthesizing',
  'assembling',
  'encoding',
])

export const STATUS_COLORS: Record<TaskStatus, string> = {
  waiting: 'bg-muted text-muted-foreground',
  queued: 'bg-slate-500/15 text-slate-200/90',
  parsing: 'bg-muted text-foreground',
  translating: 'bg-primary/20 text-[#c9c0f5]',
  reviewing: 'bg-amber-500/15 text-amber-200/95',
  synthesizing: 'bg-primary/12 text-muted-foreground',
  assembling: 'bg-sky-500/12 text-sky-200/90',
  encoding: 'bg-violet-500/12 text-violet-200/90',
  completed: 'bg-emerald-500/15 text-emerald-200/95',
  error: 'bg-red-500/15 text-red-300/95',
  paused: 'bg-amber-500/10 text-amber-200/80',
}

export const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  'queued',
  'parsing',
  'translating',
  'synthesizing',
  'assembling',
  'encoding',
])

export const SUBTITLE_EDITABLE_STATUSES = new Set<TaskStatus>(['waiting', 'paused', 'error', 'completed'])
