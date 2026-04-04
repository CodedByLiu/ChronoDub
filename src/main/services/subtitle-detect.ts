import { readFile, readdir } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import { parseSubtitleContent } from './subtitle-parser'

const SUBTITLE_EXT_RE = /\.(srt|vtt|ass|ssa)$/i
const VIDEO_EXT_RE = /\.(mp4|mkv|avi|mov|webm|flv)$/i
const ENGLISH_TAG_RE = /(?:^|[._-])(en|eng|en-us|en-gb|english)(?:$|[._-])/i
const CHINESE_TAG_RE = /(?:^|[._-])(zh|zho|chi|chs|cht|cn|zh-cn|zh-hans|zh-hant|chinese)(?:$|[._-])/i
const SAMPLE_CUE_LIMIT = 8
const SAMPLE_CHAR_LIMIT = 320
const DISTRIBUTED_SAMPLE_BUCKETS = 3
const LOW_CONFIDENCE_SCORE = 12
const LOW_CONFIDENCE_VALUE = 18
const SDH_TOKEN_RE =
  /\b(music|applause|laughs?|laughing|sighs?|breathing|gasps?|crowd|audience|door|phone|ringing|beeping)\b/gi
const STRONG_ENGLISH_WORD_RE =
  /\b(the|and|you|that|this|with|for|have|are|not|but|what|when|where|why|how|more|from|into|your|they|their|there|about|would|could|should|think|going|because|really|want|need|know|mean|make|take|look|right|yeah|okay|well|then|than)\b/gi

const MATCH_PRIORITY = {
  exact: 4,
  pattern: 3,
  fuzzy: 2,
} as const

const EXT_PRIORITY: Record<string, number> = {
  '.vtt': 3,
  '.srt': 2,
  '.ass': 1,
  '.ssa': 1,
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
  return filename.replace(/\.(srt|vtt|ass|ssa)$/i, '')
}

function sanitizeCueSample(text: string): string {
  return text
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\{[^}]*}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function collectSampleParts(texts: string[]): string {
  if (texts.length === 0) return ''

  const selectedTexts: string[] = []
  const seenIndices = new Set<number>()
  const bucketSize = Math.max(1, Math.ceil(texts.length / DISTRIBUTED_SAMPLE_BUCKETS))

  for (let bucket = 0; bucket < DISTRIBUTED_SAMPLE_BUCKETS; bucket++) {
    const start = bucket * bucketSize
    const end = Math.min(texts.length, start + bucketSize)
    if (start >= texts.length) break

    const indices = [start, start + Math.floor((end - start) / 2), end - 1]
      .map((index) => Math.max(start, Math.min(end - 1, index)))
      .filter((index, offset, list) => list.indexOf(index) === offset)

    for (const index of indices) {
      if (seenIndices.has(index)) continue
      seenIndices.add(index)
      selectedTexts.push(texts[index])
    }
  }

  for (let index = 0; index < texts.length && selectedTexts.length < SAMPLE_CUE_LIMIT * 2; index++) {
    if (seenIndices.has(index)) continue
    seenIndices.add(index)
    selectedTexts.push(texts[index])
  }

  const parts: string[] = []
  let charCount = 0

  for (const raw of selectedTexts) {
    const text = sanitizeCueSample(raw)
    if (!text) continue

    const letterCount =
      (text.match(/[A-Za-z]/g) || []).length + (text.match(/[\u3400-\u9FFF]/g) || []).length
    if (letterCount === 0) continue

    parts.push(text)
    charCount += text.length
    if (parts.length >= SAMPLE_CUE_LIMIT || charCount >= SAMPLE_CHAR_LIMIT) break
  }

  return parts.join(' ')
}

function extractSrtVttSample(content: string): string {
  const cueLines: string[] = []

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^\d+$/.test(line)) continue
    if (/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(line)) continue
    if (/^\d{2}:\d{2}\.\d{3}\s*-->/.test(line)) continue
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/i.test(line)) continue

    cueLines.push(line)
    if (cueLines.length >= SAMPLE_CUE_LIMIT * 3) break
  }

  return collectSampleParts(cueLines)
}

function extractAssSample(content: string): string {
  const cues = parseSubtitleContent(content, '.ass')
  return collectSampleParts(cues.map((cue) => cue.text))
}

async function loadCueSample(filePath: string): Promise<string> {
  try {
    const ext = extname(filePath).toLowerCase()
    const content = await readFile(filePath, 'utf-8')
    if (ext === '.ass' || ext === '.ssa') return extractAssSample(content)
    return extractSrtVttSample(content)
  } catch {
    return ''
  }
}

