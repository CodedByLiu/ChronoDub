import type { AppConfig, Cue } from '../../types'
import { synthesizeWithFallback, type AssemblerSegment, type SegmentRisk } from './audio-processor'
import { checkCancelled, checkPaused } from './pipeline-control'
import { reportProgress, withTimeout } from './pipeline-progress'
import { shouldApplySpokenTextRewrite } from './pipeline-review'
import { SYNTHESIS_SEGMENT_TIMEOUT_MS } from './pipeline-store'
import { retimeSegmentCues } from './subtitle-timing'
import { joinCueTextsForSpeech, splitSegmentTextAcrossCues } from './subtitle-text-utils'
import type { SynthesisStageResult, TranslationStageResult } from './pipeline-stage-types'

interface SynthesisStageContext {
  taskId: string
  config: AppConfig
  translation: TranslationStageResult
}

export async function runSynthesisStage(context: SynthesisStageContext): Promise<SynthesisStageResult> {
  const { taskId, config, translation } = context
  const { englishCues, reviewedCues, segments, windows, segmentRiskMap } = translation

  const finalizedCueMap = new Map<number, Cue>(reviewedCues.map((cue) => [cue.id, { ...cue }]))
  const assemblerSegments: AssemblerSegment[] = []
  const totalSegments = segments.length

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

    if (!text.trim()) {
      assemblerSegments.push({
        startUs: win.startUs,
        deadlineUs: win.deadlineUs,
        pcm: Buffer.alloc(0),
      })
      continue
    }

    const audio = await withTimeout(
      synthesizeWithFallback({
        text,
        windowUs: win.windowUs,
        voice: config.selectedVoice,
        apiKey: config.deepseekKey,
        risk: (segmentRiskMap.get(seg.id) ?? 'medium') as SegmentRisk,
      }),
      SYNTHESIS_SEGMENT_TIMEOUT_MS,
      `音频合成超时：第 ${i + 1}/${totalSegments} 段超过 ${Math.round(SYNTHESIS_SEGMENT_TIMEOUT_MS / 1000)} 秒`
    )

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
