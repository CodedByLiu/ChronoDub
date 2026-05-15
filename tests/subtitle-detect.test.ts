import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectSubtitleForVideo } from '../src/main/services/subtitle'

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'chronodub-detect-'))
  try {
    await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('does not fallback to a lone unrelated Chinese subtitle', async () => {
  await withTempDir(async (dir) => {
    const videoPath = join(dir, 'lesson.mp4')
    const subtitlePath = join(dir, 'subtitle.srt')

    writeFileSync(videoPath, '')
    writeFileSync(
      subtitlePath,
      `1
00:00:00,000 --> 00:00:02,000
这是中文字幕
`,
      'utf-8'
    )

    assert.equal(await detectSubtitleForVideo(videoPath), null)
  })
})

test('falls back to a lone unrelated English subtitle when it is the only subtitle track', async () => {
  await withTempDir(async (dir) => {
    const videoPath = join(dir, 'lesson.mp4')
    const subtitlePath = join(dir, 'subtitle.srt')

    writeFileSync(videoPath, '')
    writeFileSync(
      subtitlePath,
      `1
00:00:00,000 --> 00:00:02,000
This is the original English subtitle.
`,
      'utf-8'
    )

    assert.equal(await detectSubtitleForVideo(videoPath), subtitlePath)
  })
})

test('uses parsed ASS text for lone-subtitle fallback even with custom field order', async () => {
  await withTempDir(async (dir) => {
    const videoPath = join(dir, 'lesson.mp4')
    const subtitlePath = join(dir, 'subtitle.ass')

    writeFileSync(videoPath, '')
    writeFileSync(
      subtitlePath,
      `[Script Info]
Title: sample

[Events]
Format: Layer, Start, End, Text, Style, Name, MarginL, MarginR, MarginV, Effect
Dialogue: 0,0:00:00.00,0:00:02.00,This is still English,Default,,0,0,0,
`,
      'utf-8'
    )

    assert.equal(await detectSubtitleForVideo(videoPath), subtitlePath)
  })
})

test('prefers distributed English sample over bilingual intro noise', async () => {
  await withTempDir(async (dir) => {
    const videoPath = join(dir, 'lesson.mp4')
    const englishVttPath = join(dir, 'lesson.vtt')
    const chineseSrtPath = join(dir, 'lesson.srt')

    writeFileSync(videoPath, '')
    writeFileSync(
      englishVttPath,
      `WEBVTT

00:00:00.000 --> 00:00:01.000
[Music]

00:00:01.000 --> 00:00:02.000
你好 Hello

00:05:00.000 --> 00:05:02.000
This section is entirely in English and explains the next step clearly.
`,
      'utf-8'
    )
    writeFileSync(
      chineseSrtPath,
      `1
00:00:00,000 --> 00:00:02,000
这是中文字幕
`,
      'utf-8'
    )

    assert.equal(await detectSubtitleForVideo(videoPath), englishVttPath)
  })
})

test('does not fallback to a lone mixed bilingual subtitle with low confidence', async () => {
  await withTempDir(async (dir) => {
    const videoPath = join(dir, 'lesson.mp4')
    const subtitlePath = join(dir, 'subtitle.vtt')

    writeFileSync(videoPath, '')
    writeFileSync(
      subtitlePath,
      `WEBVTT

00:00:00.000 --> 00:00:01.000
你好 Hello

00:00:01.000 --> 00:00:02.000
欢迎 Welcome
`,
      'utf-8'
    )

    assert.equal(await detectSubtitleForVideo(videoPath), null)
  })
})
