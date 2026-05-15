import { RotateCcw } from 'lucide-react'
import type {
  SubtitleOutputMode,
  SubtitlePosition,
  SubtitleStyleConfig,
} from '../../types'
import { DEFAULT_SUBTITLE_STYLE } from '../../types'
import { FontCombobox } from '../font-combobox'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Separator } from '../ui/separator'
import {
  PREFERRED_SUBTITLE_FONTS,
  SUBTITLE_OUTPUT_MODE_LABELS,
  SUBTITLE_POSITION_LABELS,
  type SubtitleNumberField,
} from './constants'
import { normalizeColorValue } from './helpers'

interface SubtitleOutputSectionProps {
  outputMode: SubtitleOutputMode
  style: SubtitleStyleConfig
  subtitleFonts: readonly string[]
  subtitleNumberDrafts: Record<SubtitleNumberField, string>
  onChangeOutputMode: (mode: SubtitleOutputMode) => void
  onSetStyle: (partial: Partial<SubtitleStyleConfig>) => void
  onResetStyle: () => void
  onDraftChange: (field: SubtitleNumberField, value: string) => void
  onDraftCommit: (field: SubtitleNumberField) => void
}

export function SubtitleOutputSection({
  outputMode,
  style,
  subtitleFonts,
  subtitleNumberDrafts,
  onChangeOutputMode,
  onSetStyle,
  onResetStyle,
  onDraftChange,
  onDraftCommit,
}: SubtitleOutputSectionProps) {
  return (
    <>
      <div className="space-y-3">
        <Label>字幕输出方式</Label>
        <Select value={outputMode} onValueChange={(value) => onChangeOutputMode(value as SubtitleOutputMode)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="选择字幕输出方式" />
          </SelectTrigger>
          <SelectContent>
            {(['external', 'burned'] as SubtitleOutputMode[]).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {SUBTITLE_OUTPUT_MODE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          生成字幕文件会输出独立 SRT；硬嵌字幕会把字幕直接烧进视频，不再额外生成字幕文件。
        </p>
      </div>

      {outputMode === 'burned' && (
        <>
          <div className="space-y-4 rounded-lg border border-border bg-background/50 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <Label>硬嵌字幕样式</Label>
                <p className="text-xs text-muted-foreground">
                  硬嵌字幕会重新编码视频，速度会比外挂字幕慢。字体列表来自当前系统已安装字体。
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={onResetStyle}>
                <RotateCcw className="size-3.5" />
                恢复默认
              </Button>
            </div>

            <div className="space-y-2">
              <Label>字体</Label>
              <FontCombobox
                fonts={subtitleFonts}
                value={style.fontFamily || subtitleFonts[0]}
                onChange={(value) => onSetStyle({ fontFamily: value })}
                preferredFonts={PREFERRED_SUBTITLE_FONTS}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>字体大小</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={subtitleNumberDrafts.fontSize}
                  onChange={(event) => onDraftChange('fontSize', event.target.value)}
                  onBlur={() => onDraftCommit('fontSize')}
                  onKeyDown={(event) => event.key === 'Enter' && onDraftCommit('fontSize')}
                />
              </div>
              <div className="space-y-2">
                <Label>位置</Label>
                <Select value={style.position} onValueChange={(value) => onSetStyle({ position: value as SubtitlePosition })}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择位置" />
                  </SelectTrigger>
                  <SelectContent>
                    {(['top-safe', 'bottom-safe'] as SubtitlePosition[]).map((position) => (
                      <SelectItem key={position} value={position}>
                        {SUBTITLE_POSITION_LABELS[position]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <div className="space-y-2">
                <Label>字体颜色</Label>
                <Input
                  value={style.textColor}
                  onChange={(event) =>
                    onSetStyle({
                      textColor: event.target.value.trim() || DEFAULT_SUBTITLE_STYLE.textColor,
                    })
                  }
                />
              </div>
              <Input
                type="color"
                value={normalizeColorValue(style.textColor, DEFAULT_SUBTITLE_STYLE.textColor)}
                onChange={(event) => onSetStyle({ textColor: event.target.value })}
                className="h-10 w-16 p-1"
              />
            </div>

            <div className="space-y-2">
              <Label>字形</Label>
              <div className="flex gap-2">
                <Button type="button" variant={style.bold ? 'default' : 'outline'} size="sm" onClick={() => onSetStyle({ bold: !style.bold })}>
                  B 加粗
                </Button>
                <Button
                  type="button"
                  variant={style.italic ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => onSetStyle({ italic: !style.italic })}
                >
                  I 斜体
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">点击一次开启，再点一次关闭。</p>
            </div>

            <label className="flex items-start gap-3 rounded-md border border-border bg-background/40 px-3 py-2">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={style.outlineEnabled}
                onChange={(event) => onSetStyle({ outlineEnabled: event.target.checked })}
              />
              <div className="space-y-1">
                <div className="text-sm">描边</div>
                <p className="text-xs text-muted-foreground">关闭后将不绘制字幕描边。</p>
              </div>
            </label>

            {style.outlineEnabled && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>描边大小</Label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={subtitleNumberDrafts.outlineWidth}
                    onChange={(event) => onDraftChange('outlineWidth', event.target.value)}
                    onBlur={() => onDraftCommit('outlineWidth')}
                    onKeyDown={(event) => event.key === 'Enter' && onDraftCommit('outlineWidth')}
                  />
                </div>
                <div className="grid grid-cols-[1fr_auto] items-end gap-3">
                  <div className="space-y-2">
                    <Label>描边颜色</Label>
                    <Input
                      value={style.outlineColor}
                      onChange={(event) =>
                        onSetStyle({
                          outlineColor: event.target.value.trim() || DEFAULT_SUBTITLE_STYLE.outlineColor,
                        })
                      }
                    />
                  </div>
                  <Input
                    type="color"
                    value={normalizeColorValue(style.outlineColor, DEFAULT_SUBTITLE_STYLE.outlineColor)}
                    onChange={(event) => onSetStyle({ outlineColor: event.target.value })}
                    className="h-10 w-16 p-1"
                  />
                </div>
              </div>
            )}

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background/40 px-3 py-2">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={style.backgroundEnabled}
                onChange={(event) => onSetStyle({ backgroundEnabled: event.target.checked })}
              />
              <div className="space-y-1">
                <div className="text-sm">背景填充</div>
                <p className="text-xs text-muted-foreground">
                  开启后为整行字幕添加背景框，颜色和透明度由背景配置控制，当前版本不提供圆角设置。
                </p>
              </div>
            </label>

            {style.backgroundEnabled && (
              <div className="grid grid-cols-2 gap-3">
                <div className="grid grid-cols-[1fr_auto] items-end gap-3">
                  <div className="space-y-2">
                    <Label>背景颜色</Label>
                    <Input
                      value={style.backgroundColor}
                      onChange={(event) =>
                        onSetStyle({
                          backgroundColor: event.target.value.trim() || DEFAULT_SUBTITLE_STYLE.backgroundColor,
                        })
                      }
                    />
                  </div>
                  <Input
                    type="color"
                    value={normalizeColorValue(style.backgroundColor, DEFAULT_SUBTITLE_STYLE.backgroundColor)}
                    onChange={(event) => onSetStyle({ backgroundColor: event.target.value })}
                    className="h-10 w-16 p-1"
                  />
                </div>
                <div className="space-y-2">
                  <Label>背景透明度</Label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={subtitleNumberDrafts.backgroundOpacity}
                    onChange={(event) => onDraftChange('backgroundOpacity', event.target.value)}
                    onBlur={() => onDraftCommit('backgroundOpacity')}
                    onKeyDown={(event) => event.key === 'Enter' && onDraftCommit('backgroundOpacity')}
                  />
                </div>
                <div className="space-y-2">
                  <Label>背景内边距</Label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={subtitleNumberDrafts.backgroundPadding}
                    onChange={(event) => onDraftChange('backgroundPadding', event.target.value)}
                    onBlur={() => onDraftCommit('backgroundPadding')}
                    onKeyDown={(event) => event.key === 'Enter' && onDraftCommit('backgroundPadding')}
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label>安全区边距</Label>
              <Input
                type="text"
                inputMode="numeric"
                value={subtitleNumberDrafts.safeMargin}
                onChange={(event) => onDraftChange('safeMargin', event.target.value)}
                onBlur={() => onDraftCommit('safeMargin')}
                onKeyDown={(event) => event.key === 'Enter' && onDraftCommit('safeMargin')}
              />
              <p className="text-xs text-muted-foreground">控制字幕距离顶部或底部安全区的边距，单位为像素。</p>
            </div>

            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background/40 px-3 py-2">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={style.softWrapEnabled}
                onChange={(event) => onSetStyle({ softWrapEnabled: event.target.checked })}
              />
              <div className="space-y-1">
                <div className="text-sm">自动换行</div>
                <p className="text-xs text-muted-foreground">
                  超过指定字符数时，自动在标点或空格处折成两行，避免长句撑出屏幕。
                </p>
              </div>
            </label>

            {style.softWrapEnabled && (
              <div className="space-y-2">
                <Label>换行字符数阈值</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={subtitleNumberDrafts.softWrapMaxChars}
                  onChange={(event) => onDraftChange('softWrapMaxChars', event.target.value)}
                  onBlur={() => onDraftCommit('softWrapMaxChars')}
                  onKeyDown={(event) => event.key === 'Enter' && onDraftCommit('softWrapMaxChars')}
                />
                <p className="text-xs text-muted-foreground">
                  中文一般 16-20 字最舒服。单条字幕超过这个长度会自动折两行。
                </p>
              </div>
            )}
          </div>

          <Separator />
        </>
      )}
    </>
  )
}
