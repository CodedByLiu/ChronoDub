import {
  DEEPSEEK_TRANSLATE_TIMEOUT_MS,
  requestDeepseekJson,
  testDeepseekPing,
} from './deepseek-client'
import {
  isAcceptableTranslatedText,
  normalizeSpaces,
} from './text-guard'
import { applyTerminologyToChinese } from './terminology'
import { compressTranslation } from './deepseek-compress'

const BATCH_SIZE = 15
const MAX_RETRIES = 3
const SINGLE_ITEM_RETRIES = 2
export const TRANSLATION_STRATEGY_VERSION = '2026-05-10-v5'

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

export class TranslationIncompleteError extends Error {
  unresolvedItems: TranslationIssueItem[]
  partialTranslations: Map<number, string>

  constructor(
    message: string,
    partialTranslations: Map<number, string>,
    unresolvedItems: TranslationIssueItem[]
  ) {
    super(message)
    this.name = 'TranslationIncompleteError'
    this.partialTranslations = new Map(partialTranslations)
    this.unresolvedItems = unresolvedItems.map((item) => ({ ...item }))
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toIssueItems(items: TranslationInputItem[]): TranslationIssueItem[] {
  return items.map((item) => ({
    id: item.id,
    text: item.text,
    ...(typeof item.maxChars === 'number' && item.maxChars > 0 ? { max_chars: item.maxChars } : {}),
  }))
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
  apiKey: string,
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

  const parsed = await requestDeepseekJson<TranslationResult>(
    apiKey,
    [
      {
        role: 'system',
        content: buildTranslateSystemPrompt(dictionary, strictMode, hasBudgetConstraints, repairMode),
      },
      { role: 'user', content: JSON.stringify(payloadItems) },
    ],
    4096,
    0.3,
    DEEPSEEK_TRANSLATE_TIMEOUT_MS,
    `DeepSeek 翻译超时（${Math.round(DEEPSEEK_TRANSLATE_TIMEOUT_MS / 1000)} 秒）`
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
    if (!isAcceptableTranslatedText(item.text, normalized)) {
      unresolved.push(item)
      continue
    }
    resolved.set(item.id, normalized)
  }

  return { resolved, unresolved }
}

async function recoverMissingTranslations(
  missingItems: TranslationInputItem[],
  apiKey: string,
  dictionary: Array<{ en: string; zh: string }>
): Promise<Map<number, string>> {
  const recovered = new Map<number, string>()

  for (const item of missingItems) {
    for (let attempt = 0; attempt < SINGLE_ITEM_RETRIES; attempt++) {
      try {
        const raw = await requestBatchTranslations([item], apiKey, dictionary, true, true)
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
  apiKey: string,
  dictionary: Array<{ en: string; zh: string }>
): Promise<Map<number, string>> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const parsed = await requestBatchTranslations(items, apiKey, dictionary, true)
      const { resolved, unresolved } = validateBatchTranslations(items, parsed)
      if (unresolved.length === 0) return resolved

      if (attempt < MAX_RETRIES - 1) {
        await sleep(1000 * (attempt + 1))
        continue
      }

      const recovered = await recoverMissingTranslations(unresolved, apiKey, dictionary)
      for (const [id, text] of recovered) resolved.set(id, text)
      const unresolvedAfterRecover = unresolved.filter((item) => !resolved.has(item.id))
      if (unresolvedAfterRecover.length === 0) return resolved

      throw new TranslationIncompleteError(
        `DeepSeek translation result is incomplete. ${unresolvedAfterRecover.length} item(s) still unresolved (id: ${unresolvedAfterRecover
          .map((item) => item.id)
          .join(', ')}).`,
        resolved,
        toIssueItems(unresolvedAfterRecover)
      )
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err
      await sleep(1000 * (attempt + 1))
    }
  }

  throw new Error('translateBatch: exceeded max retries')
}

async function translateItems(
  items: TranslationInputItem[],
  apiKey: string,
  dictionary: Array<{ en: string; zh: string }>,
  betweenBatches?: () => void | Promise<void>
): Promise<Map<number, string>> {
  const result = new Map<number, string>()

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    await betweenBatches?.()
    const batch = items.slice(i, i + BATCH_SIZE)
    try {
      const batchResult = await translateBatch(batch, apiKey, dictionary)
      for (const [id, text] of batchResult) result.set(id, text)
    } catch (err) {
      if (err instanceof TranslationIncompleteError) {
        for (const [id, text] of err.partialTranslations) result.set(id, text)
        throw new TranslationIncompleteError(err.message, result, err.unresolvedItems)
      }
      throw err
    }
  }

  return result
}

export async function testDeepseekConnection(
  apiKey: string
): Promise<{ ok: boolean; message?: string }> {
  return testDeepseekPing(apiKey)
}

export async function translateSegments(
  segments: Array<{ id: number; text: string }>,
  apiKey: string,
  dictionary: Array<{ en: string; zh: string }>,
  maxCharsPerSegment?: Map<number, number>,
  betweenBatches?: () => void | Promise<void>
): Promise<Map<number, string>> {
  return translateItems(
    segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      ...(maxCharsPerSegment ? { maxChars: maxCharsPerSegment.get(segment.id) } : {}),
    })),
    apiKey,
    dictionary,
    betweenBatches
  )
}

export { applyTerminologyToChinese, isAcceptableTranslatedText }
export { compressTranslation }
