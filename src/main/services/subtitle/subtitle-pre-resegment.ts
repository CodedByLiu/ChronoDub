import type { Cue, MicrosecondTimestamp } from '../../../types'

// Whisper occasionally packs multiple complete sentences into one long cue (e.g. 10+ seconds).
// When that happens the LLM sentence-grouper sees it as a single sentence and the whole chunk
// gets translated together, hurting TTS rhythm. This module does a conservative pre-split BEFORE
// the LLM grouper sees the cues: any cue longer than OVERLONG_DURATION_US that internally contains
// strong sentence terminators followed by a capitalized new sentence gets split along those
// terminators. Time is reapportioned by character count (±200ms estimation error is acceptable
// for cues this long).

const OVERLONG_DURATION_US = 6_000_000

// Match a strong terminator (. ? !) optionally followed by closing quote/bracket, then whitespace,
// then a capital-letter word that signals a new sentence. The capture group ends at the position
// just AFTER the terminator + trailing closing punctuation, so we split there.
const SENTENCE_BOUNDARY_RE = /([.?!]["')\]]*)\s+(?=[A-Z])/g

function findInternalSplitPositions(text: string): number[] {
  const positions: number[] = []
  SENTENCE_BOUNDARY_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SENTENCE_BOUNDARY_RE.exec(text)) !== null) {
    const end = m.index + m[1].length
    if (end > 0 && end < text.length) positions.push(end)
  }
  return positions
}

function reapportionTimes(
  parts: string[],
  startUs: number,
  endUs: number
): Array<{ startUs: number; endUs: number }> {
  if (parts.length === 1) return [{ startUs, endUs }]
  const totalDuration = Math.max(parts.length, endUs - startUs)
  const weights = parts.map((p) => Math.max(1, p.length))
  const totalWeight = weights.reduce((s, w) => s + w, 0)

  const timings: Array<{ startUs: number; endUs: number }> = []
  let cumulative = 0
  let prevEnd = startUs
  for (let i = 0; i < parts.length; i++) {
    cumulative += weights[i]
    const isLast = i === parts.length - 1
    const partEnd = isLast
      ? endUs
      : startUs + Math.round((totalDuration * cumulative) / totalWeight)
    const cueStart = prevEnd
    const clampedEnd = Math.max(cueStart + 1, partEnd)
    timings.push({ startUs: cueStart, endUs: clampedEnd })
    prevEnd = clampedEnd
  }
  return timings
}

export function splitOverlongCuesByPunctuation(cues: Cue[]): Cue[] {
  if (cues.length === 0) return cues

  const maxExistingId = cues.reduce((max, c) => (c.id > max ? c.id : max), 0)
  let nextId = maxExistingId + 1
  const output: Cue[] = []
  let didSplit = false

  for (const cue of cues) {
    const duration = cue.endUs - cue.startUs
    if (duration <= OVERLONG_DURATION_US) {
      output.push(cue)
      continue
    }

    const splitPositions = findInternalSplitPositions(cue.text)
    if (splitPositions.length < 2) {
      output.push(cue)
      continue
    }

    const pieces: string[] = []
    let prev = 0
    for (const pos of splitPositions) {
      const slice = cue.text.slice(prev, pos).trim()
      if (slice) pieces.push(slice)
      prev = pos
    }
    const tail = cue.text.slice(prev).trim()
    if (tail) pieces.push(tail)

    if (pieces.length < 2) {
      output.push(cue)
      continue
    }

    didSplit = true
    const timings = reapportionTimes(pieces, cue.startUs, cue.endUs)
    for (let i = 0; i < pieces.length; i++) {
      output.push({
        id: nextId++,
        text: pieces[i],
        startUs: timings[i].startUs as MicrosecondTimestamp,
        endUs: timings[i].endUs as MicrosecondTimestamp,
        ...(cue.rawStyle ? { rawStyle: cue.rawStyle } : {}),
      })
    }
  }

  if (!didSplit) return cues
  return output
}
