import { existsSync } from 'fs'
import { basename, extname, join } from 'path'

const reservedPaths = new Set<string>()

export interface ReservedOutputTarget {
  outputDir: string
  outputVideoPath: string
  outputSubtitlePath: string
  release: () => void
}

function normalizeReservationKey(filePath: string): string {
  return filePath.toLowerCase()
}

function isReserved(filePath: string): boolean {
  return reservedPaths.has(normalizeReservationKey(filePath))
}

function reservePaths(filePaths: string[]): () => void {
  const keys = filePaths.map(normalizeReservationKey)
  keys.forEach((key) => reservedPaths.add(key))
  return () => {
    keys.forEach((key) => reservedPaths.delete(key))
  }
}

function findUniqueName(
  outputRoot: string,
  desiredName: string,
  createVideoSubfolder: boolean,
  videoExt: string
): string {
  let attempt = 0

  while (true) {
    const candidate = attempt === 0 ? desiredName : `${desiredName} (${attempt + 1})`

    if (createVideoSubfolder) {
      const candidateDir = join(outputRoot, candidate)
      if (!existsSync(candidateDir) && !isReserved(candidateDir)) {
        return candidate
      }
    } else {
      const candidateVideoPath = join(outputRoot, candidate + videoExt)
      const candidateSubtitlePath = join(outputRoot, candidate + '.srt')
      if (
        !existsSync(candidateVideoPath) &&
        !existsSync(candidateSubtitlePath) &&
        !isReserved(candidateVideoPath) &&
        !isReserved(candidateSubtitlePath)
      ) {
        return candidate
      }
    }

    attempt += 1
  }
}

export function reserveOutputTarget(
  videoPath: string,
  outputRoot: string,
  createVideoSubfolder: boolean
): ReservedOutputTarget {
  const originalStem = basename(videoPath, extname(videoPath))
  const videoExt = extname(videoPath)
  const uniqueName = findUniqueName(outputRoot, originalStem, createVideoSubfolder, videoExt)

  if (createVideoSubfolder) {
    const outputDir = join(outputRoot, uniqueName)
    const release = reservePaths([outputDir])
    return {
      outputDir,
      outputVideoPath: join(outputDir, originalStem + videoExt),
      outputSubtitlePath: join(outputDir, originalStem + '.srt'),
      release,
    }
  }

  const outputVideoPath = join(outputRoot, uniqueName + videoExt)
  const outputSubtitlePath = join(outputRoot, uniqueName + '.srt')
  const release = reservePaths([outputVideoPath, outputSubtitlePath])
  return {
    outputDir: outputRoot,
    outputVideoPath,
    outputSubtitlePath,
    release,
  }
}
