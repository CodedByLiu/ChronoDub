import { existsSync, readdirSync } from 'fs'
import { basename, dirname, extname, join } from 'path'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const SUBTITLE_EXT = /\.(srt|vtt|ass)$/i

/** 去掉课程编号前缀 "1. "、"12. "，便于与带编号字幕对齐 */
function normalizeLessonKey(s: string): string {
  return s.replace(/^\d+\.\s*/, '').trim().toLowerCase()
}

/** 去掉 .en / .zh-CN 等语言后缀（在 .srt 之前那一节） */
function stripTrailingLangTag(nameWithoutSubExt: string): string {
  return nameWithoutSubExt.replace(/\.([a-z]{2}(-[a-zA-Z0-9]{2,8})?)$/i, '')
}

function subtitleBaseName(filename: string): string {
  return filename.replace(/\.(srt|vtt|ass)$/i, '')
}

export function detectSubtitleForVideo(videoPath: string): string | null {
  const dir = dirname(videoPath)
  const stem = basename(videoPath, extname(videoPath))

  for (const ext of ['.srt', '.vtt', '.ass']) {
    const exact = join(dir, stem + ext)
    if (existsSync(exact)) return exact
  }

  const pattern = new RegExp(
    `^${escapeRegex(stem)}(\\.[a-zA-Z0-9_-]+)?\\.(srt|vtt|ass)$`,
    'i'
  )

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }

  const subtitleFiles = names.filter((f) => SUBTITLE_EXT.test(f))
  if (subtitleFiles.length === 0) return null

  const regexMatches = subtitleFiles.filter((f) => pattern.test(f))
  if (regexMatches.length > 0) {
    regexMatches.sort((a, b) => {
      const da = a.length - stem.length
      const db = b.length - stem.length
      if (da !== db) return da - db
      return a.localeCompare(b, 'en')
    })
    return join(dir, regexMatches[0])
  }

  const videoKey = normalizeLessonKey(stem)
  const fuzzy: string[] = []
  for (const f of subtitleFiles) {
    const base = subtitleBaseName(f)
    const core = normalizeLessonKey(stripTrailingLangTag(base))
    if (core === videoKey || normalizeLessonKey(base) === videoKey) {
      fuzzy.push(f)
    }
  }
  if (fuzzy.length > 0) {
    fuzzy.sort((a, b) => a.length - b.length || a.localeCompare(b, 'en'))
    return join(dir, fuzzy[0])
  }

  return null
}
