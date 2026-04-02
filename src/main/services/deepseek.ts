import type { Cue } from '../../types'

const API_URL = 'https://api.deepseek.com/chat/completions'
const BATCH_SIZE = 15
const MAX_RETRIES = 3
const DEEPSEEK_TEST_TIMEOUT_MS = 15_000
const DEEPSEEK_TRANSLATE_TIMEOUT_MS = 45_000
const DEEPSEEK_COMPRESS_TIMEOUT_MS = 45_000

interface TranslationResult {
  translations: Array<{ id: number; text: string }>
}

interface TranslationInputItem {
  id: number
  text: string
  max_chars?: number
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
  if (!key) return { ok: false, message: '未填写 API Key' }

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
      `DeepSeek 连接超时（>${Math.round(DEEPSEEK_TEST_TIMEOUT_MS / 1000)} 秒）`
    )

    if (response.ok) return { ok: true }

    const body = await response.text()
    let message = `请求失败 (${response.status})`
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } }
      if (parsed.error?.message) message = parsed.error.message
    } catch {
      if (body) message = body.slice(0, 200)
    }
    return { ok: false, message }
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : '网络错误' }
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
  maxCharsPerCue?: Map<number, number>,
  betweenBatches?: () => void | Promise<void>
): Promise<Map<number, string>> {
  const items = cues.map((cue) => ({
    id: cue.id,
    text: cue.text,
    ...(maxCharsPerCue?.has(cue.id) ? { max_chars: maxCharsPerCue.get(cue.id) } : {}),
  }))

  return translateItems(items, apiKey, dictionary, betweenBatches)
}

export async function translateSegments(
  segments: Array<{ id: number; text: string }>,
  apiKey: string,
  dictionary: Array<{ en: string; zh: string }>,
  maxCharsPerSegment?: Map<number, number>,
  betweenBatches?: () => void | Promise<void>
): Promise<Map<number, string>> {
  const items = segments.map((segment) => ({
    id: segment.id,
    text: segment.text,
    ...(maxCharsPerSegment?.has(segment.id)
      ? { max_chars: maxCharsPerSegment.get(segment.id) }
      : {}),
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
    const batchResult = await translateBatch(batch, apiKey, dictionary)
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
  const dictLines =
    dictionary.length > 0
      ? dictionary
          .filter((item) => item.en.trim())
          .map((item) => `- ${item.en.trim()} => ${item.zh.trim()}`)
          .join('\n')
      : ''

  const systemPrompt = [
    '你是专业的英文字幕翻译员。',
    '请把每条英文字幕翻译成自然、准确、简洁的中文讲解句。',
    dictLines ? `术语表:\n${dictLines}` : '',
    '要求:',
    '1. 保持原意、逻辑关系、术语和操作步骤，不要随意发挥。',
    '2. 如果原文出现术语表中的英文术语，译文必须使用术语表指定写法。',
    '3. 输出必须是 JSON，格式为 {"translations":[{"id":1,"text":"..."}]}。',
  ]
    .filter(Boolean)
    .join('\n')

  const userPrompt = JSON.stringify(items)

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
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
        `DeepSeek 翻译超时（>${Math.round(DEEPSEEK_TRANSLATE_TIMEOUT_MS / 1000)} 秒）`
      )

      if (!response.ok) {
        const errBody = await response.text()
        throw new Error(`DeepSeek API ${response.status}: ${errBody}`)
      }

      const data = await response.json()
      const content = data.choices?.[0]?.message?.content
      if (!content) {
        if (attempt < MAX_RETRIES - 1) continue
        throw new Error('DeepSeek 返回空内容')
      }

      const parsed: TranslationResult = JSON.parse(content)
      const result = new Map<number, string>()

      for (const item of parsed.translations ?? []) {
        result.set(item.id, item.text)
      }

      for (const item of items) {
        if (!result.has(item.id)) {
          result.set(item.id, item.text)
        }
      }

      return result
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err
      await sleep(1000 * (attempt + 1))
    }
  }

  throw new Error('translateBatch: 超过最大重试次数')
}

export async function compressTranslation(
  text: string,
  targetChars: number,
  apiKey: string
): Promise<string> {
  const systemPrompt = [
    `将下面的中文压缩到不超过 ${targetChars} 个字。`,
    '保持专业含义、术语、逻辑和操作步骤不变。',
    '表达可以更紧凑，但仍要是自然完整的中文句子。',
    '只输出 JSON，格式为 {"text":"压缩后的内容"}。',
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
        `DeepSeek 压缩超时（>${Math.round(DEEPSEEK_COMPRESS_TIMEOUT_MS / 1000)} 秒）`
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
