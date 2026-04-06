import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cuesFromTaskCueSnapshot,
  deserializeTaskTranslationCache,
  hasTaskCueContent,
  parseTaskCueFile,
  serializeTaskTranslationCache,
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

test('parseTaskCueFile supports v1 payloads without translation cache', () => {
  const raw = {
    version: 1,
    englishCues: [cue(1, 'Hello')],
    chineseCues: [cue(1, 'Ni hao')],
  }

  const parsed = parseTaskCueFile(raw)
  assert.ok(parsed)
  assert.equal(parsed?.translationCache, undefined)
  assert.equal(parsed?.englishCues?.[0]?.text, 'Hello')
  assert.equal(parsed?.chineseCues?.[0]?.text, 'Ni hao')
})

test('parseTaskCueFile parses v2 translation cache and filters invalid entries', () => {
  const parsed = parseTaskCueFile({
    version: 2,
    translationCache: {
      configSignature: '{"dictionary":[{"en":"A","zh":"A-zh"}]}',
      segmentTranslations: [
        { id: 0, text: 'A-zh' },
        { id: 'x', text: 'invalid-id' },
        { id: 1, text: 123 },
      ],
    },
  })

  assert.ok(parsed?.translationCache)
  assert.equal(parsed?.translationCache?.segmentTranslations.length, 1)
  assert.deepEqual(parsed?.translationCache?.segmentTranslations[0], { id: 0, text: 'A-zh' })
})

test('serialize/deserialize translation cache keeps map content', () => {
  const serialized = serializeTaskTranslationCache({
    configSignature: 'sig-1',
    segmentTranslations: new Map([
      [0, 'zero'],
      [2, 'two'],
    ]),
  })

  assert.deepEqual(serialized, {
    configSignature: 'sig-1',
    segmentTranslations: [
      { id: 0, text: 'zero' },
      { id: 2, text: 'two' },
    ],
  })

  const deserialized = deserializeTaskTranslationCache(serialized)
  assert.ok(deserialized)
  assert.equal(deserialized?.configSignature, 'sig-1')
  assert.equal(deserialized?.segmentTranslations.get(0), 'zero')
  assert.equal(deserialized?.segmentTranslations.get(2), 'two')
})

test('cuesFromTaskCueSnapshot only returns cue fields and clones values', () => {
  const snapshot = parseTaskCueFile({
    version: 2,
    englishCues: [cue(3, 'Line 3')],
    translationCache: {
      configSignature: 'sig',
      segmentTranslations: [{ id: 3, text: 'line-3-zh' }],
    },
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
  assert.ok(fileV2.translationCache)
})

