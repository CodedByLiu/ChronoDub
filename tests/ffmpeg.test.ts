import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDisplaySize } from '../src/main/services/ffmpeg'

test('resolveDisplaySize swaps display dimensions for 90 degree rotation', () => {
  const result = resolveDisplaySize({
    width: 1920,
    height: 1080,
    sample_aspect_ratio: '1:1',
    tags: { rotate: '90' },
  })

  assert.deepEqual(result, {
    displayWidth: 1080,
    displayHeight: 1920,
    rotationDegrees: 90,
  })
})

test('resolveDisplaySize applies sample aspect ratio before rotation', () => {
  const result = resolveDisplaySize({
    width: 1440,
    height: 1080,
    sample_aspect_ratio: '4:3',
    side_data_list: [{ rotation: 270 }],
  })

  assert.deepEqual(result, {
    displayWidth: 1080,
    displayHeight: 1920,
    rotationDegrees: 270,
  })
})
