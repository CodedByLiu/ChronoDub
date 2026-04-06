import type { Cue } from '../../types'

const API_URL = 'https://api.deepseek.com/chat/completions'
const BATCH_SIZE = 15
const MAX_RETRIES = 3
const SINGLE_ITEM_RETRIES = 2
const DEEPSEEK_TEST_TIMEOUT_MS = 15_000
const DEEPSEEK_TRANSLATE_TIMEOUT_MS = 45_000
const DEEPSEEK_COMPRESS_TIMEOUT_MS = 45_000
export const TRANSLATION_STRATEGY_VERSION = '2026-04-06-v2'

interface TranslationResult {
  translations: Array<{ id: number; text: string }>
}

interface TranslationInputItem {
  id: number
  text: string
  max_chars?: number
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

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(timeoutMessage)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function escapeRegexTerm(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text)
}

function looksLikeSentence(text: string): boolean {
  return /\s/.test(text) || /[,.!?;:\u3002\uFF0C\uFF1F\uFF01\uFF1B\uFF1A]/.test(text) || text.length >= 20
}

const EN_WORD_RE = /[A-Za-z]+(?:'[A-Za-z]+)?/g
const EN_COPULA_SENTENCE_RE =
  /^(?:so\s+)?(?:this|that|it|there)\s+(?:is|was|are|were|means|refers\s+to)\b/i
const EN_THIS_IS_ARTICLE_RE = /^this\s+is\s+(?:the|a|an)\b/i

function countEnglishWords(text: string): number {
  return text.match(EN_WORD_RE)?.length ?? 0
}

function countVisibleChars(text: string): number {
  return text.replace(/\s+/g, '').length
}

function shouldRetryAsOverCompressed(source: string, translated: string): boolean {
  const src = normalizeSpaces(source)
  const dst = normalizeSpaces(translated)
  if (!src || !dst || !looksLikeSentence(src) || !hasCjk(dst)) return false

  const dstChars = countVisibleChars(dst)
  const srcWords = countEnglishWords(src)

  // High-confidence guard only: copula-style full sentence collapsed into a bare noun phrase.
  if (srcWords >= 4 && EN_COPULA_SENTENCE_RE.test(src) && dstChars <= 4) return true
  if (srcWords >= 4 && EN_THIS_IS_ARTICLE_RE.test(src) && dstChars <= 6) return true

  return false
}
function shouldRetryAsUntranslated(source: string, translated: string): boolean {
  const src = normalizeSpaces(source)
  const dst = normalizeSpaces(translated)
  if (!dst) return true

  if (src !== dst) return false
  if (hasCjk(src)) return false
  return looksLikeSentence(src)
}

function buildChatRequest(
  apiKey: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  maxTokens: number,
  temperature: number
): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      response_format: { type: 'json_object' },
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  }
}

function englishCueHasTerm(cueText: string, term: string): boolean {
  const t = term.trim()
  if (!t) return false

  const lower = cueText.toLowerCase()
  const termLower = t.toLowerCase()
  if (lower.includes(termLower)) return true

  if (/^[\w.+$#@-]+$/.test(t)) {
    try {
      return new RegExp(`\\b${escapeRegexTerm(t)}\\b`, 'i').test(cueText)
    } catch {
      return false
    }
  }

  return false
}

export async function testDeepseekConnection(
  apiKey: string
): Promise<{ ok: boolean; message?: string }> {
  const key = apiKey.trim()
  if (!key) return { ok: false, message: '鏈～鍐?API Key' }

  try {
    const response = await fetchWithTimeout(
      API_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      },
      DEEPSEEK_TEST_TIMEOUT_MS,
      `DeepSeek 杩炴帴瓒呮椂锛?${Math.round(DEEPSEEK_TEST_TIMEOUT_MS / 1000)} 绉掞級`
    )

    if (response.ok) return { ok: true }

    const body = await response.text()
    let message = `璇锋眰澶辫触 (${response.status})`
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } }
      if (parsed.error?.message) message = parsed.error.message
    } catch {
      if (body) message = body.slice(0, 200)
    }
    return { ok: false, message }
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : '缃戠粶閿欒' }
  }
}

export function applyTerminologyToChinese(
  englishCue: string,
  chineseText: string,
  dictionary: Array<{ en: string; zh: string }>
): string {
  let out = chineseText

  for (const { en, zh } of dictionary) {
    const term = en.trim()
    if (!term || term.length < 2) continue
    if (!englishCueHasTerm(englishCue, term)) continue
    out = out.replace(new RegExp(escapeRegexTerm(term), 'gi'), zh.trim())
  }

  return out
}

export async function translateCues(
  cues: Cue[],
  apiKey: string,
  dictionary: Array<{ en: string; zh: string }>,
  _maxCharsPerCue?: Map<number, number>,
  betweenBatches?: () => void | Promise<void>
): Promise<Map<number, string>> {
  const items = cues.map((cue) => ({
    id: cue.id,
    text: cue.text,
  }))

  return translateItems(items, apiKey, dictionary, betweenBatches)
}

