import assert from 'node:assert/strict'
import test from 'node:test'
import type { Cue, MicrosecondTimestamp } from '../src/types'
import { splitOverlongCuesByPunctuation } from '../src/main/services/subtitle'

function cue(id: number, startMs: number, endMs: number, text: string): Cue {
  return {
    id,
    startUs: (startMs * 1_000) as MicrosecondTimestamp,
    endUs: (endMs * 1_000) as MicrosecondTimestamp,
    text,
  }
}

test('splitOverlongCuesByPunctuation: short cues pass through unchanged', () => {
  const input = [
    cue(1, 0, 3000, 'Short cue. Another short. And another.'),
    cue(2, 3000, 5000, 'Still short.'),
  ]
  const out = splitOverlongCuesByPunctuation(input)
  // Same array reference returned (no mutation) since nothing changed
  assert.equal(out.length, 2)
  assert.equal(out[0].id, 1)
  assert.equal(out[1].id, 2)
})

test('splitOverlongCuesByPunctuation: 11s cue with 2+ ". X" boundaries gets split', () => {
  // 11 seconds, contains 3 sentences with capital-letter starts
  const text =
    'As science evolves, things change. I think it is time for us to act. So we are going to dive in.'
  const out = splitOverlongCuesByPunctuation([cue(5, 0, 11000, text)])
  assert.ok(out.length >= 3, `expected ≥3 sub-cues, got ${out.length}: ${JSON.stringify(out.map((c) => c.text))}`)

  // Time budget preserved end-to-end
  assert.equal(out[0].startUs, 0)
  assert.equal(out[out.length - 1].endUs, 11_000_000)

  // Sub-cues are contiguous (no gaps, no overlaps)
  for (let i = 1; i < out.length; i++) {
    assert.equal(out[i].startUs, out[i - 1].endUs, `cue ${i} should start at previous end`)
  }

  // Concatenated text covers original (modulo whitespace at split boundaries)
  const joined = out.map((c) => c.text).join(' ').replace(/\s+/g, ' ')
  assert.equal(joined.replace(/\s+/g, ''), text.replace(/\s+/g, ''))
})

test('splitOverlongCuesByPunctuation: long cue but only 1 ". X" stays whole', () => {
  // 8 seconds, only one ". X" boundary → not enough to justify splitting (need ≥2)
  const text = 'This is a long cue but only has one boundary. The rest continues without further breaks'
  const out = splitOverlongCuesByPunctuation([cue(1, 0, 8000, text)])
  assert.equal(out.length, 1)
  assert.equal(out[0].text, text)
})

test('splitOverlongCuesByPunctuation: decimal point does NOT trigger split', () => {
  // "1.5 times" — period not followed by capital — should NOT count as boundary
  const text =
    'The value is approximately 1.5 times the original. Then we observe another 2.3 times increase later in the cycle which is interesting.'
  const out = splitOverlongCuesByPunctuation([cue(1, 0, 8000, text)])
  // Only one valid ". The" boundary inside → fewer than 2 → stays whole
  assert.equal(out.length, 1, `decimals shouldn't trigger split, got ${out.length} parts`)
})

test('splitOverlongCuesByPunctuation: new ids do not collide with existing ones', () => {
  const text =
    'First sentence here. Second sentence here. Third sentence here as well to satisfy the boundary count.'
  const input = [
    cue(7, 0, 8000, text),
    cue(2, 9000, 10000, 'next cue'),
  ]
  const out = splitOverlongCuesByPunctuation(input)
  const ids = out.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, `ids must be unique, got ${ids.join(',')}`)
  // Original id 2 must still exist (untouched cue)
  assert.ok(ids.includes(2))
})

test('splitOverlongCuesByPunctuation: empty input returns empty', () => {
  assert.deepEqual(splitOverlongCuesByPunctuation([]), [])
})
