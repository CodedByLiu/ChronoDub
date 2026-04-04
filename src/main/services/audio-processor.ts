import type { Cue, MicrosecondTimestamp, Segment, TimeWindow } from '../../types'
import { compressTranslation } from './deepseek'
import { synthesize, synthesizeDetailed, type TtsBoundary } from './edge-tts'
import {
  decodeMp3ToPcm,
  measurePcmDurationUs,
  trimSilence,
  trimSilenceDetailed,
  writePcmToWav,
} from './ffmpeg'

const SR = 48000
const SAFETY_GAP_US = 50_000
const MERGE_GAP_US = 200_000
const MAX_SEGMENT_DURATION_US = 7_000_000
const FADE_MS = 10
const FADE_SAMPLES = Math.round((FADE_MS / 1000) * SR)
const MARGIN_SEC = 0.15
const CPS_SAFETY_FACTOR = 0.9
const MAX_RETRIES_PER_LEVEL = 2
const SLIGHT_RATE_STEPS = ['+4%', '+6%', '+8%'] as const
const MAX_SLIGHT_RATE_OVERRUN = 1.18
const HIGH_RISK_WINDOW_US = 1_800_000
const MEDIUM_RISK_WINDOW_US = 2_800_000

const STRONG_TERMINALS = /[.?!…。？！]+$/
const TECH_TOKEN_RE =
  /\b(?:[A-Z][A-Za-z0-9_]*|[A-Za-z]+(?:[./#_-][A-Za-z0-9_]+)+|[A-Za-z]+\d+)\b/g

export interface AudioBoundary {
  part: string
  startUs: MicrosecondTimestamp
  endUs: MicrosecondTimestamp
}

// 鈹€鈹€鈹€ 4.1 鏃堕棿绐楁瀯寤?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export function buildSegments(cues: Cue[]): Segment[] {
  if (cues.length === 0) return []

  const sorted = [...cues].sort((a, b) => a.startUs - b.startUs)
  const segments: Segment[] = []
  let current: Segment = {
    id: 0,
    cueIds: [sorted[0].id],
    startUs: sorted[0].startUs,
    endUs: sorted[0].endUs,
    textEn: sorted[0].text,
  }

  for (let i = 1; i < sorted.length; i++) {
    const cue = sorted[i]
    const gap = cue.startUs - current.endUs
    const mergedDuration = cue.endUs - current.startUs
    const lastText = sorted[i - 1].text

    const canMerge =
      gap <= MERGE_GAP_US &&
      !STRONG_TERMINALS.test(lastText) &&
      mergedDuration <= MAX_SEGMENT_DURATION_US

    if (canMerge) {
      current.cueIds.push(cue.id)
      current.endUs = cue.endUs
      current.textEn += ' ' + cue.text
    } else {
      segments.push(current)
      current = {
        id: segments.length,
        cueIds: [cue.id],
        startUs: cue.startUs,
        endUs: cue.endUs,
        textEn: cue.text,
      }
    }
  }
  segments.push(current)

  return segments
}

export function buildTimeWindows(
  segments: Segment[],
  videoDurationUs: MicrosecondTimestamp
): TimeWindow[] {
  const windows: TimeWindow[] = []

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const nextStart = i < segments.length - 1 ? segments[i + 1].startUs : videoDurationUs

    const hardDeadline = nextStart - SAFETY_GAP_US
    const deadline = Math.max(hardDeadline, seg.startUs + SAFETY_GAP_US)
    const windowUs = deadline - seg.startUs

    windows.push({
      segmentId: seg.id,
      startUs: seg.startUs,
      deadlineUs: deadline,
      windowUs,
      budgetChars: 0,
    })
  }

  return windows
}

// 鈹€鈹€鈹€ 4.2 CPS 鏍″噯涓庡瓧鏁伴绠?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

let cpsCache = new Map<string, number>()

export async function calibrateCPS(voice: string): Promise<number> {
  if (cpsCache.has(voice)) return cpsCache.get(voice)!

  const testText = '浠婂ぉ澶╂皵鐪熶笉閿欙紝鎴戜滑涓€璧锋潵瀛︿範缂栫▼鎶€鏈€?'
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
  for (const w of windows) {
    w.budgetChars = computeBudget(w.windowUs, cps)
  }
}

// 鈹€鈹€鈹€ 4.3 闊抽鏃堕暱娴嬮噺涓庨澶勭悊 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export interface ProcessedAudio {
  pcm: Buffer
  durationUs: MicrosecondTimestamp
  spokenText: string
  boundaries: AudioBoundary[]
  leadTrimUs: MicrosecondTimestamp
}

