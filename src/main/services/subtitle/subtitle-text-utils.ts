import type { Cue, MicrosecondTimestamp, Segment } from '../../../types'
import { SUBTITLE_MAX_CHARS_PER_CUE, SUBTITLE_SOFT_SPLIT_TARGET } from '../audio'

const ASCII_WORD_CHAR_RE = /[A-Za-z0-9_./#+-]/
const PREFERRED_SPLIT_AFTER_RE = /[\s,.;:!?\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3001\uFF09)\]}]/
const PREFERRED_SPLIT_BEFORE_RE = /[\s\uFF08([{]/

function isAsciiWordChar(ch: string | undefined): boolean {
  return !!ch && ASCII_WORD_CHAR_RE.test(ch)
}

function isSafeSplitBoundary(text: string, index: number): boolean {
  const prev = text[index - 1]
  const next = text[index]
  if (!prev || !next) return true
  return !(isAsciiWordChar(prev) && isAsciiWordChar(next))
}

function isPreferredSplitBoundary(text: string, index: number): boolean {
  const prev = text[index - 1]
  const next = text[index]
  if (!prev || !next) return true
  if (PREFERRED_SPLIT_AFTER_RE.test(prev) || PREFERRED_SPLIT_BEFORE_RE.test(next)) return true
  return isSafeSplitBoundary(text, index)
}

function findSplitBoundary(text: string, target: number, min: number, max: number): number {
  const clamped = Math.max(min, Math.min(max, target))
  const maxRadius = Math.max(clamped - min, max - clamped)

  for (let radius = 0; radius <= maxRadius; radius++) {
    const left = clamped - radius
    const right = clamped + radius

    if (left >= min && isPreferredSplitBoundary(text, left)) return left
    if (right <= max && right !== left && isPreferredSplitBoundary(text, right)) return right
  }

  for (let radius = 0; radius <= maxRadius; radius++) {
    const left = clamped - radius
    const right = clamped + radius

    if (left >= min && isSafeSplitBoundary(text, left)) return left
    if (right <= max && right !== left && isSafeSplitBoundary(text, right)) return right
  }

  return clamped
}

export function splitSegmentTextAcrossCues(text: string, cues: Cue[]): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (cues.length === 0) return []
  if (cues.length === 1) return [normalized]
  if (!normalized) return Array(cues.length).fill('')

  const weights = cues.map((cue) => Math.max(1, cue.endUs - cue.startUs))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)

  const boundaries: number[] = []
  let consumedWeight = 0
  let lastBoundary = 0

  for (let i = 0; i < cues.length - 1; i++) {
    consumedWeight += weights[i]
    const target = Math.round((normalized.length * consumedWeight) / totalWeight)
    const remainingParts = cues.length - i - 1
    const min = lastBoundary + 1
    const max = normalized.length - remainingParts
    const boundary = findSplitBoundary(normalized, target, min, max)
    boundaries.push(boundary)
    lastBoundary = boundary
  }

  const pieces: string[] = []
  let start = 0
  for (const boundary of boundaries) {
    pieces.push(normalized.slice(start, boundary).trim())
    start = boundary
  }
  pieces.push(normalized.slice(start).trim())

  return pieces
}

const SPEAKABLE_CHAR_RE = /[\p{L}\p{N}]/u

export function hasSpeakableContent(text: string): boolean {
  return SPEAKABLE_CHAR_RE.test(text)
}

const SENTENCE_TERMINATOR_RE = /([。！？!?…]+)/g
const SOFT_SPLIT_PUNCT_RE = /[，、；：,;:]/g

export function partitionChineseBySentence(
  text: string,
  maxChars: number = SUBTITLE_MAX_CHARS_PER_CUE,
  softTarget: number = SUBTITLE_SOFT_SPLIT_TARGET
): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []

  const sentences: string[] = []
  let cursor = 0
  SENTENCE_TERMINATOR_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SENTENCE_TERMINATOR_RE.exec(normalized)) !== null) {
    const end = match.index + match[0].length
    const piece = normalized.slice(cursor, end).trim()
    if (piece) sentences.push(piece)
    cursor = end
  }
  if (cursor < normalized.length) {
    const tail = normalized.slice(cursor).trim()
    if (tail) sentences.push(tail)
  }

  const result: string[] = []
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      result.push(sentence)
    } else {
      result.push(...softSplitLongSentence(sentence, maxChars, softTarget))
    }
  }
  return result
}

