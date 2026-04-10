import assert from 'node:assert/strict'
import test from 'node:test'
import { renderAssSubtitles } from '../src/main/services/subtitle-renderer'
import type { Cue, SubtitleStyleConfig } from '../src/types'

const baseStyle: SubtitleStyleConfig = {
  fontFamily: 'Arial',
  fontSize: 48,
  bold: false,
  italic: false,
  textColor: '#FFFFFF',
  outlineEnabled: true,
  outlineWidth: 3,
  outlineColor: '#000000',
  backgroundEnabled: false,
  backgroundColor: '#000000',
  backgroundOpacity: 55,
  backgroundPadding: 0,
  position: 'bottom-safe',
  safeMargin: 72,
}

const cues: Cue[] = [
  {
    id: 1,
    startUs: 0,
    endUs: 1_500_000,
    text: '第一行字幕',
  },
]

test('renderAssSubtitles emits bottom-safe subtitle style', () => {
  const ass = renderAssSubtitles(cues, baseStyle)

  assert.match(ass, /PlayResX: 1920/)
  assert.match(ass, /PlayResY: 1080/)
  assert.match(ass, /Style: Text,Arial,48,/)
  assert.doesNotMatch(ass, /Style: Bg,/)
  assert.match(ass, /,2,120,120,72,1/)
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:01\.50,Text,,0,0,0,,第一行字幕/)
})

test('renderAssSubtitles switches to top-safe alignment and background box', () => {
  const ass = renderAssSubtitles(cues, {
    ...baseStyle,
    position: 'top-safe',
    backgroundEnabled: true,
    backgroundColor: '#FFA500',
    backgroundOpacity: 60,
  })

  assert.match(ass, /BorderStyle, Outline, Shadow, Alignment/)
  assert.match(
    ass,
    /Style: Bg,Arial,48,&HFF000000,&HFF000000,&H00000000,&H6600A5FF,0,0,0,0,100,100,0,0,3,3,0,8,120,120,72,1/
  )
  assert.match(
    ass,
    /Style: Text,Arial,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,4,8,120,120,72,1/
  )
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:01\.50,Bg,,0,0,0,,第一行字幕/)
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:01\.50,Text,,0,0,0,,第一行字幕/)
})

test('renderAssSubtitles writes bold and italic flags when enabled', () => {
  const ass = renderAssSubtitles(cues, {
    ...baseStyle,
    bold: true,
    italic: true,
  })

  assert.match(
    ass,
    /Style: Text,Arial,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,-1,0,0,100,100,0,0,1,3,0,2,120,120,72,1/
  )
})

test('renderAssSubtitles adapts play resolution and typography to the current video size', () => {
  const ass = renderAssSubtitles(cues, baseStyle, { width: 1280, height: 720 })

  assert.match(ass, /PlayResX: 1280/)
  assert.match(ass, /PlayResY: 720/)
  assert.match(ass, /Style: Text,Arial,32,/)
  assert.match(ass, /,2,80,80,48,1/)
})

test('renderAssSubtitles uses two-layer rendering so background padding has no text outline when outline disabled', () => {
  const ass = renderAssSubtitles(cues, {
    ...baseStyle,
    backgroundEnabled: true,
    outlineEnabled: false,
    backgroundPadding: 12,
  })

  assert.match(
    ass,
    /Style: Bg,Arial,48,&HFF000000,&HFF000000,&H00000000,&H73000000,0,0,0,0,100,100,0,0,3,12,0,2,120,120,72,1/
  )
  assert.match(
    ass,
    /Style: Text,Arial,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,120,120,72,1/
  )
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:01\.50,Bg,,0,0,0,,第一行字幕/)
  assert.match(ass, /Dialogue: 1,0:00:00\.00,0:00:01\.50,Text,,0,0,0,,第一行字幕/)
})