async function canUseOnlySubtitleFallback(dir: string, filename: string): Promise<boolean> {
  const sample = await loadCueSample(join(dir, filename))
  const { score, confidence } = scoreEnglishLikelihood(sample)
  return confidence >= LOW_CONFIDENCE_VALUE && score >= LOW_CONFIDENCE_SCORE
}

function scoreEnglishLikelihood(text: string): { score: number; confidence: number } {
  if (!text) return { score: 0, confidence: 0 }

  const sdhTokenCount = (text.match(SDH_TOKEN_RE) || []).length
  const musicalMarkerCount = (text.match(/[♪♫]/g) || []).length
  const asciiLetterCount = (text.match(/[A-Za-z]/g) || []).length
  const cjkCount = (text.match(/[\u3400-\u9FFF]/g) || []).length
  const englishWordCount = (text.match(/\b[A-Za-z]{2,}\b/g) || []).length
  const commonEnglishWordCount = (text.match(STRONG_ENGLISH_WORD_RE) || []).length

  const totalLanguageChars = asciiLetterCount + cjkCount
  if (totalLanguageChars === 0 && englishWordCount === 0) {
    return { score: 0, confidence: 0 }
  }

  let score = 0
  score += Math.round((asciiLetterCount / Math.max(totalLanguageChars, 1)) * 100)
  score -= Math.round((cjkCount / Math.max(totalLanguageChars, 1)) * 120)
  score += Math.min(englishWordCount * 2, 24)
  score += Math.min(commonEnglishWordCount * 4, 24)
  score -= Math.min((sdhTokenCount + musicalMarkerCount) * 5, 20)

  if (asciiLetterCount >= 18 && cjkCount === 0) score += 20
  if (cjkCount >= 12 && asciiLetterCount === 0) score -= 20
  if (asciiLetterCount >= 10 && cjkCount >= 10) score -= 18
  else if (asciiLetterCount >= 8 && cjkCount >= 4) score -= 10

  let confidence = Math.min(totalLanguageChars + englishWordCount * 4, 100)
  if (asciiLetterCount >= 10 && cjkCount >= 10) confidence = Math.max(0, confidence - 30)
  else if (asciiLetterCount >= 8 && cjkCount >= 4) confidence = Math.max(0, confidence - 18)
  if (sdhTokenCount + musicalMarkerCount >= 2) confidence = Math.max(0, confidence - 12)
  if (englishWordCount <= 1 && commonEnglishWordCount === 0) confidence = Math.max(0, confidence - 10)

  return { score, confidence }
}

async function buildCandidate(
  dir: string,
  filename: string,
  stem: string,
  matchKind: MatchKind
): Promise<SubtitleCandidate> {
  const base = subtitleBaseName(filename)
  const ext = extname(filename).toLowerCase()
  const sample = await loadCueSample(join(dir, filename))
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

async function collectCandidates(
  dir: string,
  stem: string,
  subtitleFiles: string[]
): Promise<SubtitleCandidate[]> {
  const videoKey = normalizeLessonKey(stem)
  const taggedPattern = new RegExp(
    `^${escapeRegex(stem)}(?:[._-][a-zA-Z0-9-]+)+\\.(srt|vtt|ass|ssa)$`,
    'i'
  )

  const candidateDescriptors = subtitleFiles.flatMap((filename) => {
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

    return matchKind ? [{ filename, matchKind }] : []
  })

  return Promise.all(
    candidateDescriptors.map(({ filename, matchKind }) => buildCandidate(dir, filename, stem, matchKind))
  )
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

export async function detectSubtitleForVideo(videoPath: string): Promise<string | null> {
  const dir = dirname(videoPath)
  const stem = basename(videoPath, extname(videoPath))

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }

  const subtitleFiles = names.filter((filename) => SUBTITLE_EXT_RE.test(filename))
  if (subtitleFiles.length === 0) return null

  const candidates = await collectCandidates(dir, stem, subtitleFiles)
  if (candidates.length > 0) {
    candidates.sort(compareCandidates)
    return candidates[0]?.path ?? null
  }

  const videoFiles = names.filter((filename) => VIDEO_EXT_RE.test(filename))
  if (
    subtitleFiles.length === 1 &&
    videoFiles.length === 1 &&
    (await canUseOnlySubtitleFallback(dir, subtitleFiles[0]))
  ) {
    return join(dir, subtitleFiles[0])
  }

  return null
}
