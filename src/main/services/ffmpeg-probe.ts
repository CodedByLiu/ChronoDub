import { execFile } from 'child_process'
import { getFFprobePath } from './ffmpeg-binary'

export interface ProbeResult {
  durationUs: number
  audioCodec: string | null
  audioSampleRate: number | null
  audioChannels: number | null
  videoWidth: number | null
  videoHeight: number | null
  displayWidth: number | null
  displayHeight: number | null
  rotationDegrees: number
}

function parsePositiveInt(value: unknown): number | null {
  const parsed = typeof value === 'string' ? parseInt(value, 10) : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizeRotation(rotation: number): number {
  const normalized = ((rotation % 360) + 360) % 360
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0
}

function extractRotationDegrees(videoStream: any): number {
  const tagRotation = parseInt(videoStream?.tags?.rotate ?? '', 10)
  if (Number.isFinite(tagRotation)) return normalizeRotation(tagRotation)

  const sideDataRotation = videoStream?.side_data_list?.find(
    (item: any) => typeof item?.rotation === 'number'
  )?.rotation
  if (typeof sideDataRotation === 'number' && Number.isFinite(sideDataRotation)) {
    return normalizeRotation(sideDataRotation)
  }

  return 0
}

export function resolveDisplaySize(
  videoStream: any
): { displayWidth: number | null; displayHeight: number | null; rotationDegrees: number } {
  const videoWidth = parsePositiveInt(videoStream?.width)
  const videoHeight = parsePositiveInt(videoStream?.height)
  const rotationDegrees = extractRotationDegrees(videoStream)
  if (!videoWidth || !videoHeight) {
    return { displayWidth: null, displayHeight: null, rotationDegrees }
  }

  const sampleAspectRatio =
    typeof videoStream?.sample_aspect_ratio === 'string' ? videoStream.sample_aspect_ratio : ''
  const match = sampleAspectRatio.match(/^(\d+):(\d+)$/)
  let displayWidth = videoWidth
  const displayHeight = videoHeight

  if (match) {
    const sarNum = parseInt(match[1], 10)
    const sarDen = parseInt(match[2], 10)
    if (Number.isFinite(sarNum) && Number.isFinite(sarDen) && sarNum > 0 && sarDen > 0) {
      displayWidth = Math.max(1, Math.round((videoWidth * sarNum) / sarDen))
    }
  }

  if (rotationDegrees === 90 || rotationDegrees === 270) {
    return {
      displayWidth: displayHeight,
      displayHeight: displayWidth,
      rotationDegrees,
    }
  }

  return {
    displayWidth,
    displayHeight,
    rotationDegrees,
  }
}

export function ffprobe(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(
      getFFprobePath(),
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe failed: ${err.message}`))
        try {
          const info = JSON.parse(stdout)
          const durationSec = parseFloat(info.format?.duration || '0')
          const audioStream = info.streams?.find((s: any) => s.codec_type === 'audio')
          const videoStream = info.streams?.find((s: any) => s.codec_type === 'video')
          const videoWidth = parsePositiveInt(videoStream?.width)
          const videoHeight = parsePositiveInt(videoStream?.height)
          const { displayWidth, displayHeight, rotationDegrees } = resolveDisplaySize(videoStream)

          resolve({
            durationUs: Math.round(durationSec * 1_000_000),
            audioCodec: audioStream?.codec_name || null,
            audioSampleRate: audioStream ? parseInt(audioStream.sample_rate, 10) : null,
            audioChannels: audioStream ? parseInt(audioStream.channels, 10) : null,
            videoWidth,
            videoHeight,
            displayWidth,
            displayHeight,
            rotationDegrees,
          })
        } catch (parseErr) {
          reject(new Error(`ffprobe parse failed: ${parseErr}`))
        }
      }
    )
  })
}
