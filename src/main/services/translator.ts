import type { LLMConfig } from '../../types'
import {
  LLM_TRANSLATE_TIMEOUT_MS,
  requestLLMJson,
  testLLMPing,
} from './llm'
import {
  isAcceptableTranslatedText,
  normalizeSpaces,
} from './text-guard'
import { applyTerminologyToChinese } from './terminology'
import { compressTranslation } from './llm'

const BATCH_SIZE = 15
const MAX_RETRIES = 3
const SINGLE_ITEM_RETRIES = 2
export const TRANSLATION_STRATEGY_VERSION = '2026-05-16-v9'

interface TranslationResult {
  translations: Array<{ id: number; text: string }>
}

interface TranslationInputItem {
  id: number
  text: string
  maxChars?: number
}

export interface TranslationIssueItem {
  id: number
  text: string
  max_chars?: number
}

export interface TranslationOutcome {
  translations: Map<number, string>
  issues: TranslationIssueItem[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildTranslateSystemPrompt(
  dictionary: Array<{ en: string; zh: string }>,
  strictMode: boolean,
  hasBudgetConstraints: boolean,
  repairMode = false
): string {
  const dictLines =
    dictionary.length > 0
      ? dictionary
          .filter((item) => item.en.trim())
          .map((item) => `- ${item.en.trim()} => ${item.zh.trim()}`)
          .join('\n')
      : ''

  return [
    'You are a professional subtitle translator from English to Simplified Chinese for a Chinese voice-over (TTS dubbing) pipeline.',
    'Your output text will be read aloud by a Chinese TTS engine, so it must sound natural in spoken Mandarin.',
    'Translate each line into natural and accurate spoken-style Chinese.',
    'Do not over-compress: for full English sentences, return full Chinese sentences.',
    'Keep discourse connectors and logic words when present (for example: so, then, but, therefore).',
    'Spoken-style expansion (apply within max_chars, never exceed it):',
    '- When the source is short or terse, prefer a fuller spoken-Mandarin rendering over a clipped one: restore omitted subjects ("do this" -> "我们这样操作"), add natural connectives ("then" -> "接下来" / "那么我们", "so" -> "也就是说"), use complete phrases ("click save" -> "点击保存按钮").',
    '- Insert Chinese commas (，) at clause boundaries so the TTS pauses naturally; avoid running a long segment as one unbroken clause.',
    '- For multiple discrete steps or independent statements, separate them with a Chinese period (。) instead of a comma — periods let the TTS pause longer and let the subtitle renderer split each step onto its own line.',
    '- Never pad with empty filler ("呃...", repeated "然后然后", redundant rephrasing of the same idea). Naturalness comes first; being a bit longer is a soft preference, not a goal.',
    dictLines ? `Terminology glossary:\n${dictLines}` : '',
    'Requirements:',
    '1. Preserve meaning, logic relation, technical terms, and procedural steps.',
    '2. If source text contains glossary terms, use the glossary translation in output.',
    hasBudgetConstraints
      ? '3. Respect each item max_chars whenever possible while keeping sentence complete and natural.'
      : '',
    '4. Output valid JSON: {"translations":[{"id":1,"text":"..."}]}.',
    strictMode
      ? '5. Must return exactly one translation for every input id. No missing ids. No extra ids.'
      : '',
    strictMode ? '6. Full English sentences must be translated to Chinese.' : '',
    '7. Output text MUST be readable by a Chinese TTS engine. Handle untranslatable content as follows:',
    '   - Person names: transliterate to Chinese characters (e.g., "John" -> "约翰", "Sam Altman" -> "山姆·奥特曼").',
    '   - Common brand or product names: keep short English as-is inside Chinese context (e.g., "iPhone" stays as "iPhone", "Try GitHub" -> "试试 GitHub").',
    '   - URLs, code identifiers, file paths, long IDs: do NOT keep the literal string. Paraphrase the reference instead (e.g., "check out github.com/foo/bar" -> "去看看 GitHub 上的项目链接").',
    '   - For any line that is a full sentence, the output MUST contain Chinese characters; never return a Chinese-character-free output for a sentence.',
    repairMode ? buildRepairSection() : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildRepairSection(): string {
  return [
    '',
    'Repair mode: a previous attempt at this line was rejected by the validator. Common rejection reasons:',
    '- Output looked like English (no Chinese characters).',
    '- Output was empty.',
    '- Output was over-compressed (e.g., source "This is the string." compressed down to just "字符串。").',
    'For this retry, you MUST:',
    '- Include Chinese characters that capture the full meaning of the source.',
    '- For "this/that/it is X" style sentences, return a complete Chinese sentence.',
    '  Example: "This is the string." -> "这就是这个字符串。" (NOT just "字符串。").',
    '  Example: "That was a great idea." -> "那是个好主意。" (NOT just "好主意。").',
    '- For names or proper nouns, transliterate to Chinese rather than returning the English name unchanged when the source is a full sentence.',
    '- Keep the result natural for Chinese TTS narration; avoid leaving raw URLs, file paths, or long identifiers in the spoken output.',
  ].join('\n')
}

async function requestBatchTranslations(
  items: TranslationInputItem[],
  llm: LLMConfig,
  dictionary: Array<{ en: string; zh: string }>,
  strictMode: boolean,
  repairMode = false
): Promise<Map<number, string>> {
  const hasBudgetConstraints = items.some(
    (item) => typeof item.maxChars === 'number' && item.maxChars > 0
  )
  const payloadItems = items.map((item) => ({
    id: item.id,
    text: item.text,
    ...(typeof item.maxChars === 'number' && item.maxChars > 0 ? { max_chars: item.maxChars } : {}),
  }))

  const parsed = await requestLLMJson<TranslationResult>(
    llm,
    [
      {
        role: 'system',
        content: buildTranslateSystemPrompt(dictionary, strictMode, hasBudgetConstraints, repairMode),
      },
      { role: 'user', content: JSON.stringify(payloadItems) },
    ],
    4096,
    0.3,
    LLM_TRANSLATE_TIMEOUT_MS,
    `LLM 翻译超时（${Math.round(LLM_TRANSLATE_TIMEOUT_MS / 1000)} 秒）`
  )

  const expectedIds = new Set(items.map((item) => item.id))
  const result = new Map<number, string>()
  for (const item of parsed.translations ?? []) {
    if (!expectedIds.has(item.id) || typeof item.text !== 'string') continue
    result.set(item.id, item.text)
  }
  return result
}

function validateBatchTranslations(
  items: TranslationInputItem[],
  raw: Map<number, string>
): { resolved: Map<number, string>; unresolved: TranslationInputItem[] } {
  const resolved = new Map<number, string>()
  const unresolved: TranslationInputItem[] = []

  for (const item of items) {
    const output = raw.get(item.id)
    if (typeof output !== 'string') {
      unresolved.push(item)
      continue
    }

    const normalized = normalizeSpaces(output)
    if (!isAcceptableTranslatedText(item.text, normalized, item.maxChars)) {
      unresolved.push(item)
      continue
    }
    resolved.set(item.id, normalized)
  }

  return { resolved, unresolved }
}

async function recoverMissingTranslations(
  missingItems: TranslationInputItem[],
  llm: LLMConfig,
  dictionary: Array<{ en: string; zh: string }>,
  rawCapture: Map<number, string>
): Promise<Map<number, string>> {
  const recovered = new Map<number, string>()

  for (const item of missingItems) {
    for (let attempt = 0; attempt < SINGLE_ITEM_RETRIES; attempt++) {
      try {
        const raw = await requestBatchTranslations([item], llm, dictionary, true, true)
        const rawText = raw.get(item.id)
        if (typeof rawText === 'string') {
          const candidate = normalizeSpaces(rawText)
          if (candidate) rawCapture.set(item.id, candidate)
        }
        const { resolved } = validateBatchTranslations([item], raw)
        const translated = resolved.get(item.id)
        if (translated) {
          recovered.set(item.id, translated)
          break
        }
      } catch {
        /* retry */
      }

      if (attempt < SINGLE_ITEM_RETRIES - 1) {
        await sleep(500 * (attempt + 1))
      }
    }
  }

  return recovered
}

async function translateBatch(
  items: TranslationInputItem[],
  llm: LLMConfig,
  dictionary: Array<{ en: string; zh: string }>
): Promise<TranslationOutcome> {
  const lastRawByItem = new Map<number, string>()

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let parsed: Map<number, string>
    try {
      parsed = await requestBatchTranslations(items, llm, dictionary, true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`translateBatch attempt ${attempt + 1}/${MAX_RETRIES} failed: ${message}`)
      if (attempt < MAX_RETRIES - 1) {
        await sleep(1000 * (attempt + 1))
        continue
      }
      parsed = new Map<number, string>()
    }

    for (const [id, text] of parsed) {
      const candidate = normalizeSpaces(text)
      if (candidate) lastRawByItem.set(id, candidate)
    }
    const { resolved, unresolved } = validateBatchTranslations(items, parsed)
    if (unresolved.length === 0) return { translations: resolved, issues: [] }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(1000 * (attempt + 1))
      continue
    }

    const recovered = await recoverMissingTranslations(unresolved, llm, dictionary, lastRawByItem)
    for (const [id, text] of recovered) resolved.set(id, text)
    const stillFailing = unresolved.filter((item) => !resolved.has(item.id))
    if (stillFailing.length === 0) return { translations: resolved, issues: [] }

    const issues: TranslationIssueItem[] = []
    for (const item of stillFailing) {
      const fallback = lastRawByItem.get(item.id) ?? normalizeSpaces(item.text)
      resolved.set(item.id, fallback)
      issues.push({
        id: item.id,
        text: item.text,
        ...(typeof item.maxChars === 'number' && item.maxChars > 0 ? { max_chars: item.maxChars } : {}),
      })
    }
    return { translations: resolved, issues }
  }

  throw new Error('translateBatch: exceeded max retries')
}

function isUntranslatableSource(text: string): boolean {
  const normalized = normalizeSpaces(text)
  if (!normalized) return true
  if (/[A-Za-z]{3,}/.test(normalized)) return false
  if (/[㐀-鿿]/u.test(normalized)) return false
  return true
}

async function translateItems(
  items: TranslationInputItem[],
  llm: LLMConfig,
  dictionary: Array<{ en: string; zh: string }>,
  betweenBatches?: () => void | Promise<void>
): Promise<TranslationOutcome> {
  const translations = new Map<number, string>()
  const issues: TranslationIssueItem[] = []
  const translatable: TranslationInputItem[] = []

  for (const item of items) {
    if (isUntranslatableSource(item.text)) {
      translations.set(item.id, normalizeSpaces(item.text))
      continue
    }
    translatable.push(item)
  }

  for (let i = 0; i < translatable.length; i += BATCH_SIZE) {
    await betweenBatches?.()
    const batch = translatable.slice(i, i + BATCH_SIZE)
    const outcome = await translateBatch(batch, llm, dictionary)
    for (const [id, text] of outcome.translations) translations.set(id, text)
    for (const issue of outcome.issues) issues.push(issue)
  }

  return { translations, issues }
}

export async function testLLMConnection(
  llm: LLMConfig
): Promise<{ ok: boolean; message?: string }> {
  return testLLMPing(llm)
}

export async function translateSegments(
  segments: Array<{ id: number; text: string }>,
  llm: LLMConfig,
  dictionary: Array<{ en: string; zh: string }>,
  maxCharsPerSegment?: Map<number, number>,
  betweenBatches?: () => void | Promise<void>
): Promise<TranslationOutcome> {
  return translateItems(
    segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      ...(maxCharsPerSegment ? { maxChars: maxCharsPerSegment.get(segment.id) } : {}),
    })),
    llm,
    dictionary,
    betweenBatches
  )
}

export { applyTerminologyToChinese, isAcceptableTranslatedText }
export { compressTranslation }