interface ProcessAudioOptions {
  spokenText?: string
  boundaries?: TtsBoundary[]
}

export async function processAudio(
  mp3Buffer: Buffer,
  options: ProcessAudioOptions = {}
): Promise<ProcessedAudio> {
  const pcmRaw = await decodeMp3ToPcm(mp3Buffer, SR)
  const trimmed = trimSilenceDetailed(pcmRaw, SR)
  const leadTrimUs = samplesToUs(trimmed.startSample, SR)
  const pcm = trimmed.buffer
  const durationUs = measurePcmDurationUs(pcm, SR)

  return {
    pcm,
    durationUs,
    spokenText: options.spokenText ?? '',
    boundaries: normalizeBoundaries(options.boundaries ?? [], leadTrimUs, durationUs),
    leadTrimUs,
  }
}

// 鈹€鈹€鈹€ 4.4 鏍锋湰鐐瑰煙瑁呴厤鍣?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export function applyFadeInOut(samples: Int16Array, fadeN: number): void {
  const len = samples.length
  if (len === 0) return
  const actualFade = Math.min(fadeN, Math.floor(len / 2))

  for (let i = 0; i < actualFade; i++) {
    const gain = i / actualFade
    samples[i] = Math.round(samples[i] * gain)
  }

  for (let i = 0; i < actualFade; i++) {
    const idx = len - 1 - i
    const gain = i / actualFade
    samples[idx] = Math.round(samples[idx] * gain)
  }
}

export interface AssemblerSegment {
  startUs: MicrosecondTimestamp
  deadlineUs: MicrosecondTimestamp
  pcm: Buffer
}

export function assembleTrack(
  segments: AssemblerSegment[],
  totalDurationUs: MicrosecondTimestamp
): Buffer {
  const totalSamples = Math.ceil((totalDurationUs / 1_000_000) * SR)
  const output = Buffer.alloc(totalSamples * 2) // 16-bit mono
  let cursor = 0

  for (const seg of segments) {
    const startSample = Math.round((seg.startUs / 1_000_000) * SR)
    const deadlineSample = Math.round((seg.deadlineUs / 1_000_000) * SR)

    if (cursor < startSample) {
      cursor = startSample
    }

    if (seg.pcm.byteLength > 0) {
      const samples = new Int16Array(seg.pcm.buffer, seg.pcm.byteOffset, seg.pcm.byteLength / 2)
      applyFadeInOut(samples, FADE_SAMPLES)

      const bytesToWrite = Math.min(seg.pcm.byteLength, (totalSamples - cursor) * 2)
      if (bytesToWrite > 0) {
        seg.pcm.copy(output, cursor * 2, 0, bytesToWrite)
        cursor += bytesToWrite / 2
      }
    }

    if (cursor < deadlineSample) {
      cursor = deadlineSample
    }
  }

  return output
}

export async function assembleToWav(
  segments: AssemblerSegment[],
  totalDurationUs: MicrosecondTimestamp,
  outputPath: string
): Promise<void> {
  const pcm = assembleTrack(segments, totalDurationUs)
  await writePcmToWav(pcm, outputPath, SR)
}

// 鈹€鈹€鈹€ 4.5 鍥為€€绛栫暐绾ц仈 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export interface FallbackContext {
  text: string
  windowUs: MicrosecondTimestamp
  voice: string
  apiKey: string
  risk: SegmentRisk
  segmentIndex: number
  segments: AssemblerSegment[]
  windows: TimeWindow[]
}

export type SegmentRisk = 'low' | 'medium' | 'high'

function countTechnicalTokens(text: string): number {
  return text.match(TECH_TOKEN_RE)?.length ?? 0
}

export function classifySegmentRisk(
  segment: Pick<Segment, 'textEn' | 'cueIds'>,
  windowUs: MicrosecondTimestamp
): SegmentRisk {
  let score = 0
  const windowSec = windowUs / 1_000_000
  const charsPerSec = segment.textEn.length / Math.max(windowSec, 0.1)
  const technicalTokens = countTechnicalTokens(segment.textEn)

  if (windowUs <= HIGH_RISK_WINDOW_US) score += 3
  else if (windowUs <= MEDIUM_RISK_WINDOW_US) score += 2
  else if (windowUs <= 4_000_000) score += 1

  if (charsPerSec >= 18) score += 2
  else if (charsPerSec >= 12) score += 1

  if (technicalTokens >= 4) score += 2
  else if (technicalTokens >= 2) score += 1

  if (segment.cueIds.length >= 4) score += 1

  if (score >= 5) return 'high'
  if (score >= 3) return 'medium'
  return 'low'
}

