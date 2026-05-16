import assert from 'node:assert/strict'
import test from 'node:test'
import type { Cue, MicrosecondTimestamp, Segment, TimeWindow } from '../src/types'
import type { AudioBoundary, ProcessedAudio } from '../src/main/services/audio'
import { retimeSegmentCues } from '../src/main/services/subtitle'

function us(value: number): MicrosecondTimestamp {
  return value as MicrosecondTimestamp
}

function buildAudio(boundaries: Array<{ part: string; startUs: number; endUs: number }>): ProcessedAudio {
  const normalized: AudioBoundary[] = boundaries.map((b) => ({
    part: b.part,
    startUs: us(b.startUs),
    endUs: us(b.endUs),
  }))
  const durationUs = us(normalized.length > 0 ? normalized[normalized.length - 1].endUs : 0)
  return {
    pcm: Buffer.alloc(0),
    durationUs,
    spokenText: normalized.map((b) => b.part).join(''),
    boundaries: normalized,
    leadTrimUs: us(0),
  }
}

function buildCue(id: number, startUs: number, endUs: number, text: string): Cue {
  return { id, startUs: us(startUs), endUs: us(endUs), text }
}

function buildSegment(id: number, cueIds: number[]): Segment {
  return { id, cueIds, startUs: us(0), endUs: us(0), textEn: '' }
}

function buildWindow(startUs: number, deadlineUs: number): TimeWindow {
  return {
    segmentId: 0,
    startUs: us(startUs),
    deadlineUs: us(deadlineUs),
    windowUs: us(deadlineUs - startUs),
    budgetChars: 0,
  }
}

test('retimeSegmentCues: tolerates non-BMP characters in boundary text', () => {
  // Regression: indexOf returns code-unit offsets, but exactChars was code-point indexed.
  // A non-BMP char (here, a math-bold "𝟎", 2 code units) shifted indices so
  // stream.exactChars[end] resolved to undefined → crash on `.endUs`.
  const audio = buildAudio([
    { part: 'a', startUs: 0, endUs: 100_000 },
    { part: '𝟎', startUs: 100_000, endUs: 200_000 },
    { part: 'b', startUs: 200_000, endUs: 300_000 },
    { part: 'c', startUs: 300_000, endUs: 400_000 },
  ])
  const cues = [buildCue(0, 0, 200_000, 'bc')]
  const window = buildWindow(0, 400_000)

  const result = retimeSegmentCues(buildSegment(0, [0]), window, cues, audio)
  assert.equal(result.length, 1)
  assert.equal(result[0].startUs, 200_000)
  assert.equal(result[0].endUs, 400_000)
})
