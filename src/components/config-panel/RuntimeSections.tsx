import type { ConcurrencyOption, ReviewMode } from '../../types'
import { CONCURRENCY_OPTIONS } from '../../types'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { RadioGroup, RadioGroupItem } from '../ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Separator } from '../ui/separator'
import { CONCURRENCY_LABELS } from './constants'

interface RuntimeSectionsProps {
  maxConcurrentTasks: ConcurrencyOption
  reviewMode: ReviewMode
  autoReviewCountdown: number
  createVideoSubfolder: boolean
  useLLMSentenceGrouping: boolean
  hasLLMKey: boolean
  onChangeConcurrent: (value: ConcurrencyOption) => void
  onChangeReviewMode: (value: ReviewMode) => void
  onChangeAutoReviewCountdown: (value: number) => void
  onChangeCreateVideoSubfolder: (value: boolean) => void
  onChangeUseLLMSentenceGrouping: (value: boolean) => void
}

export function RuntimeSections({
  maxConcurrentTasks,
  reviewMode,
  autoReviewCountdown,
  createVideoSubfolder,
  useLLMSentenceGrouping,
  hasLLMKey,
  onChangeConcurrent,
  onChangeReviewMode,
  onChangeAutoReviewCountdown,
  onChangeCreateVideoSubfolder,
  onChangeUseLLMSentenceGrouping,
}: RuntimeSectionsProps) {
  return (
    <>
      <div className="space-y-2">
        <Label>同时处理视频数</Label>
        <Select value={String(maxConcurrentTasks)} onValueChange={(value) => onChangeConcurrent(Number(value) as ConcurrencyOption)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="选择并发数" />
          </SelectTrigger>
          <SelectContent>
            {CONCURRENCY_OPTIONS.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {CONCURRENCY_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">不支持手动输入，避免设置过大导致软件卡顿或崩溃。默认建议 2 个。</p>
      </div>

      <Separator />

      <div className="space-y-3">
        <Label>字幕审校模式</Label>
        <RadioGroup value={reviewMode} onValueChange={(value) => onChangeReviewMode(value as ReviewMode)}>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="auto" id="mode-auto" />
            <Label htmlFor="mode-auto" className="cursor-pointer font-normal">
              自动模式
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="manual" id="mode-manual" />
            <Label htmlFor="mode-manual" className="cursor-pointer font-normal">
              手动模式
            </Label>
          </div>
        </RadioGroup>
        {reviewMode === 'auto' && (
          <div className="flex items-center gap-2 pl-6">
            <Label className="shrink-0 text-sm text-muted-foreground">倒计时</Label>
            <Input
              type="number"
              min={5}
              max={300}
              value={autoReviewCountdown}
              onChange={(event) => onChangeAutoReviewCountdown(Number(event.target.value))}
              className="w-20"
            />
            <span className="text-sm text-muted-foreground">秒</span>
          </div>
        )}
      </div>

      <Separator />

      <div className="space-y-3">
        <Label>输出组织</Label>
        <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background/40 px-3 py-2">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            checked={createVideoSubfolder}
            onChange={(event) => onChangeCreateVideoSubfolder(event.target.checked)}
          />
          <div className="space-y-1">
            <div className="text-sm">为每个视频单独创建文件夹</div>
            <p className="text-xs text-muted-foreground">
              开启后，视频和字幕放进各自子文件夹；关闭后，所有输出直接放在所选输出目录下。
            </p>
          </div>
        </label>
      </div>

      <Separator />

      <div className="space-y-3">
        <Label>合成质量优化</Label>
        <label
          className={`flex items-start gap-3 rounded-md border border-border bg-background/40 px-3 py-2 ${
            hasLLMKey ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
          }`}
        >
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            checked={useLLMSentenceGrouping && hasLLMKey}
            disabled={!hasLLMKey}
            onChange={(event) => onChangeUseLLMSentenceGrouping(event.target.checked)}
          />
          <div className="space-y-1">
            <div className="text-sm">使用 LLM 智能分句（推荐）</div>
            <p className="text-xs text-muted-foreground">
              {hasLLMKey
                ? '翻译前先用 LLM 判断哪些相邻字幕属于同一句话再合并，可消除中文配音的句中停顿。每个视频会多几次 API 调用（结果会缓存）。'
                : '需先在上方配置 LLM 服务才能启用。'}
            </p>
          </div>
        </label>
      </div>
    </>
  )
}
