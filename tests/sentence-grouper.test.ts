import assert from 'node:assert/strict'
import test from 'node:test'
import type { Cue, LLMConfig, MicrosecondTimestamp } from '../src/types'
import { groupSentencesWithLLM, type RequestJsonFn } from '../src/main/services/sentence-grouper'

const TEST_LLM: LLMConfig = {
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  apiKey: 'k',
}
import {
  buildSegmentsFromGroups,
  groupCuesByGap,
  joinGroupTextForTranslation,
} from '../src/main/services/audio-segmentation'

function cue(id: number, startMs: number, endMs: number, text: string): Cue {
  return {
    id,
    startUs: (startMs * 1_000) as MicrosecondTimestamp,
    endUs: (endMs * 1_000) as MicrosecondTimestamp,
    text,
  }
}

function makeRequestJson(responses: Array<unknown | Error>): RequestJsonFn {
  let i = 0
  return (async () => {
    const r = responses[i++]
    if (r instanceof Error) throw r
    return r as never
  }) as RequestJsonFn
}

test('groupSentencesWithLLM: single chunk, LLM returns one group', async () => {
  const cues = [cue(1, 0, 1000, 'a'), cue(2, 1100, 2000, 'b'), cue(3, 2100, 3000, 'c')]
  const requestJson = makeRequestJson([{ groups: [[1, 2, 3]] }])
  const { groups, usedFallback } = await groupSentencesWithLLM(cues, {
    llm: TEST_LLM,
    requestJson,
  })
  assert.equal(usedFallback, false)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].cueIds, [1, 2, 3])
})

test('groupSentencesWithLLM: two chunks with overlap, later chunk wins', async () => {
  const cues: Cue[] = []
  for (let i = 1; i <= 50; i++) cues.push(cue(i, i * 1000, i * 1000 + 500, `t${i}`))
  // chunk 1: ids 1..40, chunk 2: ids 37..50 (overlap of 4 ids)
  // chunk 1 boundary at id 38 inside overlap should be ignored; chunk 2's boundary at 50 (last) used
  const chunk1Resp = { groups: [Array.from({ length: 38 }, (_, k) => k + 1), [39, 40]] }
  const chunk2Resp = { groups: [Array.from({ length: 14 }, (_, k) => k + 37)] }
  const requestJson = makeRequestJson([chunk1Resp, chunk2Resp])
  const { groups, usedFallback } = await groupSentencesWithLLM(cues, {
    llm: TEST_LLM,
    requestJson,
  })
  assert.equal(usedFallback, false)
  // chunk1's group ending at 38 is inside the overlap (positions 37-40 of chunk1) → dropped
  // chunk1's group ending at 40 is the last of chunk1 → also inside overlap window → dropped
  // chunk2 is last chunk so all its boundaries kept; chunk2 says one big group ending at 50
  // Result: one big group spanning all 50 cues
  assert.equal(groups.length, 1)
  assert.equal(groups[0].cueIds.length, 50)
})

test('groupSentencesWithLLM: malformed response falls back per-chunk', async () => {
  const cues = [cue(1, 0, 1000, 'a'), cue(2, 1100, 2000, 'b')]
  const requestJson = makeRequestJson([{ groups: [[1]] }]) // missing id 2
  const { groups, usedFallback } = await groupSentencesWithLLM(cues, {
    llm: TEST_LLM,
    requestJson,
  })
  assert.equal(usedFallback, true)
  // fallback for the chunk groups 1 and 2 by gap (100ms ≤ 200ms threshold) → one group
  assert.equal(groups.length, 1)
})

test('groupSentencesWithLLM: network error falls back', async () => {
  const cues = [cue(1, 0, 1000, 'a'), cue(2, 5000, 6000, 'b')] // 4s gap
  const requestJson = makeRequestJson([new Error('boom')])
  const { groups, usedFallback } = await groupSentencesWithLLM(cues, {
    llm: TEST_LLM,
    requestJson,
  })
  assert.equal(usedFallback, true)
  // gap 4s exceeds 200ms → 2 groups via fallback
  assert.equal(groups.length, 2)
})

test('groupSentencesWithLLM: empty apiKey skips LLM and falls back', async () => {
  const cues = [cue(1, 0, 1000, 'a'), cue(2, 1100, 2000, 'b')]
  let called = false
  const requestJson: RequestJsonFn = (async () => {
    called = true
    return {} as never
  }) as RequestJsonFn
  const { groups, usedFallback } = await groupSentencesWithLLM(cues, {
    llm: { ...TEST_LLM, apiKey: '' },
    requestJson,
  })
  assert.equal(called, false)
  assert.equal(usedFallback, true)
  assert.equal(groups.length, 1)
})

test('buildSegmentsFromGroups: typical sentence with 12s span stays as one segment', () => {
  const cues = [
    cue(1, 0, 2000, 'Let me show you'),
    cue(2, 2100, 4000, 'how this works'),
    cue(3, 8000, 10000, 'in practice'),
    cue(4, 10100, 12000, 'today.'),
  ]
  // span = 12s, joined text well under 320 chars → no split
  const segments = buildSegmentsFromGroups(cues, [{ cueIds: [1, 2, 3, 4] }])
  assert.equal(segments.length, 1)
  assert.deepEqual(segments[0].cueIds, [1, 2, 3, 4])
})

test('buildSegmentsFromGroups: group with >320 chars text gets split at largest gap', () => {
  const chunk = 'word '.repeat(24).trim() // 119 chars; joined with " " between cues
  const cues = [
    cue(1, 0, 2000, chunk),
    cue(2, 2100, 4000, chunk),
    cue(3, 8000, 10000, chunk), // 4s gap — largest, split here
  ]
  // total joined ~ 359 chars > 320 → split. After split at gap-3:
  //   left  [1,2] joined ~ 239 chars ≤ 320 → keep
  //   right [3]   = 119 chars → keep
  const segments = buildSegmentsFromGroups(cues, [{ cueIds: [1, 2, 3] }])
  assert.equal(segments.length, 2)
  assert.deepEqual(segments[0].cueIds, [1, 2])
  assert.deepEqual(segments[1].cueIds, [3])
})

test('joinGroupTextForTranslation strips trailing commas on middle cues', () => {
  const text = joinGroupTextForTranslation(['hello,', 'world.'])
  assert.equal(text, 'hello world.')
})

test('joinGroupTextForTranslation preserves period at end of last cue', () => {
  const text = joinGroupTextForTranslation(['He said.', 'Then he left.'])
  assert.equal(text, 'He said. Then he left.')
})

test('groupCuesByGap: 200ms threshold merges close cues', () => {
  const groups = groupCuesByGap([
    cue(1, 0, 1000, 'a'),
    cue(2, 1150, 2000, 'b'),
    cue(3, 2300, 3000, 'c'),
  ])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].cueIds, [1, 2])
  assert.deepEqual(groups[1].cueIds, [3])
})

test('buildSegmentsFromGroups: segment.startUs/endUs span the group', () => {
  const cues = [cue(1, 100, 1100, 'a'), cue(2, 2000, 3000, 'b')]
  const segments = buildSegmentsFromGroups(cues, [{ cueIds: [1, 2] }])
  assert.equal(segments.length, 1)
  assert.equal(segments[0].startUs, 100_000)
  assert.equal(segments[0].endUs, 3_000_000)
})
