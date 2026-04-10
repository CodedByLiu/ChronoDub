import { useCallback, useEffect, useRef, useState } from 'react'
import { FileVideo } from 'lucide-react'
import type { VideoTask } from '../types'
import { useAppStore } from '../stores/app-store'
import { GRID_COLUMNS, ELAPSED_STATUSES, TASK_ROW_HEIGHT, TASK_ROW_OVERSCAN } from './video-table/constants'
import { VideoTaskRow } from './video-table/VideoTaskRow'
import { pathFromFileUriInDrag, videoDir } from './video-table/utils'

export function VideoTable() {
  const { tasks, config, translationIssues, removeTask, setEditingTaskId } = useAppStore()
  const viewportRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())

  const resolveDroppedFilePath = useCallback((event: React.DragEvent, file: File): string | undefined => {
    const fromUri = pathFromFileUriInDrag(event)
    if (fromUri && /\.(srt|vtt|ass)$/i.test(fromUri)) return fromUri

    try {
      const fn = window.api?.filePathFromDragFile ?? window.api?.subtitle?.pathFromFile
      if (fn) return fn(file)
    } catch {
      // webUtils may reject some drag sources.
    }

    const legacy = (file as unknown as { path?: string }).path
    return typeof legacy === 'string' ? legacy : undefined
  }, [])

  const handleDrop = useCallback(
    (taskId: string, event: React.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()

      const file = event.dataTransfer.files[0]
      if (!file) return

      const ext = file.name.split('.').pop()?.toLowerCase()
      if (!['srt', 'vtt', 'ass'].includes(ext || '')) return

      const filePath = resolveDroppedFilePath(event, file)
      if (filePath) {
        useAppStore.getState().replaceTaskSubtitlePath(taskId, filePath)
        window.api?.task.replaceSubtitlePath(taskId, filePath)
      }
    },
    [resolveDroppedFilePath]
  )

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const handlePickSubtitle = useCallback(async (task: VideoTask) => {
    const pick = window.api?.openSubtitlePicker ?? window.api?.dialog?.openSubtitle
    if (typeof pick !== 'function') {
      console.error('preload 未暴露 openSubtitlePicker，请完全退出应用后重新运行')
      return
    }

    const path = await pick(videoDir(task.videoPath) || null)
    if (path) {
      useAppStore.getState().replaceTaskSubtitlePath(task.id, path)
      window.api?.task.replaceSubtitlePath(task.id, path)
    }
  }, [])

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
    const element = viewportRef.current
    if (!element) return

    const updateViewportHeight = () => {
      setViewportHeight(element.clientHeight)
    }

    updateViewportHeight()
    const observer = new ResizeObserver(updateViewportHeight)
    observer.observe(element)
    return () => observer.disconnect()
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
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-muted-foreground">
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
    <div className="flex min-h-0 flex-1 flex-col">
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
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: topSpacerHeight }} />
        {visibleTasks.map((task) => (
          <VideoTaskRow
            key={task.id}
            task={task}
            reviewMode={config.reviewMode}
            config={config}
            translationIssues={translationIssues[task.id] ?? []}
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
