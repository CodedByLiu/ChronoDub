import { useState, useEffect, useCallback } from 'react'
import { useAppStore } from '../stores/app-store'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { Separator } from './ui/separator'
import { ScrollArea } from './ui/scroll-area'
import { RadioGroup, RadioGroupItem } from './ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import {
  Plus,
  Trash2,
  Volume2,
  PanelLeftClose,
  Venus,
  Mars,
  Eye,
  EyeOff,
  FlaskConical,
  RotateCcw,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { FontCombobox } from './font-combobox'
import { CONCURRENCY_OPTIONS, DEFAULT_SUBTITLE_STYLE } from '../types'
import type {
  ConcurrencyOption,
  ReviewMode,
  SubtitleOutputMode,
  SubtitlePosition,
  SubtitleStyleConfig,
} from '../types'

interface Voice {
  name: string
  locale: string
  gender: string
}

type SubtitleNumberField = 'fontSize' | 'outlineWidth' | 'backgroundOpacity' | 'safeMargin'

const VOICE_CN_NAMES: Record<string, string> = {
  'zh-CN-XiaoxiaoNeural': '晓晓',
  'zh-CN-XiaoyiNeural': '晓伊',
  'zh-CN-YunjianNeural': '云健',
  'zh-CN-YunxiNeural': '云希',
  'zh-CN-YunxiaNeural': '云夏',
  'zh-CN-YunyangNeural': '云扬',
  'zh-CN-XiaochenNeural': '晓辰',
  'zh-CN-XiaohanNeural': '晓涵',
  'zh-CN-XiaomengNeural': '晓梦',
  'zh-CN-XiaomoNeural': '晓墨',
  'zh-CN-XiaoruiNeural': '晓睿',
  'zh-CN-XiaoshuangNeural': '晓双',
  'zh-CN-XiaoxuanNeural': '晓萱',
  'zh-CN-XiaoyanNeural': '晓颜',
  'zh-CN-XiaozhenNeural': '晓甄',
  'zh-CN-YunfengNeural': '云枫',
  'zh-CN-YunhaoNeural': '云皓',
  'zh-CN-YunzeNeural': '云泽',
  'zh-CN-liaoning-XiaobeiNeural': '晓北(辽宁)',
  'zh-CN-shaanxi-XiaoniNeural': '晓妮(陕西)',
}

const CONCURRENCY_LABELS: Record<ConcurrencyOption, string> = {
  2: '2 个任务，同时处理更稳',
  4: '4 个任务，均衡速度和占用',
  6: '6 个任务，适合较高配置',
  8: '8 个任务，仅建议高配机器',
}

const PREFERRED_SUBTITLE_FONTS = [
  'Noto Sans CJK SC',
  'Source Han Sans SC',
  'Microsoft YaHei',
  'PingFang SC',
  'Heiti SC',
  'Arial',
] as const

const SUBTITLE_OUTPUT_MODE_LABELS: Record<SubtitleOutputMode, string> = {
  external: '生成字幕文件',
  burned: '硬嵌字幕',
}

const SUBTITLE_POSITION_LABELS: Record<SubtitlePosition, string> = {
  'top-safe': '顶部安全区',
  'bottom-safe': '底部安全区',
}

const FALLBACK_SUBTITLE_FONTS = ['Arial'] as const

const SUBTITLE_NUMBER_LIMITS: Record<SubtitleNumberField, { min: number; max: number }> = {
  fontSize: { min: 20, max: 120 },
  outlineWidth: { min: 0, max: 12 },
  backgroundOpacity: { min: 0, max: 100 },
  safeMargin: { min: 24, max: 240 },
}

function pickPreferredFont(fonts: string[]): string {
  for (const preferred of PREFERRED_SUBTITLE_FONTS) {
    const match = fonts.find((font) => font.toLocaleLowerCase() === preferred.toLocaleLowerCase())
    if (match) return match
  }
  return fonts[0] || 'Arial'
}

