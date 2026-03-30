import { useState, useEffect, useCallback, useRef } from 'react'
import { useAppStore } from '../stores/app-store'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Badge } from './ui/badge'
import { Save, Check, Timer, X } from 'lucide-react'
import type { Cue } from '../types'

function formatTimestamp(us: number): string {
  const totalMs = Math.floor(us / 1000)
  const h = Math.floor(totalMs / 3600000)
  const m = Math.floor((totalMs % 3600000) / 60000)
  const s = Math.floor((totalMs % 60000) / 1000)
  const ms = totalMs % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

const ROW_MIN =
  'flex min-h-[4.75rem] items-start gap-2 border-b border-border/50 py-2.5 last:border-b-0'
const IDX_CLS =
  'w-9 shrink-0 pt-1.5 text-right text-xs font-medium tabular-nums text-muted-foreground'
const TIME_CLS =
  'w-[5.5rem] shrink-0 pt-1.5 font-mono text-[10px] leading-none text-muted-foreground'
const TEXT_BLOCK = 'min-w-0 flex-1 text-sm leading-6'

export function SubtitleEditor() {
  const { editingTaskId, tasks, config, setEditingTaskId, updateTaskChineseCues } =
    useAppStore()

  const task = tasks.find((t) => t.id === editingTaskId)
  const [localCues, setLocalCues] = useState<Cue[]>([])

  const leftScrollRef = useRef<HTMLDivElement>(null)
  const rightScrollRef = useRef<HTMLDivElement>(null)
  const scrollLockRef = useRef(false)

  const isOpen = !!editingTaskId && !!task
  const isReviewing = task?.status === 'reviewing'
  const isAutoMode = config.reviewMode === 'auto'
  const countdownActive = isReviewing && isAutoMode && (task?.countdownRemaining ?? 0) > 0
  const isEditable = isReviewing && (isAutoMode ? countdownActive : true)

  useEffect(() => {
    if (!editingTaskId) {
      setLocalCues([])
      return
    }
    setLocalCues([])
  }, [editingTaskId])

  useEffect(() => {
    if (!editingTaskId || !task?.chineseCues?.length) return
    setLocalCues((prev) =>
      prev.length === 0 ? task.chineseCues!.map((c) => ({ ...c })) : prev
    )
  }, [editingTaskId, task?.chineseCues])

  useEffect(() => {
    if (
      isReviewing &&
      isAutoMode &&
      task?.countdownRemaining !== undefined &&
      task.countdownRemaining <= 0 &&
      isOpen
    ) {
      setEditingTaskId(null)
    }
  }, [task?.countdownRemaining, isReviewing, isAutoMode, isOpen, setEditingTaskId])

  const syncScrollFrom = useCallback((source: 'left' | 'right', scrollTop: number) => {
    if (scrollLockRef.current) return
    scrollLockRef.current = true
    const target = source === 'left' ? rightScrollRef.current : leftScrollRef.current
    if (target) target.scrollTop = scrollTop
    requestAnimationFrame(() => {
      scrollLockRef.current = false
    })
  }, [])

  const handleCueChange = useCallback((index: number, text: string) => {
    setLocalCues((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], text }
      return next
    })
  }, [])

  const handleSave = useCallback(() => {
    if (!editingTaskId) return
    updateTaskChineseCues(editingTaskId, localCues)
    window.api?.task.saveReview(editingTaskId, localCues)
  }, [editingTaskId, localCues, updateTaskChineseCues])

  const handleApply = useCallback(() => {
    if (!editingTaskId) return
    updateTaskChineseCues(editingTaskId, localCues)
    window.api?.task.confirmReview(editingTaskId, localCues)
    setEditingTaskId(null)
  }, [editingTaskId, localCues, updateTaskChineseCues, setEditingTaskId])

  const handleClose = useCallback(() => {
    setEditingTaskId(null)
  }, [setEditingTaskId])

  if (!task) return null

  const englishCues = task.englishCues || []
  const rowCount = Math.max(englishCues.length, localCues.length)

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent
        className="!flex h-[92vh] max-h-[92vh] w-[min(98vw,1920px)] max-w-[98vw] flex-col gap-4 overflow-hidden p-6 sm:max-w-[min(98vw,1920px)]"
        showCloseButton={false}
      >
        <DialogHeader className="shrink-0 space-y-0">
          <div className="flex items-center justify-between gap-4">
            <DialogTitle className="flex items-center gap-2">
              字幕 - {task.videoName}
              {isReviewing && isAutoMode && task.countdownRemaining !== undefined && (
                <Badge
                  variant="outline"
                  className={
                    countdownActive
                      ? 'bg-amber-100 text-amber-700 border-amber-200'
                      : 'bg-gray-100 text-gray-500 border-gray-200'
                  }
                >
                  <Timer className="size-3" />
                  {countdownActive ? `${task.countdownRemaining}s` : '已超时'}
                </Badge>
              )}
            </DialogTitle>

            <div className="flex items-center gap-2">
              {isEditable && isAutoMode && (
                <Button variant="outline" size="sm" onClick={handleSave}>
                  <Save className="size-3" />
                  保存
                </Button>
              )}
              {isEditable && !isAutoMode && (
                <Button size="sm" onClick={handleApply}>
                  <Check className="size-3" />
                  应用
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" onClick={handleClose}>
                <X className="size-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-6">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="mb-2 shrink-0 px-1 text-sm font-medium text-muted-foreground">
              英文字幕
            </div>
            <div
              ref={leftScrollRef}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md border bg-background p-3"
              onScroll={(e) => syncScrollFrom('left', e.currentTarget.scrollTop)}
            >
              <div>
                {Array.from({ length: rowCount }, (_, i) => {
                  const cue = englishCues[i]
                  return (
                    <div key={cue?.id ?? `en-${i}`} className={ROW_MIN}>
                      <span className={IDX_CLS}>{i + 1}</span>
                      <span className={TIME_CLS}>
                        {cue ? formatTimestamp(cue.startUs) : '—'}
                      </span>
                      <p
                        className={`${TEXT_BLOCK} min-h-[4.5rem] whitespace-pre-wrap break-words`}
                      >
                        {cue?.text ?? ''}
                      </p>
                    </div>
                  )
                })}
                {rowCount === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    暂无英文字幕
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="mb-2 shrink-0 px-1 text-sm font-medium text-muted-foreground">
              中文字幕
              {isEditable && (
                <span className="ml-2 text-xs text-amber-600">可编辑</span>
              )}
            </div>
            <div
              ref={rightScrollRef}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md border bg-background p-3"
              onScroll={(e) => syncScrollFrom('right', e.currentTarget.scrollTop)}
            >
              <div>
                {Array.from({ length: rowCount }, (_, i) => {
                  const en = englishCues[i]
                  const cue = localCues[i]
                  return (
                    <div key={cue?.id ?? en?.id ?? `zh-${i}`} className={ROW_MIN}>
                      <span className={IDX_CLS}>{i + 1}</span>
                      <span className={TIME_CLS}>
                        {cue ? formatTimestamp(cue.startUs) : en ? formatTimestamp(en.startUs) : '—'}
                      </span>
                      {isEditable ? (
                        <Textarea
                          value={cue?.text ?? ''}
                          onChange={(e) => handleCueChange(i, e.target.value)}
                          className={`${TEXT_BLOCK} min-h-[4.5rem] resize-y border-input`}
                          rows={3}
                        />
                      ) : (
                        <p
                          className={`${TEXT_BLOCK} min-h-[4.5rem] whitespace-pre-wrap break-words`}
                        >
                          {cue?.text ?? ''}
                        </p>
                      )}
                    </div>
                  )
                })}
                {rowCount === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    暂无中文字幕
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
