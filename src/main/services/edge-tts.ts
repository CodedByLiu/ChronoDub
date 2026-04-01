import { EdgeTTS } from 'node-edge-tts'
import { readFileSync, unlinkSync, existsSync } from 'fs'
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
  return limit(() => synthesizeWithRetry(text, voice, rate, volume, pitch))
}

async function synthesizeWithRetry(
  text: string,
  voice: string,
  rate: string,
  volume: string,
  pitch: string
): Promise<Buffer> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const tmpPath = tempMp3Path()
    try {
      const tts = new EdgeTTS({
        voice,
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        rate,
        pitch,
        volume,
        timeout: 15000,
      })

      await tts.ttsPromise(text, tmpPath)

      if (!existsSync(tmpPath)) throw new Error('TTS 未生成音频文件')

      const buf = readFileSync(tmpPath)
      if (buf.length === 0) throw new Error('TTS 生成空音频文件')

      return buf
    } catch (err: any) {
      lastError = err
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt)
      await new Promise((r) => setTimeout(r, backoff))
    } finally {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath)
      } catch {}
    }
  }

  throw lastError || new Error('TTS 合成失败')
}

export async function synthesizeToBuffer(text: string, voice: string): Promise<ArrayBuffer> {
  const buf = await synthesize(text, voice)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}