function softSplitLongSentence(
  sentence: string,
  maxChars: number,
  softTarget: number
): string[] {
  if (sentence.length <= maxChars) return [sentence]

  const punctIndices: number[] = []
  let m: RegExpExecArray | null
  SOFT_SPLIT_PUNCT_RE.lastIndex = 0
  while ((m = SOFT_SPLIT_PUNCT_RE.exec(sentence)) !== null) {
    punctIndices.push(m.index + 1)
  }

  const interiorCuts = punctIndices.filter((idx) => idx > 0 && idx < sentence.length)
  if (interiorCuts.length > 0) {
    const mid = Math.floor(sentence.length / 2)
    const cutAt = interiorCuts.reduce((best, idx) =>
      Math.abs(idx - mid) < Math.abs(best - mid) ? idx : best
    )
    const left = sentence.slice(0, cutAt).trim()
    const right = sentence.slice(cutAt).trim()
    if (left.length > 0 && right.length > 0 && left.length < sentence.length && right.length < sentence.length) {
      const pieces: string[] = []
      pieces.push(...softSplitLongSentence(left, maxChars, softTarget))
      pieces.push(...softSplitLongSentence(right, maxChars, softTarget))
      return pieces
    }
  }

  const pieces: string[] = []
  for (let i = 0; i < sentence.length; i += softTarget) {
    pieces.push(sentence.slice(i, i + softTarget))
  }
  return pieces
}

export function allocateProportionalTimings(
  parts: string[],
  startUs: number,
  endUs: number
): Array<{ startUs: number; endUs: number }> {
  if (parts.length === 0) return []
  if (parts.length === 1) return [{ startUs, endUs }]

  const safeEnd = Math.max(endUs, startUs + parts.length)
  const totalSpan = safeEnd - startUs
  const weights = parts.map((p) => Math.max(1, p.length))
  const totalWeight = weights.reduce((s, w) => s + w, 0)

  const timings: Array<{ startUs: number; endUs: number }> = []
  let cumulative = 0
  let prevEnd = startUs
  for (let i = 0; i < parts.length; i++) {
    cumulative += weights[i]
    const isLast = i === parts.length - 1
    const cueEnd = isLast ? safeEnd : startUs + Math.round((totalSpan * cumulative) / totalWeight)
    const cueStart = prevEnd
    const clampedEnd = Math.max(cueStart + 1, cueEnd)
    timings.push({ startUs: cueStart, endUs: clampedEnd })
    prevEnd = clampedEnd
  }
  return timings
}

export function repartitionCuesPerSegment(
  finalizedCues: Cue[],
  segments: Segment[],
  startIdHint?: number
): Cue[] {
  if (finalizedCues.length === 0 || segments.length === 0) return finalizedCues

  const cueMap = new Map<number, Cue>(finalizedCues.map((c) => [c.id, c]))
  const claimed = new Set<number>()
  const output: Cue[] = []
  let nextId =
    startIdHint ?? finalizedCues.reduce((max, c) => (c.id > max ? c.id : max), 0) + 1

  for (const segment of segments) {
    const segCues = segment.cueIds
      .map((id) => cueMap.get(id))
      .filter((c): c is Cue => !!c)
    if (segCues.length === 0) continue
    segCues.forEach((c) => claimed.add(c.id))

    const segStart = segCues[0].startUs
    const segEnd = segCues[segCues.length - 1].endUs
    const joined = joinCueTextsForSpeech(segCues.map((c) => c.text))
    const parts = partitionChineseBySentence(joined)

    if (parts.length === 0) continue
    const timings = allocateProportionalTimings(parts, segStart, segEnd)
    for (let i = 0; i < parts.length; i++) {
      output.push({
        id: nextId++,
        text: parts[i],
        startUs: timings[i].startUs as MicrosecondTimestamp,
        endUs: timings[i].endUs as MicrosecondTimestamp,
      })
    }
  }

  for (const cue of finalizedCues) {
    if (!claimed.has(cue.id)) output.push(cue)
  }

  output.sort((a, b) => a.startUs - b.startUs || a.id - b.id)
  return output
}

export function joinCueTextsForSpeech(parts: string[]): string {
  let text = ''

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue

    if (!text) {
      text = trimmed
      continue
    }

    const prev = text[text.length - 1]
    const next = trimmed[0]
    text += isAsciiWordChar(prev) && isAsciiWordChar(next) ? ` ${trimmed}` : trimmed
  }

  return text
}
