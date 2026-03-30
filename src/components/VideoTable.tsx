import { useCallback } from 'react'
import { useAppStore } from '../stores/app-store'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { ScrollArea } from './ui/scroll-area'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table'
import { Pencil, Eye, Pause, Play, Trash2, FileVideo } from 'lucide-react'
import type { TaskStatus, VideoTask } from '../types'
import { TASK_STATUS_META } from '../types'

function videoDir(videoPath: string): string {
  const i = Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\'))
  return i >= 0 ? videoPath.slice(0, i) : ''
}

/** Finder/资源管理器拖入时常带 file:// URI，不依赖 File.path / webUtils */
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
  waiting: 'bg-gray-100 text-gray-700',
  parsing: 'bg-blue-100 text-blue-700',
  translating: 'bg-purple-100 text-purple-700',
  reviewing: 'bg-amber-100 text-amber-700',
  synthesizing: 'bg-orange-100 text-orange-700',
  assembling: 'bg-cyan-100 text-cyan-700',
  encoding: 'bg-indigo-100 text-indigo-700',
  completed: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
  paused: 'bg-yellow-100 text-yellow-700',
}

export function VideoTable() {
  const { tasks, config, removeTask, updateTaskSubtitlePath, setEditingTaskId } =
    useAppStore()

  const resolveDroppedFilePath = useCallback(
    (e: React.DragEvent, file: File): string | undefined => {
      const fromUri = pathFromFileUriInDrag(e)
      if (fromUri && /\.(srt|vtt|ass)$/i.test(fromUri)) return fromUri

      try {
        const fn = window.api?.filePathFromDragFile ?? window.api?.subtitle?.pathFromFile
        if (fn) return fn(file)
      } catch {
        /* webUtils 可能拒绝非本机拖入文件 */
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
      if (filePath) updateTaskSubtitlePath(taskId, filePath)
    },
    [updateTaskSubtitlePath, resolveDroppedFilePath]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handlePickSubtitle = useCallback(
    async (task: VideoTask) => {
      const dir = videoDir(task.videoPath)
      const pick =
        window.api?.openSubtitlePicker ??
        window.api?.dialog?.openSubtitle
      if (typeof pick !== 'function') {
        console.error(
          'preload 未暴露 openSubtitlePicker，请完全退出应用后重新运行 npm run dev / 重新打包'
        )
        return
      }
      const path = await pick(dir || null)
      if (path) updateTaskSubtitlePath(task.id, path)
    },
    [updateTaskSubtitlePath]
  )

  const renderOps = (task: VideoTask) => {
    const btns: React.ReactNode[] = []

    if (task.status === 'reviewing') {
      const isAuto = config.reviewMode === 'auto'
      const countdownActive = isAuto && (task.countdownRemaining ?? 0) > 0
      const editable = isAuto ? countdownActive : true

      btns.push(
        <Button
          key="edit-view"
          variant="outline"
          size="xs"
          onClick={() => setEditingTaskId(task.id)}
        >
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
            <span className="ml-1 text-amber-600 tabular-nums">
              {task.countdownRemaining}s
            </span>
          )}
        </Button>
      )
    } else if (task.status === 'completed') {
      btns.push(
        <Button
          key="view"
          variant="outline"
          size="xs"
          onClick={() => setEditingTaskId(task.id)}
        >
          <Eye className="size-3" />
          查看
        </Button>
      )
    }

    if (
      ['parsing', 'translating', 'synthesizing', 'assembling', 'encoding'].includes(
        task.status
      )
    ) {
      btns.push(
        <Button
          key="pause"
          variant="outline"
          size="xs"
          onClick={() => window.api?.task.pause(task.id)}
        >
          <Pause className="size-3" />
          暂停
        </Button>
      )
    } else if (task.status === 'paused') {
      btns.push(
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

    btns.push(
      <Button
        key="delete"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground hover:text-destructive"
        onClick={() => {
          window.api?.task.cancel(task.id)
          removeTask(task.id)
        }}
      >
        <Trash2 className="size-3" />
      </Button>
    )

    return <div className="flex items-center gap-1">{btns}</div>
  }

  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
        <FileVideo className="size-12 mb-3 opacity-30" />
        <p className="text-sm">点击「导入」添加视频文件</p>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30%]">视频名称</TableHead>
            <TableHead className="w-[25%]">字幕文件</TableHead>
            <TableHead className="w-[15%]">进度</TableHead>
            <TableHead className="w-[30%]">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.map((task) => (
            <TableRow key={task.id}>
              <TableCell>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="block max-w-[220px] truncate cursor-default">
                      {task.videoName}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className="max-w-[400px] break-all"
                  >
                    {task.videoPath}
                  </TooltipContent>
                </Tooltip>
              </TableCell>

              <TableCell>
                <div
                  role="button"
                  tabIndex={0}
                  className={`border rounded-md px-3 py-1.5 text-sm text-left transition-colors min-h-[2.25rem] flex items-center justify-start cursor-pointer select-none hover:border-primary/50 hover:bg-muted/50 ${
                    task.subtitlePath
                      ? 'border-border text-foreground'
                      : 'border-dashed border-muted-foreground/40 text-muted-foreground'
                  }`}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(task.id, e)}
                  onClick={() => void handlePickSubtitle(task)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void handlePickSubtitle(task)
                    }
                  }}
                >
                  {task.subtitlePath ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block max-w-[220px] truncate cursor-default">
                          {task.subtitlePath.split(/[\\/]/).pop()}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        className="max-w-[400px] break-all"
                      >
                        {task.subtitlePath}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span>点击选择或拖拽字幕</span>
                  )}
                </div>
              </TableCell>

              <TableCell>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={`${STATUS_COLORS[task.status]} border`}>
                      {TASK_STATUS_META[task.status].label}
                    </Badge>
                    {task.progress > 0 && task.status !== 'completed' && task.status !== 'error' && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {task.progress}%
                      </span>
                    )}
                  </div>
                  {task.progress > 0 && task.status !== 'waiting' && (
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          task.status === 'completed'
                            ? 'bg-green-500'
                            : task.status === 'error'
                              ? 'bg-red-500'
                              : 'bg-primary'
                        }`}
                        style={{ width: `${task.progress}%` }}
                      />
                    </div>
                  )}
                  {task.error && (
                    <p className="text-xs text-red-500 truncate max-w-[160px]" title={task.error}>
                      {task.error}
                    </p>
                  )}
                </div>
              </TableCell>

              <TableCell>{renderOps(task)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  )
}
