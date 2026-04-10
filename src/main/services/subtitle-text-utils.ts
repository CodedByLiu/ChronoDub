import type { Cue } from '../../types'

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
