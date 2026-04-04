import { useAppStore } from '../stores/app-store'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Upload, Trash2, FolderOpen, Play, Pause, PanelLeft, RotateCcw } from 'lucide-react'
import type { TaskStatus, VideoTask } from '../types'

const IN_FLIGHT_STATUSES: TaskStatus[] = [
  'queued',
  'parsing',
  'translating',
  'reviewing',
  'synthesizing',
  'assembling',
  'encoding',
  'paused',
]

const RUNNING_STATUSES: TaskStatus[] = [
  'parsing',
  'translating',
  'reviewing',
  'synthesizing',
  'assembling',
  'encoding',
]
const PAUSABLE_STATUSES: TaskStatus[] = [...RUNNING_STATUSES, 'queued']
const SUBTITLE_DETECT_CONCURRENCY = 4

export function ActionBar() {
  const {
    tasks,
    config,
    sidebarOpen,
    addTasks,
    clearTasks,
    setConfig,
    setSidebarOpen,
    toggleSidebar,
    updateTaskSubtitlePath,
  } = useAppStore()

  const hasTasks = tasks.length > 0
  const hasStartableWaitingTasks = tasks.some((t) => t.status === 'waiting' && !!t.subtitlePath)
  const hasPausableTasks = tasks.some((t) => PAUSABLE_STATUSES.includes(t.status))
  const hasRunningTasks = tasks.some((t) => RUNNING_STATUSES.includes(t.status))
  const pausedTaskIds = tasks.filter((t) => t.status === 'paused').map((t) => t.id)
  const hasPausedTasks = pausedTaskIds.length > 0
  const failedTaskIds = tasks
    .filter((t) => t.status === 'error' && !!t.subtitlePath)
    .map((t) => t.id)
  const hasFailedTasks = failedTaskIds.length > 0

  const handleImport = async () => {
    const filePaths = await window.api?.dialog.openVideos()
    if (!filePaths?.length) return

    const knownVideoPaths = new Set(tasks.map((task) => task.videoPath))
    const newTasks: VideoTask[] = []
    for (const videoPath of filePaths) {
      if (knownVideoPaths.has(videoPath)) continue
      knownVideoPaths.add(videoPath)
      newTasks.push({
        id: crypto.randomUUID(),
        videoPath,
        videoName: videoPath.split(/[\\/]/).pop() || videoPath,
        subtitlePath: null,
        status: 'waiting',
        progress: 0,
      })
    }

    if (newTasks.length === 0) return
    addTasks(newTasks)
    window.api?.task.register(newTasks)

    for (let i = 0; i < newTasks.length; i += SUBTITLE_DETECT_CONCURRENCY) {
      const batch = newTasks.slice(i, i + SUBTITLE_DETECT_CONCURRENCY)
      const results = await Promise.all(
        batch.map(async (task) => ({
          id: task.id,
          subtitlePath: (await window.api?.subtitle?.detect?.(task.videoPath)) || null,
        }))
      )

      for (const result of results) {
        if (result.subtitlePath) {
          const latestTask = useAppStore.getState().tasks.find((task) => task.id === result.id)
          if (!latestTask || latestTask.subtitlePath) continue
          updateTaskSubtitlePath(result.id, result.subtitlePath)
          window.api?.task.updateSubtitlePath(result.id, result.subtitlePath)
        }
      }
    }
  }

  const handleOutput = async () => {
    const dir = await window.api?.dialog.openOutput()
    if (dir) setConfig({ outputDir: dir })
  }

  const handleStart = () => {
    if (!config.deepseekKey.trim()) {
      if (!sidebarOpen) setSidebarOpen(true)
      window.alert('请先在左侧配置面板中填写 DeepSeek API Key，再开始处理。')
      return
    }

    if (!config.outputDir.trim()) {
      window.alert('请先选择输出目录，再开始处理。')
      return
    }

    if (!config.selectedVoice.trim()) {
      if (!sidebarOpen) setSidebarOpen(true)
      window.alert('请先在左侧配置面板中选择一个 Edge TTS 声音，再开始处理。')
      return
    }

    const waitingTasks = tasks
      .filter((t) => t.status === 'waiting' && t.subtitlePath)
      .map((t) => ({ id: t.id, videoPath: t.videoPath, subtitlePath: t.subtitlePath }))

    if (waitingTasks.length > 0) window.api?.task.start(waitingTasks, config)
  }

  const handlePauseAll = () => {
    if (!hasPausableTasks) return
    window.api?.task.pauseAll()
  }

  const handleResumeAll = () => {
    if (!hasPausedTasks) return
    window.api?.task.resumeAll(pausedTaskIds, config)
  }

  const handleRetryFailed = () => {
    if (!hasFailedTasks) return
    window.api?.task.resumeAll(failedTaskIds, config)
  }

  const handleClear = () => {
    if (!hasTasks) return
    const hasActive = tasks.some((t) => IN_FLIGHT_STATUSES.includes(t.status))
    if (hasActive) {
      const ok = window.confirm('仍有任务进行中或已暂停，确定要清空吗？将终止所有任务并清理相关缓存。')
      if (!ok) return
    }
    window.api?.task.cancelAll(tasks.map((t) => t.id))
    clearTasks()
  }

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
      {!sidebarOpen && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={toggleSidebar}>
              <PanelLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>展开配置面板</TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={handleImport}>
            <Upload className="size-4" />
            导入
          </Button>
        </TooltipTrigger>
        <TooltipContent>选择视频文件，支持多选</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={handleClear} disabled={!hasTasks}>
            <Trash2 className="size-4" />
            清空
          </Button>
        </TooltipTrigger>
        <TooltipContent>清空所有任务</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={handlePauseAll} disabled={!hasPausableTasks}>
            <Pause className="size-4" />
            暂停所有
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {hasRunningTasks ? '暂停当前所有正在执行的任务' : '当前没有可暂停的运行中任务'}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={handleResumeAll} disabled={!hasPausedTasks}>
            <Play className="size-4" />
            继续所有
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {hasPausedTasks ? '恢复所有已暂停任务，并按并发上限继续执行' : '当前没有已暂停任务'}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={handleOutput}>
            <FolderOpen className="size-4" />
            输出
            {config.outputDir && (
              <span className="ml-1 max-w-[120px] truncate text-xs text-muted-foreground">
                {config.outputDir.split(/[\\/]/).pop()}
              </span>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{config.outputDir || '选择输出目录'}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={handleRetryFailed} disabled={!hasFailedTasks}>
            <RotateCcw className="size-4" />
            重试失败任务
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {hasFailedTasks ? '重新开始所有失败且已关联字幕的任务' : '当前没有可重试的失败任务'}
        </TooltipContent>
      </Tooltip>

      <div className="flex-1" />

      <Button size="sm" onClick={handleStart} disabled={!hasStartableWaitingTasks}>
        <Play className="size-4" />
        开始处理
      </Button>
    </div>
  )
}
