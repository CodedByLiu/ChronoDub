import { useState, useEffect, useCallback } from 'react'
import { useAppStore } from '../stores/app-store'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { Separator } from './ui/separator'
import { ScrollArea } from './ui/scroll-area'
import { RadioGroup, RadioGroupItem } from './ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table'
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
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import type { ReviewMode } from '../types'

interface Voice {
  name: string
  locale: string
  gender: string
}

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

export function ConfigPanel() {
  const { config, setConfig, toggleSidebar } = useAppStore()
  const [voices, setVoices] = useState<Voice[]>([])
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

  useEffect(() => {
    window.api?.tts.getVoices().then(setVoices)
  }, [])

  const handleAddDict = useCallback(() => {
    if (!newEn.trim()) return
    setConfig({
      dictionary: [...config.dictionary, { en: newEn.trim(), zh: newZh.trim() }],
    })
    setNewEn('')
    setNewZh('')
  }, [newEn, newZh, config.dictionary, setConfig])

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
        setTestError('语音合成返回空数据')
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
      setTestError(err?.message || '试听失败')
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

  return (
    <div className="w-[360px] h-full border-r flex flex-col bg-sidebar">
      <div className="flex items-center justify-between px-4 h-14 border-b shrink-0">
        <h2 className="font-semibold text-lg">配置</h2>
        <Button variant="ghost" size="icon-sm" onClick={toggleSidebar}>
          <PanelLeftClose className="size-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-6">
          <div className="space-y-2">
            <Label>DeepSeek API Key</Label>
            <div className="flex gap-2 items-start">
              <div className="relative flex-1 min-w-0">
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
                      className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => setShowDeepseekKey((v) => !v)}
                      aria-label={showDeepseekKey ? '隐藏密钥' : '显示密钥'}
                    >
                      {showDeepseekKey ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
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
                size="sm"
                className="shrink-0"
                disabled={!config.deepseekKey.trim() || deepseekKeyTesting}
                onClick={handleTestDeepseekKey}
              >
                <FlaskConical className="size-3.5" />
                {deepseekKeyTesting ? '测试中…' : '测试'}
              </Button>
            </div>
            {deepseekKeyTestHint && (
              <p
                className={`text-xs ${deepseekKeyTestHint.ok ? 'text-green-600' : 'text-red-500'}`}
              >
                {deepseekKeyTestHint.text}
              </p>
            )}
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>术语词典</Label>
            <p className="text-xs text-muted-foreground">翻译时保留专业术语原文</p>
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
            <div className="flex gap-2">
              <Input
                placeholder="English"
                value={newEn}
                onChange={(e) => setNewEn(e.target.value)}
                className="flex-1"
                onKeyDown={(e) => e.key === 'Enter' && handleAddDict()}
              />
              <Input
                placeholder="中文"
                value={newZh}
                onChange={(e) => setNewZh(e.target.value)}
                className="flex-1"
                onKeyDown={(e) => e.key === 'Enter' && handleAddDict()}
              />
              <Button variant="outline" size="sm" onClick={handleAddDict}>
                <Plus className="size-3" />
              </Button>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Edge TTS 声音</Label>
            <div className="flex gap-2">
              <Select
                value={config.selectedVoice}
                onValueChange={(v) => setConfig({ selectedVoice: v })}
              >
                <SelectTrigger className="w-full flex-1">
                  <SelectValue placeholder="选择声音...">
                    {config.selectedVoice && (() => {
                      const v = voices.find((x) => x.name === config.selectedVoice)
                      const cnName = VOICE_CN_NAMES[config.selectedVoice]
                      const isFemale = v?.gender === 'Female'
                      return (
                        <span className="flex items-center gap-1.5">
                          {isFemale ? (
                            <Venus className="size-3.5 shrink-0 text-pink-500" aria-hidden />
                          ) : (
                            <Mars className="size-3.5 shrink-0 text-blue-500" aria-hidden />
                          )}
                          <span>{cnName || config.selectedVoice}</span>
                        </span>
                      )
                    })()}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {voices.map((v) => {
                    const cnName = VOICE_CN_NAMES[v.name]
                    const isFemale = v.gender === 'Female'
                    return (
                      <SelectItem key={v.name} value={v.name}>
                        <span className="flex items-center gap-1.5">
                          {isFemale ? (
                            <Venus className="size-3.5 shrink-0 text-pink-500" aria-hidden />
                          ) : (
                            <Mars className="size-3.5 shrink-0 text-blue-500" aria-hidden />
                          )}
                          <span>{cnName || v.name}</span>
                          {cnName && (
                            <span className="text-muted-foreground text-xs">{v.name.replace('zh-CN-', '').replace('Neural', '')}</span>
                          )}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestVoice}
                disabled={!config.selectedVoice || testing}
              >
                <Volume2 className="size-3" />
                {testing ? '播放中...' : '试听'}
              </Button>
            </div>
            {testError && (
              <p className="text-xs text-red-500">{testError}</p>
            )}
          </div>

          <Separator />

          <div className="space-y-3">
            <Label>字幕审校模式</Label>
            <RadioGroup
              value={config.reviewMode}
              onValueChange={(v: string) => setConfig({ reviewMode: v as ReviewMode })}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="auto" id="mode-auto" />
                <Label htmlFor="mode-auto" className="font-normal cursor-pointer">
                  自动模式
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="manual" id="mode-manual" />
                <Label htmlFor="mode-manual" className="font-normal cursor-pointer">
                  手动模式
                </Label>
              </div>
            </RadioGroup>
            {config.reviewMode === 'auto' && (
              <div className="flex items-center gap-2 pl-6">
                <Label className="text-sm text-muted-foreground shrink-0">倒计时</Label>
                <Input
                  type="number"
                  min={5}
                  max={300}
                  value={config.autoReviewCountdown}
                  onChange={(e) =>
                    setConfig({ autoReviewCountdown: parseInt(e.target.value) || 30 })
                  }
                  className="w-20"
                />
                <span className="text-sm text-muted-foreground">秒</span>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