export async function synthesizeWithFallback(ctx: FallbackContext): Promise<ProcessedAudio> {
  let bestResult = await synthesizeProcessed(ctx.text, ctx.voice)
  if (bestResult.durationUs <= ctx.windowUs) return bestResult

  const originalOverRatio = bestResult.durationUs / ctx.windowUs

  // Level 1: for slight overruns, prefer a tiny TTS rate bump over rewriting the text.
  if (originalOverRatio <= MAX_SLIGHT_RATE_OVERRUN) {
    const rateFit = await trySlightRateFallback(ctx.text, ctx.voice, ctx.windowUs, originalOverRatio)
    if (rateFit.result) return rateFit.result
    if (rateFit.bestResult.durationUs < bestResult.durationUs) {
      bestResult = rateFit.bestResult
    }
  }

  // Level 2: tighten the sentence while preserving technical meaning.
  const targetChars = Math.max(
    2,
    Math.floor((ctx.text.length / originalOverRatio) * getCompressionFactor(ctx.risk))
  )
  let compressed = ctx.text

  for (let retry = 0; retry < MAX_RETRIES_PER_LEVEL; retry++) {
    compressed = await compressTranslation(ctx.text, targetChars - retry, ctx.apiKey)
    const compressedResult = await synthesizeProcessed(compressed, ctx.voice)
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

  // Level 3: sentence splitting is still not wired through the pipeline.
  const splitResult = trySplitToAdjacentWindows(ctx, compressed)
  if (splitResult) return splitResult

  // Final safety net: keep the timeline strict even if quality must degrade.
  return clipProcessedAudioToWindow(bestResult, ctx.windowUs)
}

async function synthesizeProcessed(
  text: string,
  voice: string,
  rate = 'default'
): Promise<ProcessedAudio> {
  const result = await synthesizeDetailed(text, voice, rate)
  return processAudio(result.audio, {
    spokenText: result.spokenText,
    boundaries: result.boundaries,
  })
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
  let bestResult = await synthesizeProcessed(text, voice, candidates[0])
  if (bestResult.durationUs <= windowUs) {
    return { result: bestResult, bestResult }
  }

  for (const rate of candidates.slice(1)) {
    const result = await synthesizeProcessed(text, voice, rate)
    if (result.durationUs < bestResult.durationUs) {
      bestResult = result
    }
    if (result.durationUs <= windowUs) {
      return { result, bestResult: result }
    }
  }

  return { result: null, bestResult }
}

function trySplitToAdjacentWindows(_ctx: FallbackContext, text: string): ProcessedAudio | null {
  const splitPoints = /([,.;!?，。；、！？])/
  const parts = text.split(splitPoints).filter(Boolean)
  if (parts.length < 2) return null

  const mid = Math.floor(parts.length / 2)
  let firstHalf = ''
  let secondHalf = ''
  for (let i = 0; i < parts.length; i++) {
    if (i < mid) firstHalf += parts[i]
    else secondHalf += parts[i]
  }

  if (!firstHalf.trim() || !secondHalf.trim()) return null

  // Only return the first half as the current segment's audio
  // The second half would need to be handled by the pipeline (Phase 5)
  // For now, return null to indicate split isn't fully handled at this level
  return null
}

function truncateBoundaryPart(
  part: string,
  boundaryStartUs: MicrosecondTimestamp,
  boundaryEndUs: MicrosecondTimestamp,
  clipEndUs: MicrosecondTimestamp
): string {
  if (clipEndUs >= boundaryEndUs) return part

  const chars = Array.from(part)
  if (chars.length === 0) return part

  const visibleDurationUs = Math.max(0, clipEndUs - boundaryStartUs)
  const boundaryDurationUs = Math.max(1, boundaryEndUs - boundaryStartUs)
  const ratio = Math.max(0, Math.min(1, visibleDurationUs / boundaryDurationUs))
  const hasAsciiWords = /[A-Za-z]/.test(part)
  const approxKeepChars = Math.floor(chars.length * ratio)

  if (approxKeepChars <= 0) return ''
  if (ratio < 0.2) return ''

  const naturalCut = findNaturalTextCutIndex(chars, approxKeepChars)
  if (naturalCut > 0) return chars.slice(0, naturalCut).join('').trimEnd()

  if (hasAsciiWords && ratio < 0.75) return ''
  if (!hasAsciiWords && ratio < 0.4) return ''

  return chars.slice(0, Math.max(1, approxKeepChars)).join('').trimEnd()
}

const CLIP_CUT_AFTER_RE = /[\s,.;:!?\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3001\uFF09)\]}]/
const CLIP_CUT_BEFORE_RE = /[\s\uFF08([{]/

function isClipSafeBoundary(chars: string[], index: number): boolean {
  const prev = chars[index - 1]
  const next = chars[index]
  if (!prev || !next) return true
  return !(/[A-Za-z0-9_./#+-]/.test(prev) && /[A-Za-z0-9_./#+-]/.test(next))
}

function isClipPreferredBoundary(chars: string[], index: number): boolean {
  const prev = chars[index - 1]
  const next = chars[index]
  if (!prev || !next) return true
  if (CLIP_CUT_AFTER_RE.test(prev) || CLIP_CUT_BEFORE_RE.test(next)) return true
  return isClipSafeBoundary(chars, index)
}

function findNaturalTextCutIndex(chars: string[], target: number): number {
  const clamped = Math.max(1, Math.min(chars.length, target))
  const maxRadius = Math.max(clamped - 1, chars.length - clamped)

  for (let radius = 0; radius <= maxRadius; radius++) {
    const left = clamped - radius
    const right = clamped + radius

    if (left >= 1 && left < chars.length && isClipPreferredBoundary(chars, left)) return left
    if (
      right < chars.length &&
      right !== left &&
      isClipPreferredBoundary(chars, right)
    ) {
      return right
    }
  }

  for (let radius = 0; radius <= maxRadius; radius++) {
    const left = clamped - radius
    const right = clamped + radius

    if (left >= 1 && left < chars.length && isClipSafeBoundary(chars, left)) return left
    if (right < chars.length && right !== left && isClipSafeBoundary(chars, right)) return right
  }

  return 0
}

export function clipProcessedAudioToWindow(
  audio: ProcessedAudio,
  windowUs: MicrosecondTimestamp
): ProcessedAudio {
  const maxSamples = Math.round((windowUs / 1_000_000) * SR)
  const maxBytes = maxSamples * 2

  if (audio.pcm.byteLength <= maxBytes) return audio

  const clipped = Buffer.alloc(maxBytes)
  audio.pcm.copy(clipped, 0, 0, maxBytes)

  const samples = new Int16Array(clipped.buffer, clipped.byteOffset, clipped.byteLength / 2)

  const fadeOut = Math.min(FADE_SAMPLES * 3, Math.floor(samples.length / 4))
  for (let i = 0; i < fadeOut; i++) {
    const idx = samples.length - 1 - i
    const gain = i / fadeOut
    samples[idx] = Math.round(samples[idx] * gain)
  }

  const durationUs = measurePcmDurationUs(clipped, SR)
  const clippedBoundaries = audio.boundaries
    .map((boundary) => ({
      ...boundary,
      part: truncateBoundaryPart(boundary.part, boundary.startUs, boundary.endUs, durationUs),
      startUs: Math.min(boundary.startUs, durationUs),
      endUs: Math.min(boundary.endUs, durationUs),
    }))
    .filter((boundary) => boundary.part.trim() && boundary.endUs > boundary.startUs)

  return {
    pcm: clipped,
    durationUs,
    spokenText:
      clippedBoundaries.map((boundary) => boundary.part).join('') ||
      (audio.boundaries.length === 0 ? audio.spokenText : ''),
    boundaries: clippedBoundaries,
    leadTrimUs: audio.leadTrimUs,
  }
}

function normalizeBoundaries(
  boundaries: TtsBoundary[],
  leadTrimUs: MicrosecondTimestamp,
  durationUs: MicrosecondTimestamp
): AudioBoundary[] {
  return boundaries
    .map((boundary) => ({
      part: boundary.part,
      startUs: Math.max(0, boundary.startMs * 1000 - leadTrimUs),
      endUs: Math.max(0, boundary.endMs * 1000 - leadTrimUs),
    }))
    .map((boundary) => ({
      ...boundary,
      startUs: Math.min(boundary.startUs, durationUs),
      endUs: Math.min(boundary.endUs, durationUs),
    }))
    .filter((boundary) => boundary.part.trim() && boundary.endUs > boundary.startUs)
}

function samplesToUs(samples: number, sampleRate: number): MicrosecondTimestamp {
  return Math.round((samples / sampleRate) * 1_000_000)
}

// 鈹€鈹€鈹€ 宸ュ叿鍑芥暟 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

export function resetCpsCache(): void {
  cpsCache = new Map()
}

export { SR, SAFETY_GAP_US }
