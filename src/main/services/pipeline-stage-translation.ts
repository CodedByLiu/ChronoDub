import type { AppConfig, Cue } from '../../types'
import { parseSubtitleFile } from './subtitle-parser'
import {
  applyTerminologyToChinese,
  isAcceptableTranslatedText,
  translateSegments,
  TranslationIncompleteError,
} from './deepseek'
import { ffprobe } from './ffmpeg'
import {
  assignBudgets,
  buildSegments,
  buildTimeWindows,
  calibrateCPS,
  classifySegmentRisk,
  type SegmentRisk,
} from './audio-processor'
import {
  computeSegmentTranslationBudget,
} from './subtitle-timing'
import { joinCueTextsForSpeech, splitSegmentTextAcrossCues } from './subtitle-text-utils'
import { checkCancelled, checkPaused } from './pipeline-control'
import { reportProgress } from './pipeline-progress'
import {
  buildTranslationConfigSignature,
  getTaskSegmentTranslations,
  setTaskSegmentTranslations,
  setTaskTranslationIssues,
} from './pipeline-translation-cache'
import { reviewCheckpoint } from './pipeline-review'
import type { TranslationStageResult, PipelineStageContext } from './pipeline-stage-types'

function mapTranslatedCues(
  englishCues: Cue[],
  segments: ReturnType<typeof buildSegments>,
  translations: Map<number, string>,
  config: AppConfig
): Cue[] {
  const englishCueMap = new Map<number, Cue>(englishCues.map((cue) => [cue.id, cue]))
  const translatedCueTextMap = new Map<number, string>()

  for (const segment of segments) {
    const raw = translations.get(segment.id)
    if (typeof raw !== 'string') {
      throw new Error(`字幕翻译结果缺失：segment ${segment.id}`)
    }
    const segmentText = applyTerminologyToChinese(segment.textEn, raw, config.dictionary)
    const segmentCues = segment.cueIds
      .map((cueId) => englishCueMap.get(cueId))
      .filter((cue): cue is Cue => !!cue)
    const cueTexts = splitSegmentTextAcrossCues(segmentText, segmentCues)

    segmentCues.forEach((cue, index) => {
      translatedCueTextMap.set(cue.id, cueTexts[index] || '')
    })
  }

  const missingCueIds = englishCues
    .filter((cue) => !translatedCueTextMap.has(cue.id))
    .map((cue) => cue.id)
  if (missingCueIds.length > 0) {
    throw new Error(`字幕翻译映射缺失，仍有 ${missingCueIds.length} 条未写回（id: ${missingCueIds.join(', ')}）`)
  }

  return englishCues.map((cue) => ({
    ...cue,
    text: translatedCueTextMap.get(cue.id) ?? '',
  }))
}

function buildBudgetMaps(
  segments: ReturnType<typeof buildSegments>,
  windows: ReturnType<typeof buildTimeWindows>
): {
  segmentRiskMap: Map<number, SegmentRisk>
  segmentBudgetMap: Map<number, number>
} {
  const segmentRiskMap = new Map<number, SegmentRisk>()
  for (const window of windows) {
    const segment = segments[window.segmentId]
    segmentRiskMap.set(segment.id, classifySegmentRisk(segment, window.windowUs))
  }

  const segmentBudgetMap = new Map<number, number>()
  for (const window of windows) {
    const risk = segmentRiskMap.get(window.segmentId) ?? 'medium'
    segmentBudgetMap.set(window.segmentId, computeSegmentTranslationBudget(window.budgetChars, risk))
  }

  return { segmentRiskMap, segmentBudgetMap }
}

