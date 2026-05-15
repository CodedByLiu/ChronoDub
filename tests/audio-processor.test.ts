import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProcessedAudio } from '../src/main/services/audio'
import { SR, clipProcessedAudioToWindow } from '../src/main/services/audio'

test('clipProcessedAudioToWindow truncates the final boundary text when audio is hard-clipped', () => {
  const audio: ProcessedAudio = {
    pcm: Buffer.alloc(SR * 2),
    durationUs: 1_000_000,
    spokenText: 'Hello world',
    boundaries: [
      {
        part: 'Hello world',
        startUs: 0,
        endUs: 1_000_000,
      },
    ],
    leadTrimUs: 0,
  }

  const clipped = clipProcessedAudioToWindow(audio, 500_000)

  assert.equal(clipped.spokenText, 'Hello')
  assert.equal(clipped.boundaries[0]?.part, 'Hello')
  assert.equal(clipped.durationUs, 500_000)
})

test('clipProcessedAudioToWindow drops partial ascii fragments when there is no safe cut', () => {
  const audio: ProcessedAudio = {
    pcm: Buffer.alloc(SR * 2),
    durationUs: 1_000_000,
    spokenText: 'ABCDEFGH',
    boundaries: [
      {
        part: 'ABCDEFGH',
        startUs: 0,
        endUs: 1_000_000,
      },
    ],
    leadTrimUs: 0,
  }

  const clipped = clipProcessedAudioToWindow(audio, 500_000)

  assert.equal(clipped.spokenText, '')
  assert.equal(clipped.boundaries.length, 0)
  assert.equal(clipped.durationUs, 500_000)
})
