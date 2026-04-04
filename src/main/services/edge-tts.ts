import { EdgeTTS } from 'node-edge-tts'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import pLimit from 'p-limit'

const TTS_CONCURRENCY = 2
const MAX_RETRIES = 3
const INITIAL_BACKOFF_MS = 1000
const VOICES_API =
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4'

const pLimitCompat = ((pLimit as any).default ?? pLimit) as typeof pLimit
const limit = pLimitCompat(TTS_CONCURRENCY)

interface VoiceInfo {
  name: string
  locale: string
  gender: string
}

export interface TtsBoundary {
  part: string
  startMs: number
  endMs: number
}

export interface TtsSynthesisResult {
  audio: Buffer
  boundaries: TtsBoundary[]
  spokenText: string
}

let cachedVoices: VoiceInfo[] | null = null

export async function getChineseVoices(): Promise<VoiceInfo[]> {
  if (cachedVoices) return cachedVoices

  try {
    const res = await fetch(VOICES_API)
    if (!res.ok) throw new Error(`Voice API ${res.status}`)
    const allVoices: any[] = await res.json()

    cachedVoices = allVoices
      .filter((v) => v.Locale === 'zh-CN')
      .map((v) => ({
        name: v.ShortName as string,
        locale: v.Locale as string,
        gender: v.Gender as string,
      }))
  } catch {
    cachedVoices = ZH_CN_VOICES_FALLBACK
  }

  return cachedVoices
}

const ZH_CN_VOICES_FALLBACK: VoiceInfo[] = [
  { name: 'zh-CN-XiaoxiaoNeural', locale: 'zh-CN', gender: 'Female' },
  { name: 'zh-CN-XiaoyiNeural', locale: 'zh-CN', gender: 'Female' },
  { name: 'zh-CN-YunjianNeural', locale: 'zh-CN', gender: 'Male' },
  { name: 'zh-CN-YunxiNeural', locale: 'zh-CN', gender: 'Male' },
  { name: 'zh-CN-YunxiaNeural', locale: 'zh-CN', gender: 'Male' },
  { name: 'zh-CN-YunyangNeural', locale: 'zh-CN', gender: 'Male' },
  { name: 'zh-CN-XiaochenNeural', locale: 'zh-CN', gender: 'Female' },
  { name: 'zh-CN-XiaohanNeural', locale: 'zh-CN', gender: 'Female' },
  { name: 'zh-CN-XiaomengNeural', locale: 'zh-CN', gender: 'Female' },
  { name: 'zh-CN-XiaomoNeural', locale: 'zh-CN', gender: 'Female' },
  { name: 'zh-CN-XiaoruiNeural', locale: 'zh-CN', gender: 'Female' },
  { name: 'zh-CN-XiaoxuanNeural', locale: 'zh-CN', gender: 'Female' },
  { name: 'zh-CN-XiaoyanNeural', locale: 'zh-CN', gender: 'Female' },
  { name: 'zh-CN-XiaozhenNeural', locale: 'zh-CN', gender: 'Female' },
  { name: 'zh-CN-YunfengNeural', locale: 'zh-CN', gender: 'Male' },
  { name: 'zh-CN-YunhaoNeural', locale: 'zh-CN', gender: 'Male' },
  { name: 'zh-CN-YunzeNeural', locale: 'zh-CN', gender: 'Male' },
]

function tempMp3Path(): string {
  return join(tmpdir(), `chronodub-tts-${randomBytes(8).toString('hex')}.mp3`)
}

export async function synthesize(
  text: string,
  voice: string,
  rate = 'default',
  volume = 'default',
  pitch = 'default'
): Promise<Buffer> {
  const result = await synthesizeDetailed(text, voice, rate, volume, pitch)
  return result.audio
}

export async function synthesizeDetailed(
  text: string,
  voice: string,
  rate = 'default',
  volume = 'default',
  pitch = 'default'
): Promise<TtsSynthesisResult> {
  if (!voice?.trim()) {
    throw new Error('未选择 TTS 声音')
  }

  return limit(() => synthesizeWithRetry(text, voice, rate, volume, pitch))
}

async function synthesizeWithRetry(
  text: string,
  voice: string,
  rate: string,
  volume: string,
  pitch: string
): Promise<TtsSynthesisResult> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const tmpPath = tempMp3Path()
    const tmpSubtitlePath = `${tmpPath}.json`

    try {
      const tts = new EdgeTTS({
        voice,
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        saveSubtitles: true,
        rate,
        pitch,
        volume,
        timeout: 15000,
      })

      await tts.ttsPromise(text, tmpPath)

      if (!existsSync(tmpPath)) throw new Error('TTS 未生成音频文件')

      const audio = readFileSync(tmpPath)
      if (audio.length === 0) throw new Error('TTS 生成空音频文件')

      return {
        audio,
        boundaries: loadBoundaryFile(tmpSubtitlePath),
        spokenText: text,
      }
    } catch (err: any) {
      lastError = err
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt)
      await new Promise((resolve) => setTimeout(resolve, backoff))
    } finally {
      safeUnlink(tmpPath)
      safeUnlink(tmpSubtitlePath)
    }
  }

  throw lastError || new Error('TTS 合成失败')
}

export async function synthesizeToBuffer(text: string, voice: string): Promise<ArrayBuffer> {
  const buf = await synthesize(text, voice)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

function loadBoundaryFile(filePath: string): TtsBoundary[] {
  if (!existsSync(filePath)) return []

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Array<{
      part?: unknown
      start?: unknown
      end?: unknown
    }>

    return raw
      .map((item) => ({
        part: typeof item.part === 'string' ? item.part : '',
        startMs: typeof item.start === 'number' ? item.start : 0,
        endMs: typeof item.end === 'number' ? item.end : 0,
      }))
      .filter((item) => item.part.trim() && item.endMs > item.startMs)
  } catch {
    return []
  }
}

function safeUnlink(filePath: string): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath)
  } catch {
    /* noop */
  }
}
