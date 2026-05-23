import { useCallback, useEffect, useState } from 'react'
import { PanelLeftClose } from 'lucide-react'
import type {
  ConcurrencyOption,
  LLMConfig,
  ReviewMode,
  SubtitleOutputMode,
  SubtitleStyleConfig,
} from '../types'
import { DEFAULT_SUBTITLE_STYLE } from '../types'
import { useAppStore } from '../stores/app-store'
import { Button } from './ui/button'
import { ScrollArea } from './ui/scroll-area'
import { Separator } from './ui/separator'
import { LLMSection } from './config-panel/LLMSection'
import { SubtitleOutputSection } from './config-panel/SubtitleOutputSection'
import { DictionarySection } from './config-panel/DictionarySection'
import { QualityVoiceSection } from './config-panel/QualityVoiceSection'
import { RuntimeSections } from './config-panel/RuntimeSections'
import { FALLBACK_SUBTITLE_FONTS, SUBTITLE_NUMBER_LIMITS, type SubtitleNumberField } from './config-panel/constants'
import {
  buildSubtitleNumberDrafts,
  clampNumber,
  digitsOnly,
  pickPreferredFont,
  renderVoiceLabel,
  type Voice,
} from './config-panel/helpers'

export function ConfigPanel() {
  const { config, setConfig, toggleSidebar } = useAppStore()
  const [voices, setVoices] = useState<Voice[]>([])
  const [availableFonts, setAvailableFonts] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [newEn, setNewEn] = useState('')
  const [newZh, setNewZh] = useState('')
  const [testError, setTestError] = useState('')
  const [showLLMKey, setShowLLMKey] = useState(false)
  const [llmTesting, setLLMTesting] = useState(false)
  const [llmTestHint, setLLMTestHint] = useState<{ ok: boolean; text: string } | null>(null)
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
          ...DEFAULT_SUBTITLE_STYLE,
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
      setTestError(err?.message || '试听失败')
    } finally {
      setTesting(false)
    }
  }, [config.selectedVoice, testing])

  const handleTestLLM = useCallback(async () => {
    const baseUrl = config.llm.baseUrl.trim()
    const model = config.llm.model.trim()
    const apiKey = config.llm.apiKey.trim()
    if (!baseUrl || !model || !apiKey || llmTesting) return
    setLLMTesting(true)
    setLLMTestHint(null)
    try {
      const testFn = window.api?.llm?.test
      if (!testFn) {
        setLLMTestHint({ ok: false, text: '未加载 LLM 接口，请完全退出应用后重新启动' })
        return
      }
      const result = await testFn({ baseUrl, model, apiKey })
      if (!result) {
        setLLMTestHint({ ok: false, text: '主进程无响应' })
        return
      }
      setLLMTestHint(result.ok ? { ok: true, text: '连接成功' } : { ok: false, text: result.message || '连接失败' })
    } catch (err: unknown) {
      setLLMTestHint({ ok: false, text: err instanceof Error ? err.message : '测试失败' })
    } finally {
      setLLMTesting(false)
    }
  }, [config.llm, llmTesting])

  const handleChangeLLM = useCallback(
    (partial: Partial<LLMConfig>) => {
      setConfig({ llm: { ...config.llm, ...partial } })
      setLLMTestHint(null)
    },
    [config.llm, setConfig]
  )

  const handleSubtitleNumberDraftChange = useCallback((field: SubtitleNumberField, value: string) => {
    setSubtitleNumberDrafts((state) => ({
      ...state,
      [field]: digitsOnly(value),
    }))
  }, [])

  const commitSubtitleNumberField = useCallback(
    (field: SubtitleNumberField) => {
      const limits = SUBTITLE_NUMBER_LIMITS[field]
      const fallback = config.subtitleStyle[field] ?? DEFAULT_SUBTITLE_STYLE[field]
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
          <LLMSection
            llm={config.llm}
            showKey={showLLMKey}
            testing={llmTesting}
            hint={llmTestHint}
            onChangeLLM={handleChangeLLM}
            onToggleShowKey={() => setShowLLMKey((value) => !value)}
            onTest={handleTestLLM}
          />

          <Separator />

          <SubtitleOutputSection
            outputMode={config.subtitleOutputMode}
            style={config.subtitleStyle}
            subtitleFonts={subtitleFonts}
            subtitleNumberDrafts={subtitleNumberDrafts}
            onChangeOutputMode={(mode) => setConfig({ subtitleOutputMode: mode as SubtitleOutputMode })}
            onSetStyle={setSubtitleStyle}
            onResetStyle={resetSubtitleStyle}
            onDraftChange={handleSubtitleNumberDraftChange}
            onDraftCommit={commitSubtitleNumberField}
          />

          <DictionarySection
            dictionary={config.dictionary}
            newEn={newEn}
            newZh={newZh}
            onChangeNewEn={setNewEn}
            onChangeNewZh={setNewZh}
            onAdd={handleAddDict}
            onRemove={handleRemoveDict}
          />

          <QualityVoiceSection
            selectedVoice={config.selectedVoice}
            voices={voices}
            voiceTesting={testing}
            voiceTestError={testError}
            onChangeVoice={(voice) => setConfig({ selectedVoice: voice })}
            onTestVoice={handleTestVoice}
            renderVoiceLabel={renderVoiceLabel}
          />

          <Separator />

          <RuntimeSections
            maxConcurrentTasks={config.maxConcurrentTasks}
            reviewMode={config.reviewMode}
            autoReviewCountdown={config.autoReviewCountdown}
            createVideoSubfolder={config.createVideoSubfolder}
            useLLMSentenceGrouping={config.useLLMSentenceGrouping}
            useLLMChineseSegmentation={config.useLLMChineseSegmentation}
            hasLLMKey={config.llm.apiKey.trim().length > 0}
            onChangeConcurrent={(value) => setConfig({ maxConcurrentTasks: value as ConcurrencyOption })}
            onChangeReviewMode={(value) => setConfig({ reviewMode: value as ReviewMode })}
            onChangeAutoReviewCountdown={(value) =>
              setConfig({
                autoReviewCountdown: Math.max(5, Math.min(300, Number.isFinite(value) ? value : config.autoReviewCountdown)),
              })
            }
            onChangeCreateVideoSubfolder={(value) => setConfig({ createVideoSubfolder: value })}
            onChangeUseLLMSentenceGrouping={(value) => setConfig({ useLLMSentenceGrouping: value })}
            onChangeUseLLMChineseSegmentation={(value) => setConfig({ useLLMChineseSegmentation: value })}
          />
        </div>
      </ScrollArea>
    </div>
  )
}
