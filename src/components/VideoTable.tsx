import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Eye, FileVideo, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import type { ReviewMode, TaskStatus, VideoTask } from '../types'
import { TASK_STATUS_META } from '../types'
import { useAppStore } from '../stores/app-store'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const TASK_ROW_HEIGHT = 88
const TASK_ROW_OVERSCAN = 8
const GRID_COLUMNS = 'minmax(0,30fr) minmax(0,25fr) minmax(0,15fr) minmax(0,30fr)'
const ELAPSED_STATUSES = new Set<TaskStatus>(['parsing', 'translating', 'synthesizing', 'assembling', 'encoding'])

function videoDir(videoPath: string): string {
  const i = Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\'))
  return i >= 0 ? videoPath.slice(0, i) : ''
}

function pathFromFileUriInDrag(e: React.DragEvent): string {
  const raw = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
  const line = raw?.trim().split('\n')[0]?.trim()
  if (!line?.toLowerCase().startsWith('file:')) return ''

  try {
    const url = new URL(line.split('#')[0])
    let p = decodeURIComponent(url.pathname.replace(/\+/g, '%20'))
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    return p
  } catch {
    return ''
  }
}

const STATUS_COLORS: Record<TaskStatus, string> = {
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

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  'queued',
  'parsing',
  'translating',
  'synthesizing',
  'assembling',
  'encoding',
])
const SUBTITLE_EDITABLE_STATUSES = new Set<TaskStatus>(['waiting', 'paused', 'error', 'completed'])

interface VideoTaskRowProps {
  task: VideoTask
  reviewMode: ReviewMode
  nowMs: number
  onDragOver: (e: React.DragEvent) => void
  onDrop: (taskId: string, e: React.DragEvent) => void
  onPickSubtitle: (task: VideoTask) => Promise<void>
  onOpenEditor: (taskId: string) => void
  onRemoveTask: (taskId: string) => void
}

