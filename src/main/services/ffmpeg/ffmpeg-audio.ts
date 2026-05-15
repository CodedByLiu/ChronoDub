import { spawn } from 'child_process'
import { getFFmpegPath } from './ffmpeg-binary'

export function decodeMp3ToPcm(mp3Buffer: Buffer, sampleRate = 48000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      getFFmpegPath(),
      ['-i', 'pipe:0', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )

    const chunks: Buffer[] = []
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`FFmpeg decode exited with code: ${code}`))
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
  return trimSilenceDetailed(pcmBuffer, sampleRate, thresholdDb, minDurationMs).buffer
}

export interface TrimSilenceResult {
  buffer: Buffer
  startSample: number
  endSample: number
}

export function trimSilenceDetailed(
  pcmBuffer: Buffer,
  sampleRate = 48000,
  thresholdDb = -40,
  minDurationMs = 60
): TrimSilenceResult {
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 2)
  const totalSamples = samples.length
  if (totalSamples === 0) {
    return {
      buffer: pcmBuffer,
      startSample: 0,
      endSample: 0,
    }
  }

  const threshold = Math.pow(10, thresholdDb / 20) * 32768
  const frameSamples = Math.round((20 / 1000) * sampleRate)
  const minFrames = Math.ceil(minDurationMs / 20)

  let startSample = 0
  let endSample = totalSamples

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
      return {
        buffer: Buffer.alloc(0),
        startSample: totalSamples,
        endSample: totalSamples,
      }
    }
  }

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

  if (startSample >= endSample) {
    return {
      buffer: Buffer.alloc(0),
      startSample,
      endSample,
    }
  }

  return {
    buffer: Buffer.from(
      samples.buffer,
      samples.byteOffset + startSample * 2,
      (endSample - startSample) * 2
    ),
    startSample,
    endSample,
  }
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
  const sampleCount = pcmBuffer.byteLength / 2
  return Math.round((sampleCount / sampleRate) * 1_000_000)
}

export function writePcmToWav(
  pcmBuffer: Buffer,
  outputPath: string,
  sampleRate = 48000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      getFFmpegPath(),
      [
        '-y',
        '-f',
        's16le',
        '-ar',
        String(sampleRate),
        '-ac',
        '1',
        '-i',
        'pipe:0',
        '-c:a',
        'pcm_s16le',
        outputPath,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`FFmpeg WAV write failed (${code})`))
      resolve()
    })
    proc.on('error', reject)

    proc.stdin.write(pcmBuffer)
    proc.stdin.end()
  })
}
