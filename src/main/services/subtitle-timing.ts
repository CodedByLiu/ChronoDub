import type { Cue, Segment, TimeWindow } from '../../types'
import type { AudioBoundary, ProcessedAudio, SegmentRisk } from './audio-processor'

const ASCII_WORD_CHAR_RE = /[A-Za-z0-9_./#+-]/
const PREFERRED_SPLIT_AFTER_RE = /[\s,.;:!?\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u3001\uFF09)\]}]/
const PREFERRED_SPLIT_BEFORE_RE = /[\s\uFF08([{]/
const RETIME_MIN_CUE_US = 80_000
const RETIME_MIN_GAP_US = 20_000
const WEAK_MATCH_CHAR_RE = /[\p{P}\p{S}]/u

interface TimedChar {
  startUs: number
  endUs: number
}

interface StreamChar extends TimedChar {
  norm: string
  exactIndex: number
}

interface ReducedStreamChar extends TimedChar {
  norm: string
  exactIndex: number
  reducedIndex: number
}

interface BoundaryTextStream {
  exactChars: StreamChar[]
  reducedChars: ReducedStreamChar[]
  exactText: string
  reducedText: string
}

interface CueMatchRange {
  startUs: number
  endUs: number
  nextExactCursor: number
}

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

export function computeSegmentTranslationBudget(
  windowBudget: number,
  risk: SegmentRisk
): number {
  const slackRatio = risk === 'high' ? 0.02 : risk === 'medium' ? 0.05 : 0.1
  const maxSlack = risk === 'high' ? 2 : risk === 'medium' ? 4 : 6
  const slack = Math.min(maxSlack, Math.max(1, Math.ceil(windowBudget * slackRatio)))
  return Math.max(1, windowBudget + slack)
}

function countTimingChars(text: string, keepWeakChars = true): number {
  return normalizeTextForMatch(text, keepWeakChars).length
}

function buildTimedCharStream(boundaries: AudioBoundary[]): BoundaryTextStream {
  const exactChars: StreamChar[] = []
  const reducedChars: ReducedStreamChar[] = []

  for (const boundary of boundaries) {
    for (const ch of Array.from(boundary.part)) {
      if (/\s/.test(ch)) continue

      const normalizedChars = Array.from(normalizeMatchChar(ch))
      if (normalizedChars.length === 0) continue

      for (const norm of normalizedChars) {
        const exactIndex = exactChars.length
        const exactEntry: StreamChar = {
          norm,
          startUs: boundary.startUs,
          endUs: boundary.endUs,
          exactIndex,
        }
        exactChars.push(exactEntry)

        if (!isWeakMatchChar(norm)) {
          reducedChars.push({
            ...exactEntry,
            reducedIndex: reducedChars.length,
          })
        }
      }
    }
  }

  return {
    exactChars,
    reducedChars,
    exactText: exactChars.map((item) => item.norm).join(''),
    reducedText: reducedChars.map((item) => item.norm).join(''),
  }
}

function normalizeTextForMatch(text: string, keepWeakChars: boolean): string {
  let output = ''

  for (const ch of Array.from(text)) {
    if (/\s/.test(ch)) continue

    for (const norm of Array.from(normalizeMatchChar(ch))) {
      if (!keepWeakChars && isWeakMatchChar(norm)) continue
      output += norm
    }
  }

  return output
}

function normalizeMatchChar(ch: string): string {
  return ch.normalize('NFKC').toLocaleLowerCase()
}

function isWeakMatchChar(ch: string): boolean {
  return WEAK_MATCH_CHAR_RE.test(ch)
}

function findCueMatchRange(
  cueText: string,
  stream: BoundaryTextStream,
  exactCursor: number
): CueMatchRange | null {
  const exactNeedle = normalizeTextForMatch(cueText, true)
  if (exactNeedle) {
    const exactMatchIndex = stream.exactText.indexOf(exactNeedle, exactCursor)
    if (exactMatchIndex >= 0) {
      const start = stream.exactChars[exactMatchIndex]
      const end = stream.exactChars[exactMatchIndex + exactNeedle.length - 1]
      return {
        startUs: start.startUs,
        endUs: end.endUs,
        nextExactCursor: end.exactIndex + 1,
      }
    }
  }

  const reducedNeedle = normalizeTextForMatch(cueText, false)
  if (!reducedNeedle || stream.reducedChars.length === 0) return null

  const reducedCursor = findReducedCursor(stream.reducedChars, exactCursor)
  const reducedMatchIndex = stream.reducedText.indexOf(reducedNeedle, reducedCursor)
  if (reducedMatchIndex < 0) return null

  const start = stream.reducedChars[reducedMatchIndex]
  const end = stream.reducedChars[reducedMatchIndex + reducedNeedle.length - 1]
  return {
    startUs: start.startUs,
    endUs: end.endUs,
    nextExactCursor: end.exactIndex + 1,
  }
}

function findReducedCursor(reducedChars: ReducedStreamChar[], exactCursor: number): number {
  for (let i = 0; i < reducedChars.length; i++) {
    if (reducedChars[i].exactIndex >= exactCursor) return i
  }
  return reducedChars.length
}

function proportionalRetimeSegmentCues(
  window: TimeWindow,
  segmentCues: Cue[],
  stream: BoundaryTextStream,
  audio: ProcessedAudio
): Cue[] {
  const timedChars = stream.exactChars
  if (timedChars.length === 0) return segmentCues

  const cueCharCounts = segmentCues.map((cue) => countTimingChars(cue.text))
  const totalCueChars = cueCharCounts.reduce((sum, count) => sum + count, 0)
  if (totalCueChars === 0) return segmentCues

  const segmentStartUs = window.startUs
  const segmentEndUs = Math.min(window.deadlineUs, window.startUs + audio.durationUs)
  const retimed = segmentCues.map((cue) => ({ ...cue }))
  let previousStartUs = segmentStartUs

  for (let i = 0; i < retimed.length; i++) {
    const cue = retimed[i]
    const charCount = cueCharCounts[i]
    const cumulativeBefore = cueCharCounts.slice(0, i).reduce((sum, count) => sum + count, 0)
    const cumulativeAfter = cumulativeBefore + charCount

    if (charCount <= 0) {
      cue.startUs = previousStartUs
      cue.endUs = previousStartUs
      continue
    }

    let startIdx = Math.floor((cumulativeBefore / totalCueChars) * timedChars.length)
    let endExclusive = Math.ceil((cumulativeAfter / totalCueChars) * timedChars.length)

    startIdx = Math.max(0, Math.min(startIdx, timedChars.length - 1))
    endExclusive = Math.max(startIdx + 1, Math.min(endExclusive, timedChars.length))

    const startUs = segmentStartUs + timedChars[startIdx].startUs
    const endUs = segmentStartUs + timedChars[endExclusive - 1].endUs

    cue.startUs = Math.max(previousStartUs, Math.min(startUs, segmentEndUs))
    cue.endUs = Math.max(cue.startUs, Math.min(endUs, segmentEndUs))
    previousStartUs = cue.startUs
  }

  return retimed
}

function clampRetimedCueRanges(cues: Cue[], segmentEndUs: number): Cue[] {
  const retimed = cues.map((cue) => ({ ...cue }))

  for (let i = 0; i < retimed.length; i++) {
    const cue = retimed[i]
    const next = retimed[i + 1]
    const maxEndUs = next ? Math.max(cue.startUs, next.startUs - RETIME_MIN_GAP_US) : segmentEndUs
    const preferredEndUs = Math.min(Math.max(cue.endUs, cue.startUs + RETIME_MIN_CUE_US), maxEndUs)
    cue.endUs = Math.max(cue.startUs, preferredEndUs)

    if (next && next.startUs < cue.endUs + RETIME_MIN_GAP_US) {
      next.startUs = Math.min(segmentEndUs, cue.endUs + RETIME_MIN_GAP_US)
    }
  }

  if (retimed.length > 0) {
    retimed[retimed.length - 1].endUs = Math.max(retimed[retimed.length - 1].startUs, segmentEndUs)
  }

  return retimed
}

export function retimeSegmentCues(
  _segment: Segment,
  window: TimeWindow,
  segmentCues: Cue[],
  audio: ProcessedAudio
): Cue[] {
  if (segmentCues.length === 0 || audio.boundaries.length === 0 || audio.durationUs <= 0) {
    return segmentCues
  }

  const segmentStartUs = window.startUs
  const segmentEndUs = Math.min(window.deadlineUs, window.startUs + audio.durationUs)
  const stream = buildTimedCharStream(audio.boundaries)
  if (stream.exactChars.length === 0) return segmentCues

  const retimed = segmentCues.map((cue) => ({ ...cue }))
  let previousStartUs = segmentStartUs
  let exactCursor = 0

  for (let i = 0; i < retimed.length; i++) {
    const cue = retimed[i]
    const exactCharCount = countTimingChars(cue.text, true)
    const reducedCharCount = countTimingChars(cue.text, false)

    if (exactCharCount <= 0 && reducedCharCount <= 0) {
      cue.startUs = previousStartUs
      cue.endUs = previousStartUs
      continue
    }

    const match = findCueMatchRange(cue.text, stream, exactCursor)
    if (!match) {
      const fallback = proportionalRetimeSegmentCues(window, segmentCues, stream, audio)
      return clampRetimedCueRanges(fallback, segmentEndUs)
    }

    cue.startUs = Math.max(previousStartUs, Math.min(segmentStartUs + match.startUs, segmentEndUs))
    cue.endUs = Math.max(cue.startUs, Math.min(segmentStartUs + match.endUs, segmentEndUs))
    previousStartUs = cue.startUs
    exactCursor = Math.max(exactCursor, match.nextExactCursor)
  }

  return clampRetimedCueRanges(retimed, segmentEndUs)
}