function clampNumber(value: string, fallback: number, min: number, max: number): number {
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function normalizeColorValue(value: string, fallback: string): string {
  const normalized = value.trim()
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized : fallback
}

function digitsOnly(value: string): string {
  return value.replace(/\D+/g, '')
}

function buildSubtitleNumberDrafts(style: SubtitleStyleConfig): Record<SubtitleNumberField, string> {
  return {
    fontSize: String(style.fontSize),
    outlineWidth: String(style.outlineWidth),
    backgroundOpacity: String(style.backgroundOpacity),
    safeMargin: String(style.safeMargin),
  }
}

function renderVoiceLabel(voiceName: string, voices: Voice[]) {
  const voice = voices.find((item) => item.name === voiceName)
  const cnName = VOICE_CN_NAMES[voiceName]
  const isFemale = voice?.gender === 'Female'

  return (
    <span className="flex items-center gap-1.5">
      {isFemale ? (
        <Venus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : (
        <Mars className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span>{cnName || voiceName}</span>
      {cnName && (
        <span className="text-xs text-muted-foreground">
          {voiceName.replace('zh-CN-', '').replace('Neural', '')}
        </span>
      )}
    </span>
  )
}

export function ConfigPanel() {
  const { config, setConfig, toggleSidebar } = useAppStore()
  const [voices, setVoices] = useState<Voice[]>([])
  const [availableFonts, setAvailableFonts] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [newEn, setNewEn] = useState('')
  const [newZh, setNewZh] = useState('')
  const [testError, setTestError] = useState('')
  const [showDeepseekKey, setShowDeepseekKey] = useState(false)
  const [deepseekKeyTesting, setDeepseekKeyTesting] = useState(false)
  const [deepseekKeyTestHint, setDeepseekKeyTestHint] = useState<{
    ok: boolean
    text: string
  } | null>(null)
  const [subtitleNumberDrafts, setSubtitleNumberDrafts] = useState<Record<SubtitleNumberField, string>>(
    () => buildSubtitleNumberDrafts(config.subtitleStyle)
  )

  const subtitleFonts = availableFonts.length > 0 ? availableFonts : FALLBACK_SUBTITLE_FONTS

  useEffect(() => {
    void window.api?.tts.getVoices().then((items) => setVoices(items || []))
    void window.api?.subtitle.listFonts().then((fonts) => setAvailableFonts(fonts || []))
  }, [])

  const setSubtitleStyle = useCallback(
    (partial: Partial<SubtitleStyleConfig>) => {
      setConfig({
        subtitleStyle: {
          ...config.subtitleStyle,
          ...partial,
        },
      })
    },
    [config.subtitleStyle, setConfig]
  )

  useEffect(() => {
    setSubtitleNumberDrafts(buildSubtitleNumberDrafts(config.subtitleStyle))
  }, [config.subtitleStyle])

  useEffect(() => {
    if (subtitleFonts.length === 0) return
    const currentFont = config.subtitleStyle.fontFamily.trim()
    if (
      currentFont &&
      subtitleFonts.some((font) => font.toLocaleLowerCase() === currentFont.toLocaleLowerCase())
    ) {
      return
    }

    const preferredFont = pickPreferredFont(subtitleFonts)
    if (preferredFont && preferredFont !== currentFont) {
      setSubtitleStyle({ fontFamily: preferredFont })
    }
  }, [config.subtitleStyle.fontFamily, setSubtitleStyle, subtitleFonts])

  const handleAddDict = useCallback(() => {
    if (!newEn.trim()) return
    setConfig({
      dictionary: [...config.dictionary, { en: newEn.trim(), zh: newZh.trim() }],
    })
    setNewEn('')
    setNewZh('')
  }, [config.dictionary, newEn, newZh, setConfig])

  const handleRemoveDict = useCallback(
    (index: number) => {
      setConfig({
        dictionary: config.dictionary.filter((_, i) => i !== index),
      })
    },
    [config.dictionary, setConfig]
  )

  const handleTestVoice = useCallback(async () => {
    if (!config.selectedVoice || testing) return
    setTesting(true)
    try {
      const buffer = await window.api?.tts.testVoice(config.selectedVoice)
      if (!buffer || buffer.byteLength === 0) {
        setTestError('语音合成返回了空数据')
        return
      }
      setTestError('')
      const blob = new Blob([buffer], { type: 'audio/mpeg' })
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.onended = () => URL.revokeObjectURL(url)
      audio.onerror = () => {
        URL.revokeObjectURL(url)
        setTestError('音频播放失败')
      }
      await audio.play()
    } catch (err: any) {
      setTestError(err?.message || '试音失败')
    } finally {
      setTesting(false)
    }
  }, [config.selectedVoice, testing])

  const handleTestDeepseekKey = useCallback(async () => {
    const key = config.deepseekKey.trim()
    if (!key || deepseekKeyTesting) return
    setDeepseekKeyTesting(true)
    setDeepseekKeyTestHint(null)
    try {
      const testKeyFn = window.api?.deepseek?.testKey
      if (!testKeyFn) {
        setDeepseekKeyTestHint({
          ok: false,
          text: '未加载 DeepSeek 接口，请完全退出应用后重新启动',
        })
        return
      }
      const result = await testKeyFn(key)
      if (!result) {
        setDeepseekKeyTestHint({ ok: false, text: '主进程无响应' })
        return
      }
      if (result.ok) {
        setDeepseekKeyTestHint({ ok: true, text: '连接成功' })
      } else {
        setDeepseekKeyTestHint({ ok: false, text: result.message || '连接失败' })
      }
    } catch (err: unknown) {
      setDeepseekKeyTestHint({
        ok: false,
        text: err instanceof Error ? err.message : '测试失败',
      })
    } finally {
      setDeepseekKeyTesting(false)
    }
  }, [config.deepseekKey, deepseekKeyTesting])

  const handleSubtitleNumberDraftChange = useCallback(
    (field: SubtitleNumberField, value: string) => {
      setSubtitleNumberDrafts((state) => ({
        ...state,
        [field]: digitsOnly(value),
      }))
    },
    []
  )

  const commitSubtitleNumberField = useCallback(
    (field: SubtitleNumberField) => {
      const limits = SUBTITLE_NUMBER_LIMITS[field]
      const fallback = config.subtitleStyle[field]
      const nextValue = clampNumber(subtitleNumberDrafts[field], fallback, limits.min, limits.max)
      setSubtitleStyle({ [field]: nextValue } as Partial<SubtitleStyleConfig>)
      setSubtitleNumberDrafts((state) => ({ ...state, [field]: String(nextValue) }))
    },
    [config.subtitleStyle, setSubtitleStyle, subtitleNumberDrafts]
  )

  const resetSubtitleStyle = useCallback(() => {
    const preferredFont = pickPreferredFont(subtitleFonts)
    const nextStyle: SubtitleStyleConfig = {
      ...DEFAULT_SUBTITLE_STYLE,
      fontFamily: preferredFont || DEFAULT_SUBTITLE_STYLE.fontFamily,
    }
    setConfig({ subtitleStyle: nextStyle })
    setSubtitleNumberDrafts(buildSubtitleNumberDrafts(nextStyle))
  }, [setConfig, subtitleFonts])

  return (
    <div className="flex h-full min-h-0 w-[360px] flex-col overflow-hidden border-r border-border bg-sidebar">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-lg font-semibold">配置</h2>
        <Button variant="ghost" size="icon-sm" onClick={toggleSidebar}>
          <PanelLeftClose className="size-4" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 p-4">
          <div className="space-y-2">
            <Label>DeepSeek API Key</Label>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Input
                  type={showDeepseekKey ? 'text' : 'password'}
                  placeholder="sk-..."
                  value={config.deepseekKey}
                  onChange={(e) => {
                    setConfig({ deepseekKey: e.target.value })
                    setDeepseekKeyTestHint(null)
                  }}
                  className="pr-10"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="absolute right-1 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => setShowDeepseekKey((value) => !value)}
                      aria-label={showDeepseekKey ? '隐藏密钥' : '显示密钥'}
                    >
                      {showDeepseekKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {showDeepseekKey ? '隐藏明文' : '显示明文'}
                  </TooltipContent>
                </Tooltip>
              </div>
              <Button
                type="button"
                variant="outline"
                size="default"
                className="shrink-0 px-3"
                disabled={!config.deepseekKey.trim() || deepseekKeyTesting}
                onClick={handleTestDeepseekKey}
              >
                <FlaskConical className="size-3.5" />
                {deepseekKeyTesting ? '测试中...' : '测试'}
              </Button>
            </div>
            {deepseekKeyTestHint && (
              <p className={`text-xs ${deepseekKeyTestHint.ok ? 'text-green-600' : 'text-red-500'}`}>
                {deepseekKeyTestHint.text}
              </p>
            )}
          </div>

          <Separator />

          <div className="space-y-3">
            <Label>字幕输出方式</Label>
            <Select
              value={config.subtitleOutputMode}
              onValueChange={(value) =>
                setConfig({ subtitleOutputMode: value as SubtitleOutputMode })
              }
            >
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

          {config.subtitleOutputMode === 'burned' && (
            <>
              <div className="space-y-4 rounded-lg border border-border bg-background/50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <Label>硬嵌字幕样式</Label>
                    <p className="text-xs text-muted-foreground">
                      硬嵌字幕会重新编码视频，速度会比外置字幕慢。字体列表来自当前系统已安装字体。
                    </p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={resetSubtitleStyle}>
                    <RotateCcw className="size-3.5" />
                    恢复默认
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label>字体</Label>
                  <FontCombobox
                    fonts={subtitleFonts}
                    value={config.subtitleStyle.fontFamily || subtitleFonts[0]}
                    onChange={(value) => setSubtitleStyle({ fontFamily: value })}
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
                      onChange={(e) => handleSubtitleNumberDraftChange('fontSize', e.target.value)}
                      onBlur={() => commitSubtitleNumberField('fontSize')}
                      onKeyDown={(e) => e.key === 'Enter' && commitSubtitleNumberField('fontSize')}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>位置</Label>
                    <Select
                      value={config.subtitleStyle.position}
                      onValueChange={(value) =>
                        setSubtitleStyle({ position: value as SubtitlePosition })
                      }
                    >
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
                      value={config.subtitleStyle.textColor}
                      onChange={(e) =>
                        setSubtitleStyle({
                          textColor: e.target.value.trim() || DEFAULT_SUBTITLE_STYLE.textColor,
                        })
                      }
                    />
                  </div>
                  <Input
                    type="color"
                    value={normalizeColorValue(
                      config.subtitleStyle.textColor,
                      DEFAULT_SUBTITLE_STYLE.textColor
                    )}
                    onChange={(e) => setSubtitleStyle({ textColor: e.target.value })}
                    className="h-10 w-16 p-1"
                  />
                </div>

                <div className="space-y-2">
                  <Label>字形</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={config.subtitleStyle.bold ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setSubtitleStyle({ bold: !config.subtitleStyle.bold })}
                    >
                      B 加粗
                    </Button>
                    <Button
                      type="button"
                      variant={config.subtitleStyle.italic ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setSubtitleStyle({ italic: !config.subtitleStyle.italic })}
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
                    checked={config.subtitleStyle.outlineEnabled}
                    onChange={(e) => setSubtitleStyle({ outlineEnabled: e.target.checked })}
                  />
                  <div className="space-y-1">
                    <div className="text-sm">描边</div>
                    <p className="text-xs text-muted-foreground">关闭后将不绘制字幕描边。</p>
                  </div>
                </label>

                {config.subtitleStyle.outlineEnabled && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>描边大小</Label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        value={subtitleNumberDrafts.outlineWidth}
                        onChange={(e) =>
                          handleSubtitleNumberDraftChange('outlineWidth', e.target.value)
                        }
                        onBlur={() => commitSubtitleNumberField('outlineWidth')}
                        onKeyDown={(e) =>
                          e.key === 'Enter' && commitSubtitleNumberField('outlineWidth')
                        }
                      />
                    </div>
                    <div className="grid grid-cols-[1fr_auto] items-end gap-3">
                      <div className="space-y-2">
                        <Label>描边颜色</Label>
                        <Input
                          value={config.subtitleStyle.outlineColor}
                          onChange={(e) =>
                            setSubtitleStyle({
                              outlineColor:
                                e.target.value.trim() || DEFAULT_SUBTITLE_STYLE.outlineColor,
                            })
                          }
                        />
                      </div>
                      <Input
                        type="color"
                        value={normalizeColorValue(
                          config.subtitleStyle.outlineColor,
                          DEFAULT_SUBTITLE_STYLE.outlineColor
                        )}
                        onChange={(e) => setSubtitleStyle({ outlineColor: e.target.value })}
                        className="h-10 w-16 p-1"
                      />
                    </div>
                  </div>
                )}

                <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background/40 px-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                    checked={config.subtitleStyle.backgroundEnabled}
                    onChange={(e) => setSubtitleStyle({ backgroundEnabled: e.target.checked })}
                  />
                  <div className="space-y-1">
                    <div className="text-sm">背景填充</div>
                    <p className="text-xs text-muted-foreground">
                      开启后为整行字幕添加背景框，颜色和透明度由背景配置控制，当前版本不提供圆角设置。
                    </p>
                  </div>
                </label>

                {config.subtitleStyle.backgroundEnabled && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid grid-cols-[1fr_auto] items-end gap-3">
                      <div className="space-y-2">
                        <Label>背景颜色</Label>
                        <Input
                          value={config.subtitleStyle.backgroundColor}
                          onChange={(e) =>
                            setSubtitleStyle({
                              backgroundColor:
                                e.target.value.trim() || DEFAULT_SUBTITLE_STYLE.backgroundColor,
                            })
                          }
                        />
                      </div>
                      <Input
                        type="color"
                        value={normalizeColorValue(
                          config.subtitleStyle.backgroundColor,
                          DEFAULT_SUBTITLE_STYLE.backgroundColor
                        )}
                        onChange={(e) => setSubtitleStyle({ backgroundColor: e.target.value })}
                        className="h-10 w-16 p-1"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>背景透明度</Label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        value={subtitleNumberDrafts.backgroundOpacity}
                        onChange={(e) =>
                          handleSubtitleNumberDraftChange('backgroundOpacity', e.target.value)
                        }
                        onBlur={() => commitSubtitleNumberField('backgroundOpacity')}
                        onKeyDown={(e) =>
                          e.key === 'Enter' && commitSubtitleNumberField('backgroundOpacity')
                        }
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
                    onChange={(e) => handleSubtitleNumberDraftChange('safeMargin', e.target.value)}
                    onBlur={() => commitSubtitleNumberField('safeMargin')}
                    onKeyDown={(e) => e.key === 'Enter' && commitSubtitleNumberField('safeMargin')}
                  />
                  <p className="text-xs text-muted-foreground">
                    控制字幕距离顶部或底部安全区的边距，单位为像素。
                  </p>
                </div>
              </div>

              <Separator />
            </>
          )}

          <div className="space-y-2">
            <Label>术语词典</Label>
            <p className="text-xs text-muted-foreground">翻译时保留专业术语原意。</p>
            {config.dictionary.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[120px]">英文</TableHead>
                    <TableHead className="w-[120px]">中文</TableHead>
                    <TableHead className="w-[40px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {config.dictionary.map((item, index) => (
                    <TableRow key={index}>
                      <TableCell className="py-1">{item.en}</TableCell>
                      <TableCell className="py-1">{item.zh}</TableCell>
                      <TableCell className="py-1">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => handleRemoveDict(index)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="flex items-center gap-2">
              <Input
                placeholder="英文"
                value={newEn}
                onChange={(e) => setNewEn(e.target.value)}
                className="min-w-0 flex-1"
                onKeyDown={(e) => e.key === 'Enter' && handleAddDict()}
              />
              <Input
                placeholder="中文"
                value={newZh}
                onChange={(e) => setNewZh(e.target.value)}
                className="min-w-0 flex-1"
                onKeyDown={(e) => e.key === 'Enter' && handleAddDict()}
              />
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                onClick={handleAddDict}
                aria-label="添加术语"
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Edge TTS 声音</Label>
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <Select
                  value={config.selectedVoice}
                  onValueChange={(value) => setConfig({ selectedVoice: value })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="选择声音...">
                      {config.selectedVoice
                        ? renderVoiceLabel(config.selectedVoice, voices)
                        : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {voices.map((voice) => (
                      <SelectItem key={voice.name} value={voice.name}>
                        {renderVoiceLabel(voice.name, voices)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                size="default"
                className="shrink-0 px-3"
                onClick={handleTestVoice}
                disabled={!config.selectedVoice || testing}
              >
                <Volume2 className="size-3.5" />
                {testing ? '播放中...' : '试听'}
              </Button>
            </div>
            {testError && <p className="text-xs text-red-500">{testError}</p>}
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>同时处理视频数</Label>
            <Select
              value={String(config.maxConcurrentTasks)}
              onValueChange={(value) =>
                setConfig({ maxConcurrentTasks: Number(value) as ConcurrencyOption })
              }
            >
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
            <p className="text-xs text-muted-foreground">
              不支持手动输入，避免设置过大导致软件卡顿或崩溃。默认建议 2。
            </p>
          </div>

          <Separator />

          <div className="space-y-3">
            <Label>字幕审校模式</Label>
            <RadioGroup
              value={config.reviewMode}
              onValueChange={(value: string) => setConfig({ reviewMode: value as ReviewMode })}
            >
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
            {config.reviewMode === 'auto' && (
              <div className="flex items-center gap-2 pl-6">
                <Label className="shrink-0 text-sm text-muted-foreground">倒计时</Label>
                <Input
                  type="number"
                  min={5}
                  max={300}
                  value={config.autoReviewCountdown}
                  onChange={(e) =>
                    setConfig({
                      autoReviewCountdown: clampNumber(
                        e.target.value,
                        config.autoReviewCountdown,
                        5,
                        300
                      ),
                    })
                  }
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
                checked={config.createVideoSubfolder}
                onChange={(e) => setConfig({ createVideoSubfolder: e.target.checked })}
              />
              <div className="space-y-1">
                <div className="text-sm">为每个视频单独创建文件夹</div>
                <p className="text-xs text-muted-foreground">
                  开启后，视频和字幕放进各自子文件夹；关闭后，所有输出直接放在所选输出目录下。
                </p>
              </div>
            </label>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
