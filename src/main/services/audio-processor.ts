import type { Cue, Segment, TimeWindow, MicrosecondTimestamp } from '../../types'
import { synthesize } from './edge-tts'
import { decodeMp3ToPcm, trimSilence, measurePcmDurationUs, writePcmToWav } from './ffmpeg'
import { compressTranslation } from './deepseek'

const SR = 48000
const SAFETY_GAP_US = 50_000
const MERGE_GAP_US = 200_000
const MAX_SEGMENT_DURATION_US = 7_000_000
const SHORT_CUE_US = 800_000
const FADE_MS = 10
const FADE_SAMPLES = Math.round((FADE_MS / 1000) * SR)
const MARGIN_SEC = 0.15
const CPS_SAFETY_FACTOR = 0.9
const MAX_FALLBACK_ROUNDS = 3
const MAX_RETRIES_PER_LEVEL = 2

const STRONG_TERMINALS = /[.?!…。？！]+$/

// ─── 4.1 时间窗构建 ──────────────────────────────

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

// ─── 4.2 CPS 校准与字数预算 ──────────────────────

let cpsCache = new Map<string, number>()

export async function calibrateCPS(voice: string): Promise<number> {
  if (cpsCache.has(voice)) return cpsCache.get(voice)!

  const testText = '今天天气真不错，我们一起来学习编程技术。'
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

// ─── 4.3 音频时长测量与预处理 ────────────────────

export interface ProcessedAudio {
  pcm: Buffer
  durationUs: MicrosecondTimestamp
}

export async function processAudio(mp3Buffer: Buffer): Promise<ProcessedAudio> {
  const pcmRaw = await decodeMp3ToPcm(mp3Buffer, SR)
  const pcm = trimSilence(pcmRaw, SR)
  const durationUs = measurePcmDurationUs(pcm, SR)
  return { pcm, durationUs }
}

// ─── 4.4 样本点域装配器 ──────────────────────────

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

// ─── 4.5 回退策略级联 ────────────────────────────

export interface FallbackContext {
  text: string
  windowUs: MicrosecondTimestamp
  voice: string
  apiKey: string
  segmentIndex: number
  segments: AssemblerSegment[]
  windows: TimeWindow[]
}

export async function synthesizeWithFallback(ctx: FallbackContext): Promise<ProcessedAudio> {
  let currentText = ctx.text
  const windowSec = ctx.windowUs / 1_000_000

  for (let round = 0; round < MAX_FALLBACK_ROUNDS; round++) {
    const mp3 = await synthesize(currentText, ctx.voice)
    const result = await processAudio(mp3)

    if (result.durationUs <= ctx.windowUs) {
      return result
    }

    const overRatio = result.durationUs / ctx.windowUs

    // Level 1: 语义压缩重译
    if (round === 0) {
      const targetChars = Math.max(2, Math.floor((currentText.length / overRatio) * 0.85))
      let compressed = currentText
      for (let retry = 0; retry < MAX_RETRIES_PER_LEVEL; retry++) {
        compressed = await compressTranslation(currentText, targetChars - retry, ctx.apiKey)
        const mp3c = await synthesize(compressed, ctx.voice)
        const rc = await processAudio(mp3c)
        if (rc.durationUs <= ctx.windowUs) return rc
      }
      currentText = compressed
      continue
    }

    // Level 2: 句子拆分
    if (round === 1) {
      const splitResult = trySplitToAdjacentWindows(ctx, currentText)
      if (splitResult) return splitResult
      continue
    }

    // Level 3: 终极降级 - 硬裁剪 + 淡出
    return hardClip(result, ctx.windowUs)
  }

  const mp3 = await synthesize(currentText, ctx.voice)
  const result = await processAudio(mp3)
  return result.durationUs <= ctx.windowUs ? result : hardClip(result, ctx.windowUs)
}

function trySplitToAdjacentWindows(ctx: FallbackContext, text: string): ProcessedAudio | null {
  const splitPoints = /([，。；、！？,;!?])/
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

function hardClip(audio: ProcessedAudio, windowUs: MicrosecondTimestamp): ProcessedAudio {
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

  return {
    pcm: clipped,
    durationUs: measurePcmDurationUs(clipped, SR),
  }
}

// ─── 工具函数 ────────────────────────────────────

export function resetCpsCache(): void {
  cpsCache = new Map()
}

export { SR, SAFETY_GAP_US }
