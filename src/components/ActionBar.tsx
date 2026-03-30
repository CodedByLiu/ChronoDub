import { useAppStore } from '../stores/app-store'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Upload, Trash2, FolderOpen, Play, PanelLeft } from 'lucide-react'
import type { TaskStatus, VideoTask } from '../types'

const IN_FLIGHT_STATUSES: TaskStatus[] = [
  'parsing',
  'translating',
  'reviewing',
  'synthesizing',
  'assembling',
  'encoding',
  'paused',
]

export function ActionBar() {
  const { tasks, config, sidebarOpen, addTasks, clearTasks, setConfig, toggleSidebar } =
    useAppStore()

  const handleImport = async () => {
    const filePaths = await window.api?.dialog.openVideos()
    if (!filePaths?.length) return

    const newTasks: VideoTask[] = []
    for (const videoPath of filePaths) {
      if (tasks.some((t) => t.videoPath === videoPath)) continue
      const videoName = videoPath.split(/[\\/]/).pop() || videoPath
      const subtitlePath = (await window.api?.subtitle?.detect?.(videoPath)) || null
      newTasks.push({
        id: crypto.randomUUID(),
        videoPath,
        videoName,
        subtitlePath,
        status: 'waiting',
        progress: 0,
      })
    }

    if (newTasks.length > 0) addTasks(newTasks)
  }

  const handleOutput = async () => {
    const dir = await window.api?.dialog.openOutput()
    if (dir) setConfig({ outputDir: dir })
  }

  const handleStart = () => {
    const waitingTasks = tasks
      .filter((t) => t.status === 'waiting' && t.subtitlePath)
      .map((t) => ({ id: t.id, videoPath: t.videoPath, subtitlePath: t.subtitlePath }))
    if (waitingTasks.length > 0) window.api?.task.start(waitingTasks)
  }

  const handleClear = () => {
    if (tasks.length === 0) return
    const hasActive = tasks.some((t) => IN_FLIGHT_STATUSES.includes(t.status))
    if (hasActive) {
      const ok = window.confirm(
        '仍有任务进行中或已暂停，确定要清空吗？将终止所有任务并清除相关缓存。'
      )
      if (!ok) return
      window.api?.task.cancelAll(tasks.map((t) => t.id))
    }
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
        <TooltipContent>选择视频文件 (支持多选)</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={handleClear} disabled={tasks.length === 0}>
            <Trash2 className="size-4" />
            清空
          </Button>
        </TooltipTrigger>
        <TooltipContent>清空所有任务</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={handleOutput}>
            <FolderOpen className="size-4" />
            输出
            {config.outputDir && (
              <span className="ml-1 max-w-[120px] truncate text-muted-foreground text-xs">
                {config.outputDir.split(/[\\/]/).pop()}
              </span>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{config.outputDir || '选择输出目录'}</TooltipContent>
      </Tooltip>

      <div className="flex-1" />

      <Button size="sm" onClick={handleStart} disabled={!tasks.some((t) => t.status === 'waiting')}>
        <Play className="size-4" />
        开始处理
      </Button>
    </div>
  )
}
