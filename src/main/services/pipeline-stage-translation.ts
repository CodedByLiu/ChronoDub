import type { AppConfig, Cue, Segment } from '../../types'
import { parseSubtitleFile } from './subtitle-parser'
import {
  applyTerminologyToChinese,
  isAcceptableTranslatedText,
  translateSegments,
} from './deepseek'
import { ffprobe } from './ffmpeg'
import {
  assignBudgets,
  buildSegments,
  buildSegmentsFromGroups,
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
import {
  computeGroupingSignature,
  groupSentencesWithLLM,
} from './sentence-grouper'
import {
  loadSentenceGroupCache,
  resolveCacheDir,
  saveSentenceGroupCache,
} from './segment-cache'
import type { TranslationStageResult, PipelineStageContext } from './pipeline-stage-types'

function mapTranslatedCues(
  englishCues: Cue[],
  segments: Segment[],
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
  segments: Segment[],
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
  const cacheDir = resolveCacheDir(config.outputDir, videoPath)
  let groupingSignature: string | undefined
  let segments: Segment[]
  if (config.useLLMSentenceGrouping && config.deepseekKey.trim().length > 0) {
    groupingSignature = computeGroupingSignature(englishCues)
    const cachedGroups = cacheDir
      ? loadSentenceGroupCache(cacheDir, taskId, groupingSignature)
      : null
    const { groups, usedFallback } = await groupSentencesWithLLM(englishCues, {
      apiKey: config.deepseekKey,
      cachedGroups,
      betweenChunks: async () => {
        await checkPaused(taskId)
        checkCancelled(taskId)
      },
    })
    segments = buildSegmentsFromGroups(englishCues, groups)
    if (cacheDir && !usedFallback && !cachedGroups) {
      try {
        saveSentenceGroupCache(cacheDir, taskId, groupingSignature, groups)
      } catch (err) {
        console.error(`Failed to persist sentence-group cache [${taskId}]:`, err)
      }
    }
  } else {
    segments = buildSegments(englishCues)
  }
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
  const translationConfigSignature = buildTranslationConfigSignature(config, groupingSignature)
  const translations = getTaskSegmentTranslations(taskId, translationConfigSignature)
  const pendingSegments = segments.filter((segment) => {
    const cached = translations.get(segment.id)
    if (typeof cached !== 'string') return true
    if (!isAcceptableTranslatedText(segment.textEn, cached, segmentBudgetMap.get(segment.id))) {
      translations.delete(segment.id)
      return true
    }
    return false
  })

  const stageIssues: Array<{ id: number; text: string; max_chars?: number }> = []

  if (pendingSegments.length > 0) {
    const pendingBudgetMap = new Map<number, number>()
    for (const segment of pendingSegments) {
      const budget = segmentBudgetMap.get(segment.id)
      if (budget !== undefined) pendingBudgetMap.set(segment.id, budget)
    }

    const outcome = await translateSegments(
      pendingSegments.map((segment) => ({ id: segment.id, text: segment.textEn })),
      config.deepseekKey,
      config.dictionary,
      pendingBudgetMap.size > 0 ? pendingBudgetMap : undefined,
      async () => {
        await checkPaused(taskId)
        checkCancelled(taskId)
      }
    )

    for (const [id, text] of outcome.translations) {
      translations.set(id, text)
    }
    setTaskSegmentTranslations(
      taskId,
      translationConfigSignature,
      translations,
      config.outputDir,
      videoPath
    )
    for (const issue of outcome.issues) stageIssues.push(issue)
  }

  const missingSegmentIds = segments
    .filter((segment) => typeof translations.get(segment.id) !== 'string')
    .map((segment) => segment.id)
  if (missingSegmentIds.length > 0) {
    throw new Error(`字幕翻译结果缺失：segment ${missingSegmentIds.join(', ')}`)
  }

  setTaskTranslationIssues(taskId, stageIssues)
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
