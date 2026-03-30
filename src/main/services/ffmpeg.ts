import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'

function getResourcesPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin')
  }
  return join(dirname(app.getAppPath()), 'resources', 'bin')
}

function findBinary(name: string): string {
  const resourceBin = join(getResourcesPath(), process.platform === 'win32' ? `${name}.exe` : name)
  if (existsSync(resourceBin)) return resourceBin

  return name
}

let ffmpegPath: string | null = null
let ffprobePath: string | null = null

export function getFFmpegPath(): string {
  if (!ffmpegPath) ffmpegPath = findBinary('ffmpeg')
  return ffmpegPath
}

export function getFFprobePath(): string {
  if (!ffprobePath) ffprobePath = findBinary('ffprobe')
  return ffprobePath
}

export interface ProbeResult {
  durationUs: number
  audioCodec: string | null
  audioSampleRate: number | null
  audioChannels: number | null
}

export function ffprobe(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(
      getFFprobePath(),
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe 失败: ${err.message}`))
        try {
          const info = JSON.parse(stdout)
          const durationSec = parseFloat(info.format?.duration || '0')
          const audioStream = info.streams?.find((s: any) => s.codec_type === 'audio')

          resolve({
            durationUs: Math.round(durationSec * 1_000_000),
            audioCodec: audioStream?.codec_name || null,
            audioSampleRate: audioStream ? parseInt(audioStream.sample_rate) : null,
            audioChannels: audioStream ? parseInt(audioStream.channels) : null,
          })
        } catch (parseErr) {
          reject(new Error(`ffprobe 解析失败: ${parseErr}`))
        }
      }
    )
  })
}

export function decodeMp3ToPcm(mp3Buffer: Buffer, sampleRate = 48000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFFmpegPath(), [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', String(sampleRate),
      '-ac', '1',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    const chunks: Buffer[] = []
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`FFmpeg decode 退出码: ${code}`))
      resolve(Buffer.concat(chunks))
    })
    proc.on('error', reject)

    proc.stdin.write(mp3Buffer)
    proc.stdin.end()
  })
}

export function trimSilence(
  pcmBuffer: Buffer,
  sampleRate = 48000,
  thresholdDb = -40,
  minDurationMs = 60
): Buffer {
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.byteLength / 2
  )
  const totalSamples = samples.length
  if (totalSamples === 0) return pcmBuffer

  const threshold = Math.pow(10, thresholdDb / 20) * 32768
  const frameSamples = Math.round((20 / 1000) * sampleRate) // 20ms frame
  const minFrames = Math.ceil(minDurationMs / 20)

  let startSample = 0
  let endSample = totalSamples

  // Trim leading silence
  let silentFrames = 0
  for (let i = 0; i < totalSamples; i += frameSamples) {
    const frameEnd = Math.min(i + frameSamples, totalSamples)
    const rms = computeRms(samples, i, frameEnd)
    if (rms > threshold) {
      startSample = Math.max(0, i - frameSamples)
      break
    }
    silentFrames++
    if (silentFrames >= Math.ceil(totalSamples / frameSamples)) {
      return Buffer.alloc(0)
    }
  }

  // Trim trailing silence
  silentFrames = 0
  for (let i = totalSamples; i > startSample; i -= frameSamples) {
    const frameStart = Math.max(i - frameSamples, 0)
    const rms = computeRms(samples, frameStart, i)
    if (rms > threshold) {
      endSample = Math.min(totalSamples, i + frameSamples)
      break
    }
    silentFrames++
    if (silentFrames >= minFrames) {
      endSample = Math.max(startSample, i)
      break
    }
  }

  if (startSample >= endSample) return Buffer.alloc(0)

  return Buffer.from(
    samples.buffer,
    samples.byteOffset + startSample * 2,
    (endSample - startSample) * 2
  )
}

function computeRms(samples: Int16Array, start: number, end: number): number {
  let sum = 0
  const count = end - start
  if (count <= 0) return 0
  for (let i = start; i < end; i++) {
    sum += samples[i] * samples[i]
  }
  return Math.sqrt(sum / count)
}

export function measurePcmDurationUs(pcmBuffer: Buffer, sampleRate = 48000): number {
  const sampleCount = pcmBuffer.byteLength / 2 // 16-bit mono
  return Math.round((sampleCount / sampleRate) * 1_000_000)
}

export function muxVideoWithAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-shortest',
      outputPath,
    ]

    const proc = spawn(getFFmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`FFmpeg mux 失败 (${code}): ${stderr.slice(-500)}`))
      resolve()
    })
    proc.on('error', reject)
  })
}

export function writePcmToWav(pcmBuffer: Buffer, outputPath: string, sampleRate = 48000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFFmpegPath(), [
      '-y',
      '-f', 's16le',
      '-ar', String(sampleRate),
      '-ac', '1',
      '-i', 'pipe:0',
      '-c:a', 'pcm_s16le',
      outputPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`FFmpeg WAV 写入失败 (${code})`))
      resolve()
    })
    proc.on('error', reject)

    proc.stdin.write(pcmBuffer)
    proc.stdin.end()
  })
}
