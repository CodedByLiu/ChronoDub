import { spawn } from 'child_process'
import { getFFmpegPath } from './ffmpeg-binary'

interface FfmpegRunOptions {
  isCancelled?: () => boolean
  cancelPollMs?: number
}

const STDERR_TAIL_LIMIT = 32 * 1024

function runFfmpeg(
  args: string[],
  errorPrefix: string,
  options?: FfmpegRunOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFFmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stderr = ''
    let cancelled = false
    let cancelTimer: ReturnType<typeof setInterval> | null = null

    const cleanup = () => {
      if (cancelTimer) {
        clearInterval(cancelTimer)
        cancelTimer = null
      }
    }

    const checkCancel = () => {
      if (!options?.isCancelled?.()) return
      cancelled = true
      try {
        proc.kill()
      } catch {
        /* noop */
      }
    }

    if (options?.isCancelled) {
      checkCancel()
      cancelTimer = setInterval(checkCancel, options.cancelPollMs ?? 250)
    }

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > STDERR_TAIL_LIMIT) {
        stderr = stderr.slice(-STDERR_TAIL_LIMIT)
      }
    })

    proc.on('close', (code) => {
      cleanup()
      if (cancelled) return reject(new Error('TASK_CANCELLED'))
      if (code !== 0) return reject(new Error(`${errorPrefix} (${code}): ${stderr.slice(-500)}`))
      resolve()
    })
    proc.on('error', (err) => {
      cleanup()
      reject(err)
    })
  })
}

export function muxVideoWithAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  options?: FfmpegRunOptions
): Promise<void> {
  const args = [
    '-y',
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-shortest',
    outputPath,
  ]

  return runFfmpeg(args, 'FFmpeg mux failed', options)
}

function escapeFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

export function burnSubtitlesIntoVideo(
  videoPath: string,
  audioPath: string,
  subtitlePath: string,
  outputPath: string,
  options?: FfmpegRunOptions
): Promise<void> {
  const escapedSubtitlePath = escapeFilterPath(subtitlePath)
  const args = [
    '-y',
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-vf',
    `ass=filename='${escapedSubtitlePath}'`,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-shortest',
    outputPath,
  ]

  return runFfmpeg(args, 'FFmpeg burn subtitles failed', options)
}
