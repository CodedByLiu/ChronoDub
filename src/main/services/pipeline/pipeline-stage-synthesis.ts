import type { AppConfig, Cue } from '../../types'
import type { ProcessedAudio } from './audio-processing'
import { TRANSLATION_STRATEGY_VERSION } from './translator'
import { synthesizeWithFallback, type AssemblerSegment, type SegmentRisk } from './audio-processor'
import { checkCancelled, checkPaused } from './pipeline-control'
import { reportProgress, withTimeout } from './pipeline-progress'
import { shouldApplySpokenTextRewrite } from './pipeline-review'
import { SYNTHESIS_SEGMENT_TIMEOUT_MS } from './pipeline-store'
import {
  hashSegmentText,
  loadCachedSegment,
  resolveCacheDir,
  saveCachedSegment,
} from './segment-cache'
import { retimeSegmentCues } from './subtitle-timing'
import {
  hasSpeakableContent,
  joinCueTextsForSpeech,
  splitSegmentTextAcrossCues,
} from './subtitle-text-utils'
import type { SynthesisStageResult, TranslationStageResult } from './pipeline-stage-types'

const EMPTY_AUDIO_ERROR_RE = /TTS (?:生成空音频文件|未生成音频文件)/

function isEmptyAudioError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return EMPTY_AUDIO_ERROR_RE.test(message)
}

function buildSynthesisConfigSignature(config: AppConfig): string {
  return JSON.stringify({
    strategyVersion: TRANSLATION_STRATEGY_VERSION,
    voice: config.selectedVoice.trim(),
  })
}

interface SynthesisStageContext {
  taskId: string
  videoPath: string
  config: AppConfig
  translation: TranslationStageResult
}

export async function runSynthesisStage(context: SynthesisStageContext): Promise<SynthesisStageResult> {
  const { taskId, videoPath, config, translation } = context
  const { englishCues, reviewedCues, segments, windows, segmentRiskMap } = translation

  const finalizedCueMap = new Map<number, Cue>(reviewedCues.map((cue) => [cue.id, { ...cue }]))
  const assemblerSegments: AssemblerSegment[] = []
  const totalSegments = segments.length
  const synthesisConfigSignature = buildSynthesisConfigSignature(config)
  const cacheDir = resolveCacheDir(config.outputDir, videoPath)

  reportProgress(taskId, 'synthesizing', 55, '正在准备音频合成')

  for (let i = 0; i < totalSegments; i++) {
    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    const seg = segments[i]
    const win = windows[i]
    const text = joinCueTextsForSpeech([seg.textZh || ''])
    seg.textZh = text

    const segmentCues = seg.cueIds
      .map((cueId) => finalizedCueMap.get(cueId))
      .filter((cue): cue is Cue => !!cue)
    const synthProgress = 55 + Math.round(((i + 1) / totalSegments) * 25)
    const segmentDetail = `正在合成音频片段 ${i + 1}/${totalSegments}`
    reportProgress(taskId, 'synthesizing', Math.max(55, synthProgress - 1), segmentDetail)

    if (!text.trim() || !hasSpeakableContent(text)) {
      assemblerSegments.push({
        startUs: win.startUs,
        deadlineUs: win.deadlineUs,
        pcm: Buffer.alloc(0),
      })
      continue
    }

    const textHash = hashSegmentText(text)
    let audio: ProcessedAudio | null = cacheDir
      ? loadCachedSegment(cacheDir, taskId, seg.id, synthesisConfigSignature, textHash)?.audio ?? null
      : null

    if (!audio) {
      try {
        audio = await withTimeout(
          synthesizeWithFallback({
            text,
            windowUs: win.windowUs,
            voice: config.selectedVoice,
            llm: config.llm,
            risk: (segmentRiskMap.get(seg.id) ?? 'medium') as SegmentRisk,
          }),
          SYNTHESIS_SEGMENT_TIMEOUT_MS,
          `音频合成超时：第 ${i + 1}/${totalSegments} 段超过 ${Math.round(SYNTHESIS_SEGMENT_TIMEOUT_MS / 1000)} 秒`
        )
      } catch (err) {
        if (!isEmptyAudioError(err)) throw err
        console.warn(
          `[synthesis] segment ${i + 1}/${totalSegments} produced empty TTS audio after retries, filling silence. text=${JSON.stringify(text)}`
        )
        assemblerSegments.push({
          startUs: win.startUs,
          deadlineUs: win.deadlineUs,
          pcm: Buffer.alloc(0),
        })
        reportProgress(taskId, 'synthesizing', synthProgress, segmentDetail)
        continue
      }

      if (cacheDir) {
        try {
          saveCachedSegment(cacheDir, taskId, seg.id, synthesisConfigSignature, textHash, audio)
        } catch (err) {
          console.error(`Failed to persist segment cache [${taskId}#${seg.id}]:`, err)
        }
      }
    }

    const spokenText = audio.spokenText || text
    assemblerSegments.push({
      startUs: win.startUs,
      deadlineUs: win.deadlineUs,
      pcm: audio.pcm,
    })

    let segmentOutputCues = segmentCues.map((cue) => ({ ...cue }))
    if (shouldApplySpokenTextRewrite(text, spokenText)) {
      const spokenCueTexts = splitSegmentTextAcrossCues(spokenText, segmentOutputCues)
      segmentOutputCues = segmentOutputCues.map((cue, index) => ({
        ...cue,
        text: spokenCueTexts[index] || '',
      }))
    }

    const retimedSegmentCues = retimeSegmentCues(seg, win, segmentOutputCues, audio)
    for (const cue of retimedSegmentCues) {
      finalizedCueMap.set(cue.id, cue)
    }

    reportProgress(taskId, 'synthesizing', synthProgress, segmentDetail)
  }

  const finalizedCues = englishCues.map((cue) => finalizedCueMap.get(cue.id) || cue)
  checkCancelled(taskId)
  await checkPaused(taskId)
  checkCancelled(taskId)

  return {
    finalizedCues,
    assemblerSegments,
  }
}
