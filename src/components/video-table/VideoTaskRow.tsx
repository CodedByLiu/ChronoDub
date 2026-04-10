import { memo, type DragEvent, type ReactNode } from 'react'
import { Eye, FileWarning, Pause, Pencil, Play, RefreshCcw, Trash2 } from 'lucide-react'
import type { AppConfig, ReviewMode, TranslationIssue, VideoTask } from '../../types'
import { TASK_STATUS_META } from '../../types'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  ACTIVE_TASK_STATUSES,
  ELAPSED_STATUSES,
  GRID_COLUMNS,
  STATUS_COLORS,
  SUBTITLE_EDITABLE_STATUSES,
  TASK_ROW_HEIGHT,
} from './constants'

interface VideoTaskRowProps {
  task: VideoTask
  reviewMode: ReviewMode
  config: AppConfig
  translationIssues: TranslationIssue[]
  nowMs: number
  onDragOver: (event: DragEvent) => void
  onDrop: (taskId: string, event: DragEvent) => void
  onPickSubtitle: (task: VideoTask) => Promise<void>
  onOpenEditor: (taskId: string) => void
  onRemoveTask: (taskId: string) => void
}

export const VideoTaskRow = memo(function VideoTaskRow({
  task,
  reviewMode,
  config,
  translationIssues,
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
    const buttons: ReactNode[] = []

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
        <Button variant="outline" size="xs" key="resume" onClick={() => window.api?.task.resume(task.id, config)}>
          <Play className="size-3" />
          继续
        </Button>
      )
    } else if (task.status === 'error' && task.subtitlePath && translationIssues.length > 0) {
      buttons.push(
        <Button
          key="retry-missing"
          variant="outline"
          size="xs"
          onClick={() => window.api?.task.retryFailedTranslations(task.id, config)}
        >
          <RefreshCcw className="size-3" />
          仅重翻失败项
        </Button>
      )
    } else if (task.status === 'error' && task.subtitlePath) {
      buttons.push(
        <Button key="retry" variant="outline" size="xs" onClick={() => window.api?.task.resume(task.id, config)}>
          <Play className="size-3" />
          重试
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
            <span className="block cursor-default truncate">{task.videoName}</span>
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
          className={`flex min-h-[2.25rem] cursor-pointer select-none items-center justify-start rounded-md border border-border bg-input-bg px-3 py-1.5 text-left text-sm transition-colors hover:border-primary/45 hover:bg-muted/40 ${
            task.subtitlePath
              ? 'text-foreground'
              : 'border-dashed border-muted-foreground/35 text-muted-foreground'
          } ${subtitleEditable ? '' : 'cursor-not-allowed opacity-70 hover:border-border hover:bg-input-bg'}`}
          onDragOver={onDragOver}
          onDrop={(event) => {
            if (!subtitleEditable) {
              event.preventDefault()
              event.stopPropagation()
              return
            }
            onDrop(task.id, event)
          }}
          onClick={() => {
            if (!subtitleEditable) return
            void onPickSubtitle(task)
          }}
          onKeyDown={(event) => {
            if (!subtitleEditable) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              void onPickSubtitle(task)
            }
          }}
        >
          {task.subtitlePath ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block cursor-default truncate">
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
                  <p className="cursor-help truncate text-xs text-red-400">{task.error}</p>
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

          {task.status === 'error' && translationIssues.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="inline-flex max-w-full cursor-help items-center gap-1 truncate text-xs text-amber-300">
                  <FileWarning className="size-3 shrink-0" />
                  未翻译条目 {translationIssues.length} 条
                </p>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[560px] whitespace-pre-wrap break-all">
                <p className="mb-1 text-xs text-amber-300">可仅重翻以下失败条目：</p>
                {translationIssues.map((issue) => (
                  <p key={`${task.id}-${issue.id}`} className="text-xs text-muted-foreground">
                    #{issue.id}: {issue.text}
                  </p>
                ))}
              </TooltipContent>
            </Tooltip>
          )}

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
