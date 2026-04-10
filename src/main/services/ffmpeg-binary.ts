import { existsSync } from 'fs'
import { dirname, join } from 'path'
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
