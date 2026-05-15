import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cuesFromTaskCueSnapshot,
  hasTaskCueContent,
  parseTaskCueFile,
  toTaskCueFileV2,
} from '../src/main/task-cue-codec'
import type { Cue } from '../src/types'

function cue(id: number, text: string): Cue {
  return {
    id,
    startUs: id * 1_000_000,
    endUs: id * 1_000_000 + 500_000,
    text,
  }
}

test('parseTaskCueFile supports v1 payloads', () => {
  const raw = {
    version: 1,
    englishCues: [cue(1, 'Hello')],
    chineseCues: [cue(1, 'Ni hao')],
  }

  const parsed = parseTaskCueFile(raw)
  assert.ok(parsed)
  assert.equal(parsed?.englishCues?.[0]?.text, 'Hello')
  assert.equal(parsed?.chineseCues?.[0]?.text, 'Ni hao')
})

test('parseTaskCueFile ignores legacy translation cache field on v2 payloads', () => {
  const parsed = parseTaskCueFile({
    version: 2,
    englishCues: [cue(0, 'A')],
    translationCache: {
      configSignature: 'legacy',
      segmentTranslations: [{ id: 0, text: 'A-zh' }],
    },
  })

  assert.ok(parsed)
  assert.equal(parsed?.englishCues?.[0]?.text, 'A')
  assert.equal((parsed as { translationCache?: unknown }).translationCache, undefined)
})

test('cuesFromTaskCueSnapshot only returns cue fields and clones values', () => {
  const snapshot = parseTaskCueFile({
    version: 2,
    englishCues: [cue(3, 'Line 3')],
  })
  assert.ok(snapshot)
  if (!snapshot) {
    throw new Error('Expected a parsed snapshot')
  }

  assert.equal(hasTaskCueContent(snapshot), true)

  const cueSet = cuesFromTaskCueSnapshot(snapshot)
  assert.ok(cueSet)
  assert.ok(cueSet?.englishCues)
  assert.equal(cueSet?.englishCues?.[0]?.text, 'Line 3')

  if (!cueSet?.englishCues) {
    throw new Error('Missing english cues')
  }

  cueSet.englishCues[0].text = 'Mutated'
  const fresh = cuesFromTaskCueSnapshot(snapshot)
  assert.equal(fresh?.englishCues?.[0]?.text, 'Line 3')

  const fileV2 = toTaskCueFileV2(snapshot)
  assert.equal(fileV2.version, 2)
  assert.equal((fileV2 as { translationCache?: unknown }).translationCache, undefined)
})
