import type { MicrosecondTimestamp, TimeWindow } from '../../types'
import { synthesize } from './edge-tts'
import { decodeMp3ToPcm, measurePcmDurationUs, trimSilence } from './ffmpeg'
import { CPS_SAFETY_FACTOR, MARGIN_SEC } from './audio-constants'

let cpsCache = new Map<string, number>()

export async function calibrateCPS(voice: string): Promise<number> {
  if (cpsCache.has(voice)) return cpsCache.get(voice)!

  const testText = '这是用于估算语速的短句，保持稳定输出。'
  const mp3 = await synthesize(testText, voice)
  const pcm = await decodeMp3ToPcm(mp3)
  const trimmed = trimSilence(pcm)
  const durationUs = measurePcmDurationUs(trimmed)
  const durationSec = durationUs / 1_000_000

  const cps = durationSec > 0 ? testText.length / durationSec : 5
  cpsCache.set(voice, cps)
  return cps
}

export function computeBudget(windowUs: MicrosecondTimestamp, cps: number): number {
  const windowSec = windowUs / 1_000_000
  return Math.max(1, Math.floor((windowSec - MARGIN_SEC) * cps * CPS_SAFETY_FACTOR))
}

export function assignBudgets(windows: TimeWindow[], cps: number): void {
  for (const window of windows) {
    window.budgetChars = computeBudget(window.windowUs, cps)
  }
}

export function resetCpsCache(): void {
  cpsCache = new Map()
}