export async function runTranslationStage(context: PipelineStageContext): Promise<TranslationStageResult> {
  const { taskId, videoPath, subtitlePath, config } = context

  reportProgress(taskId, 'parsing', 5)
  const englishCues = parseSubtitleFile(subtitlePath)
  if (englishCues.length === 0) throw new Error('字幕文件为空或解析失败')
  checkCancelled(taskId)
  await checkPaused(taskId)
  checkCancelled(taskId)

  reportProgress(taskId, 'parsing', 10)
  const segments = buildSegments(englishCues)
  checkCancelled(taskId)
  await checkPaused(taskId)
  checkCancelled(taskId)

  await checkPaused(taskId)
  checkCancelled(taskId)
  const probeResult = await ffprobe(videoPath)
  const windows = buildTimeWindows(segments, probeResult.durationUs)
  checkCancelled(taskId)
  await checkPaused(taskId)
  checkCancelled(taskId)

  reportProgress(taskId, 'parsing', 15)
  const cps = await calibrateCPS(config.selectedVoice)
  checkCancelled(taskId)
  await checkPaused(taskId)
  checkCancelled(taskId)

  assignBudgets(windows, cps)
  const { segmentRiskMap, segmentBudgetMap } = buildBudgetMaps(segments, windows)

  reportProgress(taskId, 'translating', 20)
  const translationConfigSignature = buildTranslationConfigSignature(config)
  const translations = getTaskSegmentTranslations(taskId, translationConfigSignature)
  const pendingSegments = segments.filter((segment) => {
    const cached = translations.get(segment.id)
    if (typeof cached !== 'string') return true
    if (!isAcceptableTranslatedText(segment.textEn, cached)) {
      translations.delete(segment.id)
      return true
    }
    return false
  })

  if (pendingSegments.length > 0) {
    const pendingBudgetMap = new Map<number, number>()
    for (const segment of pendingSegments) {
      const budget = segmentBudgetMap.get(segment.id)
      if (budget !== undefined) pendingBudgetMap.set(segment.id, budget)
    }

    try {
      const translatedPending = await translateSegments(
        pendingSegments.map((segment) => ({ id: segment.id, text: segment.textEn })),
        config.deepseekKey,
        config.dictionary,
        pendingBudgetMap.size > 0 ? pendingBudgetMap : undefined,
        async () => {
          await checkPaused(taskId)
          checkCancelled(taskId)
        }
      )

      for (const [id, text] of translatedPending) {
        translations.set(id, text)
      }
      setTaskSegmentTranslations(taskId, translationConfigSignature, translations)
    } catch (err) {
      if (err instanceof TranslationIncompleteError) {
        for (const [id, text] of err.partialTranslations) {
          translations.set(id, text)
        }
        setTaskSegmentTranslations(taskId, translationConfigSignature, translations)
        setTaskTranslationIssues(taskId, err.unresolvedItems)
      }
      throw err
    }
  }

  const unresolvedSegments = segments.filter((segment) => {
    const translated = translations.get(segment.id)
    return typeof translated !== 'string' || !isAcceptableTranslatedText(segment.textEn, translated)
  })
  if (unresolvedSegments.length > 0) {
    const unresolvedItems = unresolvedSegments.map((segment) => {
      const maxChars = segmentBudgetMap.get(segment.id)
      return {
        id: segment.id,
        text: segment.textEn,
        ...(typeof maxChars === 'number' ? { max_chars: maxChars } : {}),
      }
    })
    setTaskTranslationIssues(taskId, unresolvedItems)
    throw new TranslationIncompleteError(
      `DeepSeek translation result is incomplete. ${unresolvedItems.length} item(s) still unresolved (id: ${unresolvedItems
        .map((item) => item.id)
        .join(', ')}).`,
      translations,
      unresolvedItems
    )
  }

  setTaskTranslationIssues(taskId, [])
  checkCancelled(taskId)
  await checkPaused(taskId)
  checkCancelled(taskId)

  const chineseCues = mapTranslatedCues(englishCues, segments, translations, config)
  reportProgress(taskId, 'translating', 45)

  await checkPaused(taskId)
  checkCancelled(taskId)
  const reviewedCues = await reviewCheckpoint(taskId, englishCues, chineseCues, config)
  checkCancelled(taskId)
  await checkPaused(taskId)
  checkCancelled(taskId)

  const reviewedCueTextMap = new Map<number, string>(reviewedCues.map((cue) => [cue.id, cue.text]))
  for (const segment of segments) {
    segment.textZh = joinCueTextsForSpeech(segment.cueIds.map((id) => reviewedCueTextMap.get(id) || ''))
  }

  return {
    englishCues,
    segments,
    windows,
    probeResult,
    segmentRiskMap,
    reviewedCues,
  }
}
