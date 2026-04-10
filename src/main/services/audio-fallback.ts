import type { MicrosecondTimestamp } from '../../types'
import { compressTranslation } from './deepseek'
import {
  clipProcessedAudioToWindow,
  synthesizeProcessedText,
  type ProcessedAudio,
} from './audio-processing'
import {
  MAX_RETRIES_PER_LEVEL,
  MAX_SLIGHT_RATE_OVERRUN,
  SLIGHT_RATE_STEPS,
} from './audio-constants'
import type { SegmentRisk } from './audio-risk'

export interface FallbackContext {
  text: string
  windowUs: MicrosecondTimestamp
  voice: string
  apiKey: string
  risk: SegmentRisk
}

export async function synthesizeWithFallback(ctx: FallbackContext): Promise<ProcessedAudio> {
  let bestResult = await synthesizeProcessedText(ctx.text, ctx.voice)
  if (bestResult.durationUs <= ctx.windowUs) return bestResult

  const originalOverRatio = bestResult.durationUs / ctx.windowUs

  if (originalOverRatio <= MAX_SLIGHT_RATE_OVERRUN) {
    const rateFit = await trySlightRateFallback(ctx.text, ctx.voice, ctx.windowUs, originalOverRatio)
    if (rateFit.result) return rateFit.result
    if (rateFit.bestResult.durationUs < bestResult.durationUs) {
      bestResult = rateFit.bestResult
    }
  }

  const targetChars = Math.max(
    2,
    Math.floor((ctx.text.length / originalOverRatio) * getCompressionFactor(ctx.risk))
  )
  let compressed = ctx.text

  for (let retry = 0; retry < MAX_RETRIES_PER_LEVEL; retry++) {
    compressed = await compressTranslation(ctx.text, targetChars - retry, ctx.apiKey)
    const compressedResult = await synthesizeProcessedText(compressed, ctx.voice)
    if (compressedResult.durationUs <= ctx.windowUs) return compressedResult
    if (compressedResult.durationUs < bestResult.durationUs) {
      bestResult = compressedResult
    }

    const compressedOverRatio = compressedResult.durationUs / ctx.windowUs
    if (compressedOverRatio <= MAX_SLIGHT_RATE_OVERRUN) {
      const rateFit = await trySlightRateFallback(
        compressed,
        ctx.voice,
        ctx.windowUs,
        compressedOverRatio
      )
      if (rateFit.result) return rateFit.result
      if (rateFit.bestResult.durationUs < bestResult.durationUs) {
        bestResult = rateFit.bestResult
      }
    }
  }

  return clipProcessedAudioToWindow(bestResult, ctx.windowUs)
}

function getSlightRateCandidates(overRatio: number): readonly string[] {
  if (overRatio <= 1.04) return SLIGHT_RATE_STEPS.slice(0, 1)
  if (overRatio <= 1.08) return SLIGHT_RATE_STEPS.slice(0, 2)
  return SLIGHT_RATE_STEPS
}

function getCompressionFactor(risk: SegmentRisk): number {
  if (risk === 'high') return 0.84
  if (risk === 'medium') return 0.87
  return 0.9
}

async function trySlightRateFallback(
  text: string,
  voice: string,
  windowUs: MicrosecondTimestamp,
  overRatio: number
): Promise<{ result: ProcessedAudio | null; bestResult: ProcessedAudio }> {
  const candidates = getSlightRateCandidates(overRatio)
  let bestResult = await synthesizeProcessedText(text, voice, candidates[0])
  if (bestResult.durationUs <= windowUs) {
    return { result: bestResult, bestResult }
  }

  for (const rate of candidates.slice(1)) {
    const result = await synthesizeProcessedText(text, voice, rate)
    if (result.durationUs < bestResult.durationUs) {
      bestResult = result
    }
    if (result.durationUs <= windowUs) {
      return { result, bestResult: result }
    }
  }

  return { result: null, bestResult }
}