export async function translateSegments(
  segments: Array<{ id: number; text: string }>,
  apiKey: string,
  dictionary: Array<{ en: string; zh: string }>,
  _maxCharsPerSegment?: Map<number, number>,
  betweenBatches?: () => void | Promise<void>
): Promise<Map<number, string>> {
  const items = segments.map((segment) => ({
    id: segment.id,
    text: segment.text,
  }))

  return translateItems(items, apiKey, dictionary, betweenBatches)
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
    let batchResult: Map<number, string>
    try {
      batchResult = await translateBatch(batch, apiKey, dictionary)
    } catch (err) {
      if (err instanceof TranslationIncompleteError) {
        for (const [id, text] of err.partialTranslations) {
          result.set(id, text)
        }
        throw new TranslationIncompleteError(err.message, result, err.unresolvedItems)
      }
      throw err
    }
    for (const [id, text] of batchResult) {
      result.set(id, text)
    }
  }

  return result
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
      for (const [id, text] of recovered) {
        resolved.set(id, text)
      }

      const unresolvedAfterRecover = unresolved.filter((item) => !resolved.has(item.id))
      if (unresolvedAfterRecover.length === 0) return resolved

      throw new TranslationIncompleteError(
        `DeepSeek translation result is incomplete. ${unresolvedAfterRecover.length} item(s) still unresolved (id: ${unresolvedAfterRecover
          .map((item) => item.id)
          .join(', ')}).`,
        resolved,
        unresolvedAfterRecover
      )
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err
      await sleep(1000 * (attempt + 1))
    }
  }

  throw new Error('translateBatch: exceeded max retries')
}

function buildTranslateSystemPrompt(
  dictionary: Array<{ en: string; zh: string }>,
  strictMode: boolean
): string {
  const dictLines =
    dictionary.length > 0
      ? dictionary
          .filter((item) => item.en.trim())
          .map((item) => `- ${item.en.trim()} => ${item.zh.trim()}`)
          .join('\n')
      : ''

  const systemPrompt = [
    'You are a professional subtitle translator from English to Simplified Chinese.',
    'Translate each line into natural and accurate spoken-style Chinese.',
    'Do not over-compress: for full English sentences, return full Chinese sentences.',
    'Keep discourse connectors and logic words when present (for example: so, then, but, therefore).',
    'Avoid reducing a complete sentence into a bare noun phrase.',
    dictLines ? `Terminology glossary:\n${dictLines}` : '',
    'Requirements:',
    '1. Preserve meaning, logical relation, technical terms, and procedural steps.',
    '2. If source text contains glossary terms, use the glossary translation in output.',
    '3. Output must be valid JSON with shape {"translations":[{"id":1,"text":"..."}]}.',
    strictMode
      ? '4. Must return exactly one translation for every input id. No missing ids. No extra ids.'
      : '',
    strictMode
      ? '5. Full English sentences must be translated into Chinese; do not return original English.'
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  return systemPrompt
}

async function requestBatchTranslations(
  items: TranslationInputItem[],
  apiKey: string,
  dictionary: Array<{ en: string; zh: string }>,
  strictMode: boolean
): Promise<Map<number, string>> {
  const systemPrompt = buildTranslateSystemPrompt(dictionary, strictMode)
  const userPrompt = JSON.stringify(items)

  const response = await fetchWithTimeout(
    API_URL,
    buildChatRequest(
      apiKey,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      4096,
      0.3
    ),
    DEEPSEEK_TRANSLATE_TIMEOUT_MS,
    `DeepSeek 缈昏瘧瓒呮椂锛?${Math.round(DEEPSEEK_TRANSLATE_TIMEOUT_MS / 1000)} 绉掞級`
  )

  if (!response.ok) {
    const errBody = await response.text()
    throw new Error(`DeepSeek API ${response.status}: ${errBody}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('DeepSeek returned empty content')
  }

  const parsed: TranslationResult = JSON.parse(content)
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
    if (
      !normalized ||
      shouldRetryAsUntranslated(item.text, normalized) ||
      shouldRetryAsOverCompressed(item.text, normalized)
    ) {
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
        const raw = await requestBatchTranslations([item], apiKey, dictionary, true)
        const { resolved } = validateBatchTranslations([item], raw)
        const translated = resolved.get(item.id)
        if (!translated) {
          if (attempt < SINGLE_ITEM_RETRIES - 1) {
            await sleep(500 * (attempt + 1))
            continue
          }
          break
        }

        recovered.set(item.id, translated)
        break
      } catch {
        if (attempt === SINGLE_ITEM_RETRIES - 1) break
        await sleep(500 * (attempt + 1))
      }
    }
  }

  return recovered
}

export async function compressTranslation(
  text: string,
  targetChars: number,
  apiKey: string
): Promise<string> {
  const systemPrompt = [
    `Compress the Chinese sentence below to no more than ${targetChars} characters.`,
    'Preserve technical meaning, terminology, logic, and procedural intent.',
    'Keep it natural and complete, not keyword fragments.',
    'Output JSON only, with shape {"text":"..."}',
  ].join('\n')

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(
        API_URL,
        buildChatRequest(
          apiKey,
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text },
          ],
          512,
          0.2
        ),
        DEEPSEEK_COMPRESS_TIMEOUT_MS,
        `DeepSeek 鍘嬬缉瓒呮椂锛?${Math.round(DEEPSEEK_COMPRESS_TIMEOUT_MS / 1000)} 绉掞級`
      )

      if (!response.ok) throw new Error(`DeepSeek API ${response.status}`)

      const data = await response.json()
      const content = data.choices?.[0]?.message?.content
      if (!content) continue

      const parsed = JSON.parse(content) as { text?: string }
      return parsed.text || text
    } catch {
      if (attempt === MAX_RETRIES - 1) return text
      await sleep(1000 * (attempt + 1))
    }
  }

  return text
}