const VideoTaskRow = memo(function VideoTaskRow({
  task,
  reviewMode,
  nowMs,
  onDragOver,
  onDrop,
  onPickSubtitle,
  onOpenEditor,
  onRemoveTask,
}: VideoTaskRowProps) {
  const subtitleEditable = SUBTITLE_EDITABLE_STATUSES.has(task.status)
  const showElapsed = ELAPSED_STATUSES.has(task.status) && !!task.statusUpdatedAt
  const elapsedSeconds = showElapsed
    ? Math.max(0, Math.floor((nowMs - (task.statusUpdatedAt || nowMs)) / 1000))
    : 0

  const renderActions = () => {
    const buttons: React.ReactNode[] = []

    if (task.status === 'reviewing') {
      const isAuto = reviewMode === 'auto'
      const countdownActive = isAuto && (task.countdownRemaining ?? 0) > 0
      const editable = isAuto ? countdownActive : true

      buttons.push(
        <Button key="edit" variant="outline" size="xs" onClick={() => onOpenEditor(task.id)}>
          {editable ? (
            <>
              <Pencil className="size-3" />
              编辑
            </>
          ) : (
            <>
              <Eye className="size-3" />
              查看
            </>
          )}
          {isAuto && task.countdownRemaining !== undefined && countdownActive && (
            <span className="ml-1 tabular-nums text-amber-400/95">{task.countdownRemaining}s</span>
          )}
        </Button>
      )
    } else if (task.status === 'completed') {
      buttons.push(
        <Button key="view" variant="outline" size="xs" onClick={() => onOpenEditor(task.id)}>
          <Eye className="size-3" />
          查看
        </Button>
      )
    }

    if (ACTIVE_TASK_STATUSES.has(task.status)) {
      buttons.push(
        <Button key="pause" variant="outline" size="xs" onClick={() => window.api?.task.pause(task.id)}>
          <Pause className="size-3" />
          暂停
        </Button>
      )
    } else if (task.status === 'paused') {
      buttons.push(
        <Button
          key="resume"
          variant="outline"
          size="xs"
          onClick={() => window.api?.task.resume(task.id)}
        >
          <Play className="size-3" />
          继续
        </Button>
      )
    }

    buttons.push(
      <Button
        key="delete"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground hover:text-destructive"
        onClick={() => onRemoveTask(task.id)}
      >
        <Trash2 className="size-3" />
      </Button>
    )

    return <div className="flex items-center gap-1">{buttons}</div>
  }

  return (
    <div
      className="grid items-center gap-0 border-b border-border px-[15px]"
      style={{ gridTemplateColumns: GRID_COLUMNS, height: TASK_ROW_HEIGHT }}
    >
      <div className="min-w-0 pr-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block truncate cursor-default">{task.videoName}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[400px] break-all">
            {task.videoPath}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="min-w-0 pr-4">
        <div
          role="button"
          tabIndex={0}
          className={`flex min-h-[2.25rem] cursor-pointer items-center justify-start rounded-md border border-border bg-input-bg px-3 py-1.5 text-left text-sm transition-colors select-none hover:border-primary/45 hover:bg-muted/40 ${
            task.subtitlePath
              ? 'text-foreground'
              : 'border-dashed border-muted-foreground/35 text-muted-foreground'
          } ${subtitleEditable ? '' : 'cursor-not-allowed opacity-70 hover:border-border hover:bg-input-bg'}`}
          onDragOver={onDragOver}
          onDrop={(e) => {
            if (!subtitleEditable) {
              e.preventDefault()
              e.stopPropagation()
              return
            }
            onDrop(task.id, e)
          }}
          onClick={() => {
            if (!subtitleEditable) return
            void onPickSubtitle(task)
          }}
          onKeyDown={(e) => {
            if (!subtitleEditable) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              void onPickSubtitle(task)
            }
          }}
        >
          {task.subtitlePath ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block truncate cursor-default">
                  {task.subtitlePath.split(/[\\/]/).pop()}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[400px] break-all">
                {task.subtitlePath}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span>点击选择或拖拽字幕</span>
          )}
        </div>
      </div>

      <div className="min-w-0 pr-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`${STATUS_COLORS[task.status]} border-border`}>
              {TASK_STATUS_META[task.status].label}
            </Badge>
            {task.progress > 0 && task.status !== 'completed' && task.status !== 'error' && (
              <span className="text-xs tabular-nums text-muted-foreground">{task.progress}%</span>
            )}
          </div>

          {task.progress > 0 && task.status !== 'waiting' && task.status !== 'queued' && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  task.status === 'completed'
                    ? 'bg-emerald-500/85'
                    : task.status === 'error'
                      ? 'bg-red-400/90'
                      : 'bg-primary'
                }`}
                style={{ width: `${task.progress}%` }}
              />
            </div>
          )}

          {task.error &&
            (task.errorDetail && task.errorDetail !== task.error ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <p className="truncate cursor-help text-xs text-red-400">{task.error}</p>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[520px] whitespace-pre-wrap break-all">
                  <p className="text-xs text-red-300">{task.error}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{task.errorDetail}</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <p className="truncate text-xs text-red-400" title={task.error}>
                {task.error}
              </p>
            ))}

          {!task.error && task.detail && (
            <p className="truncate text-xs text-muted-foreground" title={task.detail}>
              {task.detail}
            </p>
          )}

          {!task.error && showElapsed && (
            <p className="text-xs tabular-nums text-muted-foreground/80">已耗时 {elapsedSeconds}s</p>
          )}
        </div>
      </div>

      <div className="min-w-0">{renderActions()}</div>
    </div>
  )
})

export function VideoTable() {
  const { tasks, config, removeTask, setEditingTaskId } = useAppStore()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const resolveDroppedFilePath = useCallback(
    (e: React.DragEvent, file: File): string | undefined => {
      const fromUri = pathFromFileUriInDrag(e)
      if (fromUri && /\.(srt|vtt|ass)$/i.test(fromUri)) return fromUri

      try {
        const fn = window.api?.filePathFromDragFile ?? window.api?.subtitle?.pathFromFile
        if (fn) return fn(file)
      } catch {
        // webUtils may reject some drag sources.
      }

      const legacy = (file as unknown as { path?: string }).path
      return typeof legacy === 'string' ? legacy : undefined
    },
    []
  )

  const handleDrop = useCallback(
    (taskId: string, e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const file = e.dataTransfer.files[0]
      if (!file) return

      const ext = file.name.split('.').pop()?.toLowerCase()
      if (!['srt', 'vtt', 'ass'].includes(ext || '')) return

      const filePath = resolveDroppedFilePath(e, file)
      if (filePath) {
        useAppStore.getState().replaceTaskSubtitlePath(taskId, filePath)
        window.api?.task.replaceSubtitlePath(taskId, filePath)
      }
    },
    [resolveDroppedFilePath]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handlePickSubtitle = useCallback(
    async (task: VideoTask) => {
      const dir = videoDir(task.videoPath)
      const pick = window.api?.openSubtitlePicker ?? window.api?.dialog?.openSubtitle

      if (typeof pick !== 'function') {
        console.error(
          'preload 未暴露 openSubtitlePicker，请完全退出应用后重新运行 npm run dev / 重新打包'
        )
        return
      }

      const path = await pick(dir || null)
      if (path) {
        useAppStore.getState().replaceTaskSubtitlePath(task.id, path)
        window.api?.task.replaceSubtitlePath(task.id, path)
      }
    },
    []
  )

  const handleOpenEditor = useCallback(
    (taskId: string) => {
      setEditingTaskId(taskId)
    },
    [setEditingTaskId]
  )

  const handleRemoveTask = useCallback(
    (taskId: string) => {
      window.api?.task.cancel(taskId)
      removeTask(taskId)
    },
    [removeTask]
  )

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    const updateViewportHeight = () => {
      setViewportHeight(el.clientHeight)
    }

    updateViewportHeight()
    const observer = new ResizeObserver(updateViewportHeight)
    observer.observe(el)

    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    const hasElapsedTasks = tasks.some((task) => ELAPSED_STATUSES.has(task.status) && !!task.statusUpdatedAt)
    if (!hasElapsedTasks) return

    const timer = setInterval(() => {
      setNowMs(Date.now())
    }, 1000)

    return () => clearInterval(timer)
  }, [tasks])

  if (tasks.length === 0) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center text-muted-foreground">
        <FileVideo className="mb-3 size-12 opacity-30" />
        <p className="text-sm">点击“导入”添加视频文件</p>
      </div>
    )
  }

  const visibleCount = Math.ceil(viewportHeight / TASK_ROW_HEIGHT) + TASK_ROW_OVERSCAN * 2
  const startIndex = Math.max(0, Math.floor(scrollTop / TASK_ROW_HEIGHT) - TASK_ROW_OVERSCAN)
  const endIndex = Math.min(tasks.length, startIndex + Math.max(visibleCount, TASK_ROW_OVERSCAN * 2))
  const topSpacerHeight = startIndex * TASK_ROW_HEIGHT
  const bottomSpacerHeight = Math.max(0, (tasks.length - endIndex) * TASK_ROW_HEIGHT)
  const visibleTasks = tasks.slice(startIndex, endIndex)

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div
        className="grid shrink-0 border-b border-border bg-background px-[15px] text-sm font-medium text-muted-foreground"
        style={{ gridTemplateColumns: GRID_COLUMNS, height: 44 }}
      >
        <div className="flex items-center pr-4">视频名称</div>
        <div className="flex items-center pr-4">字幕文件</div>
        <div className="flex items-center pr-4">进度</div>
        <div className="flex items-center">操作</div>
      </div>

      <div
        ref={viewportRef}
        className="flex-1 min-h-0 overflow-y-auto"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: topSpacerHeight }} />
        {visibleTasks.map((task) => (
          <VideoTaskRow
            key={task.id}
            task={task}
            reviewMode={config.reviewMode}
            nowMs={nowMs}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onPickSubtitle={handlePickSubtitle}
            onOpenEditor={handleOpenEditor}
            onRemoveTask={handleRemoveTask}
          />
        ))}
        <div style={{ height: bottomSpacerHeight }} />
      </div>
    </div>
  )
}
