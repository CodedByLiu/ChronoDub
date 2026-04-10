import type { MicrosecondTimestamp } from '../../types'
import { synthesizeDetailed, type TtsBoundary } from './edge-tts'
import { decodeMp3ToPcm, measurePcmDurationUs, trimSilenceDetailed, writePcmToWav } from './ffmpeg'
import { FADE_SAMPLES, SR } from './audio-constants'

export interface AudioBoundary {
  part: string
  startUs: MicrosecondTimestamp
  endUs: MicrosecondTimestamp
}

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
  const output = Buffer.alloc(totalSamples * 2)
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

export async function synthesizeProcessedText(
  text: string,
  voice: string,
  rate = 'default'
): Promise<ProcessedAudio> {
  return synthesizeProcessed(text, voice, rate)
}

const CLIP_CUT_AFTER_RE = /[\s,.;:!?\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3001\uFF09)\]}]/
const CLIP_CUT_BEFORE_RE = /[\s\uFF08([{]/

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

  if (approxKeepChars <= 0 || ratio < 0.2) return ''

  const naturalCut = findNaturalTextCutIndex(chars, approxKeepChars)
  if (naturalCut > 0) return chars.slice(0, naturalCut).join('').trimEnd()

  if (hasAsciiWords && ratio < 0.75) return ''
  if (!hasAsciiWords && ratio < 0.4) return ''

  return chars.slice(0, Math.max(1, approxKeepChars)).join('').trimEnd()
}

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
    if (right < chars.length && right !== left && isClipPreferredBoundary(chars, right)) return right
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
