import assert from 'node:assert/strict'
import test from 'node:test'
import type { Cue, MicrosecondTimestamp, Segment } from '../src/types'
import {
  allocateProportionalTimings,
  partitionChineseBySentence,
  repartitionCuesPerSegment,
} from '../src/main/services/subtitle'

function cue(id: number, startMs: number, endMs: number, text: string): Cue {
  return {
    id,
    startUs: (startMs * 1_000) as MicrosecondTimestamp,
    endUs: (endMs * 1_000) as MicrosecondTimestamp,
    text,
  }
}

function segment(id: number, cueIds: number[], textEn = ''): Segment {
  return {
    id,
    cueIds,
    textEn,
    startUs: 0 as MicrosecondTimestamp,
    endUs: 0 as MicrosecondTimestamp,
  }
}

test('partitionChineseBySentence: splits at 。and ？', () => {
  const parts = partitionChineseBySentence('我们来看看这个例子。下一步是什么？')
  assert.deepEqual(parts, ['我们来看看这个例子。', '下一步是什么？'])
})

test('partitionChineseBySentence: short sentence stays as one', () => {
  const parts = partitionChineseBySentence('这是一个很长的句子需要分多个层次来理解。')
  assert.equal(parts.length, 1)
})

test('partitionChineseBySentence: no orphan period scenario', () => {
  // Regression: original bug produced "了。" as standalone cue
  const parts = partitionChineseBySentence('还要把它放到分母上了。')
  assert.deepEqual(parts, ['还要把它放到分母上了。'])
})

test('partitionChineseBySentence: long sentence with comma soft-splits at comma', () => {
  // 25-char prefix + comma + 25-char suffix + period = 52 chars
  const long =
    '这是一个非常非常非常非常长的句子前面部分内容很多，' +
    '后面继续表达更多信息但是还要再加一些字凑长度。'
  const parts = partitionChineseBySentence(long, 40, 30)
  assert.ok(parts.length >= 2, `expected ≥2 parts, got ${parts.length}: ${JSON.stringify(parts)}`)
  assert.ok(parts[0].endsWith('，') || parts[0].endsWith('。'))
})

test('partitionChineseBySentence: long sentence no punctuation, hard split', () => {
  const text = '甲'.repeat(50)
  const parts = partitionChineseBySentence(text, 40, 30)
  assert.ok(parts.length >= 2)
  for (const p of parts) {
    assert.ok(p.length <= 30, `each chunk should be ≤30 chars, got ${p.length}`)
  }
  assert.equal(parts.join(''), text)
})

test('allocateProportionalTimings: distributes proportionally', () => {
  const timings = allocateProportionalTimings(['A', 'BB', 'CCC'], 0, 600_000)
  assert.equal(timings.length, 3)
  assert.equal(timings[0].startUs, 0)
  // 1:2:3 ratio → boundaries at 100k and 300k
  assert.equal(timings[0].endUs, 100_000)
  assert.equal(timings[1].startUs, 100_000)
  assert.equal(timings[1].endUs, 300_000)
  assert.equal(timings[2].startUs, 300_000)
  assert.equal(timings[2].endUs, 600_000)
})

test('allocateProportionalTimings: single part spans full window', () => {
  const timings = allocateProportionalTimings(['hello'], 100, 500)
  assert.deepEqual(timings, [{ startUs: 100, endUs: 500 }])
})

test('repartitionCuesPerSegment: splits multi-sentence segment', () => {
  const cues = [
    cue(1, 0, 4000, '我们来看看这个例子。'),
    cue(2, 4500, 8000, '下一步是什么？'),
  ]
  const seg = segment(0, [1, 2])
  const result = repartitionCuesPerSegment(cues, [seg])
  assert.equal(result.length, 2)
  assert.equal(result[0].text, '我们来看看这个例子。')
  assert.equal(result[1].text, '下一步是什么？')
  assert.ok(result[0].id !== 1 && result[0].id !== 2)
})

test('repartitionCuesPerSegment: merges 2 original cues holding 1 sentence', () => {
  // Original bug: 2 cues "还要把它放到分母上" + "了。" → orphan period
  const cues = [
    cue(1, 0, 4000, '还要把它放到分母上'),
    cue(2, 4100, 4500, '了。'),
  ]
  const seg = segment(0, [1, 2])
  const result = repartitionCuesPerSegment(cues, [seg])
  assert.equal(result.length, 1)
  assert.equal(result[0].text, '还要把它放到分母上了。')
  assert.equal(result[0].startUs, 0)
  assert.equal(result[0].endUs, 4_500_000)
})

test('repartitionCuesPerSegment: passes through unclaimed cues', () => {
  const cues = [cue(1, 0, 1000, '已分配'), cue(99, 5000, 6000, '游离 cue')]
  const seg = segment(0, [1])
  const result = repartitionCuesPerSegment(cues, [seg])
  assert.equal(result.length, 2)
  assert.equal(result.find((c) => c.text === '游离 cue')?.id, 99)
})
