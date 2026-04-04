import { readdirSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { parseSubtitleFile } from './subtitle-parser'

const SUBTITLE_EXT_RE = /\.(srt|vtt|ass)$/i
const ENGLISH_TAG_RE = /(?:^|[._-])(en|eng|en-us|en-gb|english)(?:$|[._-])/i
const CHINESE_TAG_RE = /(?:^|[._-])(zh|zho|chi|chs|cht|cn|zh-cn|zh-hans|zh-hant|chinese)(?:$|[._-])/i
const SAMPLE_CUE_LIMIT = 8
const SAMPLE_CHAR_LIMIT = 320
const MATCH_PRIORITY = {
  exact: 4,
  pattern: 3,
  fuzzy: 2,
  only: 1,
} as const
const EXT_PRIORITY: Record<string, number> = {
  '.vtt': 3,
  '.srt': 2,
  '.ass': 1,
}

type MatchKind = keyof typeof MATCH_PRIORITY

interface SubtitleCandidate {
  filename: string
  path: string
  base: string
  ext: string
  matchKind: MatchKind
  nameDistance: number
  hasEnglishTag: boolean
  hasChineseTag: boolean
  languageScore: number
  languageConfidence: number
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeLessonKey(value: string): string {
  return value
    .replace(/^\d+\.\s*/, '')
    .trim()
    .toLowerCase()
}

function stripTrailingLangTag(nameWithoutSubExt: string): string {
  return nameWithoutSubExt.replace(/[._-]([a-z]{2}(?:-[a-zA-Z0-9]{2,8})?)$/i, '')
}

function subtitleBaseName(filename: string): string {
  return filename.replace(/\.(srt|vtt|ass)$/i, '')
}

function sanitizeCueSample(text: string): string {
  return text
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\{[^}]*}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractLanguageSample(filePath: string): string {
  try {
    const cues = parseSubtitleFile(filePath)
    const parts: string[] = []
    let charCount = 0

    for (const cue of cues) {
      const text = sanitizeCueSample(cue.text)
      if (!text) continue

      const letterCount =
        (text.match(/[A-Za-z]/g) || []).length + (text.match(/[\u3400-\u9FFF]/g) || []).length
      if (letterCount === 0) continue

      parts.push(text)
      charCount += text.length
      if (parts.length >= SAMPLE_CUE_LIMIT || charCount >= SAMPLE_CHAR_LIMIT) break
    }

    return parts.join(' ')
  } catch {
    return ''
  }
}

function scoreEnglishLikelihood(text: string): { score: number; confidence: number } {
  if (!text) return { score: 0, confidence: 0 }

  const asciiLetterCount = (text.match(/[A-Za-z]/g) || []).length
  const cjkCount = (text.match(/[\u3400-\u9FFF]/g) || []).length
  const englishWordCount = (text.match(/\b[A-Za-z]{2,}\b/g) || []).length
  const commonEnglishWordCount =
    (
      text.match(
        /\b(the|and|you|that|this|with|for|have|are|not|but|what|when|where|why|how|more|from|into|your|they|their|there|about|would|could|should|think|going|because|really|want|need|know|mean|make|take|look|right|yeah|okay|well|then|than)\b/gi
      ) || []
    ).length

  const totalLanguageChars = asciiLetterCount + cjkCount
  if (totalLanguageChars === 0 && englishWordCount === 0) {
    return { score: 0, confidence: 0 }
  }

  let score = 0
  score += Math.round((asciiLetterCount / Math.max(totalLanguageChars, 1)) * 100)
  score -= Math.round((cjkCount / Math.max(totalLanguageChars, 1)) * 120)
  score += Math.min(englishWordCount * 2, 24)
  score += Math.min(commonEnglishWordCount * 4, 24)

  if (asciiLetterCount >= 18 && cjkCount === 0) score += 20
  if (cjkCount >= 12 && asciiLetterCount === 0) score -= 20

  const confidence = Math.min(totalLanguageChars + englishWordCount * 4, 100)
  return { score, confidence }
}

function buildCandidate(
  dir: string,
  filename: string,
  stem: string,
  matchKind: MatchKind
): SubtitleCandidate {
  const base = subtitleBaseName(filename)
  const ext = extname(filename).toLowerCase()
  const sample = extractLanguageSample(join(dir, filename))
  const { score, confidence } = scoreEnglishLikelihood(sample)

  return {
    filename,
    path: join(dir, filename),
    base,
    ext,
    matchKind,
    nameDistance: Math.max(0, base.length - stem.length),
    hasEnglishTag: ENGLISH_TAG_RE.test(base),
    hasChineseTag: CHINESE_TAG_RE.test(base),
    languageScore: score,
    languageConfidence: confidence,
  }
}

function collectCandidates(dir: string, stem: string, subtitleFiles: string[]): SubtitleCandidate[] {
  if (subtitleFiles.length === 1) {
    return [buildCandidate(dir, subtitleFiles[0], stem, 'only')]
  }

  const seen = new Set<string>()
  const candidates: SubtitleCandidate[] = []
  const videoKey = normalizeLessonKey(stem)
  const taggedPattern = new RegExp(
    `^${escapeRegex(stem)}(?:[._-][a-zA-Z0-9-]+)+\\.(srt|vtt|ass)$`,
    'i'
  )

  for (const filename of subtitleFiles) {
    const base = subtitleBaseName(filename)
    let matchKind: MatchKind | null = null

    if (base === stem) {
      matchKind = 'exact'
    } else if (taggedPattern.test(filename)) {
      matchKind = 'pattern'
    } else {
      const strippedBase = stripTrailingLangTag(base)
      const normalizedBase = normalizeLessonKey(base)
      const normalizedStrippedBase = normalizeLessonKey(strippedBase)
      if (normalizedBase === videoKey || normalizedStrippedBase === videoKey) {
        matchKind = 'fuzzy'
      }
    }

    if (!matchKind) continue
    if (seen.has(filename)) continue
    seen.add(filename)
    candidates.push(buildCandidate(dir, filename, stem, matchKind))
  }

  return candidates
}

function compareCandidates(a: SubtitleCandidate, b: SubtitleCandidate): number {
  if (a.languageScore !== b.languageScore) return b.languageScore - a.languageScore
  if (a.languageConfidence !== b.languageConfidence) {
    return b.languageConfidence - a.languageConfidence
  }
  if (a.hasEnglishTag !== b.hasEnglishTag) return Number(b.hasEnglishTag) - Number(a.hasEnglishTag)
  if (a.hasChineseTag !== b.hasChineseTag) return Number(a.hasChineseTag) - Number(b.hasChineseTag)

  const extDelta = (EXT_PRIORITY[b.ext] ?? 0) - (EXT_PRIORITY[a.ext] ?? 0)
  if (extDelta !== 0) return extDelta

  const matchDelta = MATCH_PRIORITY[b.matchKind] - MATCH_PRIORITY[a.matchKind]
  if (matchDelta !== 0) return matchDelta

  if (a.nameDistance !== b.nameDistance) return a.nameDistance - b.nameDistance
  return a.filename.localeCompare(b.filename, 'en')
}

export function detectSubtitleForVideo(videoPath: string): string | null {
  const dir = dirname(videoPath)
  const stem = basename(videoPath, extname(videoPath))

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }

  const subtitleFiles = names.filter((filename) => SUBTITLE_EXT_RE.test(filename))
  if (subtitleFiles.length === 0) return null

  const candidates = collectCandidates(dir, stem, subtitleFiles)
  if (candidates.length === 0) return subtitleFiles.length === 1 ? join(dir, subtitleFiles[0]) : null

  candidates.sort(compareCandidates)
  return candidates[0]?.path ?? null
}
