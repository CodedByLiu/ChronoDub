import type { Cue } from '../../types'

const API_URL = 'https://api.deepseek.com/chat/completions'
const BATCH_SIZE = 15
const MAX_RETRIES = 3

export async function testDeepseekConnection(
  apiKey: string
): Promise<{ ok: boolean; message?: string }> {
  const key = apiKey.trim()
  if (!key) return { ok: false, message: '未填写 API Key' }

  try {
    const response = await fetch(API_URL, {
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
    })

    if (response.ok) return { ok: true }

    const body = await response.text()
    let msg = `请求失败 (${response.status})`
    try {
      const j = JSON.parse(body) as { error?: { message?: string } }
      if (j.error?.message) msg = j.error.message
    } catch {
      if (body) msg = body.slice(0, 200)
    }
    return { ok: false, message: msg }
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : '网络错误'
    return { ok: false, message: m }
  }
}

interface TranslationResult {
  translations: Array<{ id: number; text: string }>
}

function escapeRegexTerm(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 英文字幕行中是否出现该术语（词界或含 + 等标识符） */
function englishCueHasTerm(cueText: string, term: string): boolean {
  const t = term.trim()
  if (!t) return false
  const lower = cueText.toLowerCase()
  const tl = t.toLowerCase()
  if (lower.includes(tl)) return true
  if (/^[\w.+$#@-]+$/.test(t)) {
    try {
      return new RegExp(`\\b${escapeRegexTerm(t)}\\b`, 'i').test(cueText)
    } catch {
      return false
    }
  }
  return false
}

/**
 * 译文中若仍保留英文术语写法，按词典强制替换为指定中文（或保留品牌写法）
 */
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
    const replacement = zh.trim()
    const re = new RegExp(escapeRegexTerm(term), 'gi')
    out = out.replace(re, replacement)
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
  const result = new Map<number, string>()

  for (let i = 0; i < cues.length; i += BATCH_SIZE) {
    await betweenBatches?.()
    const batch = cues.slice(i, i + BATCH_SIZE)
    const batchResult = await translateBatch(batch, apiKey, dictionary, maxCharsPerCue)
    for (const [id, text] of batchResult) {
      result.set(id, text)
    }
  }

  return result
}

async function translateBatch(
  cues: Cue[],
  apiKey: string,
  dictionary: Array<{ en: string; zh: string }>,
  maxCharsPerCue?: Map<number, number>
): Promise<Map<number, string>> {
  const dictLines =
    dictionary.length > 0
      ? dictionary
          .filter((d) => d.en.trim())
          .map((d) => `「${d.en.trim()}」→「${d.zh.trim()}」`)
          .join('\n')
      : ''

  const dictText =
    dictLines.length > 0
      ? `\n【术语表】以下左侧英文在对应字幕行中出现时，译文中必须使用右侧给定形式（逐字一致，不得改用近义词、音译或其它英文写法）：\n${dictLines}\n`
      : ''

  const cueItems = cues.map((cue) => {
    const budget = maxCharsPerCue?.get(cue.id)
    return {
      id: cue.id,
      text: cue.text,
      ...(budget ? { max_chars: budget } : {}),
    }
  })

  const systemPrompt = `你是专业的英中字幕翻译员。将每条英文字幕翻译为自然流畅的中文。
${dictText}
要求：
1. 保持原意，口语化；若存在术语表，凡原文出现该英文术语，译文中对应位置必须使用表中右侧写法
2. 如果提供了 max_chars，该条译文字符数必须不超过 max_chars
3. 不要添加原文没有的内容
4. 仅输出 JSON：{"translations": [{"id": <number>, "text": "<中文>"}]}`

  const userPrompt =
    (dictLines.length > 0
      ? `术语表必须遵守（见 system）。\n待译条目：\n`
      : '') + JSON.stringify(cueItems)

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 4096,
          temperature: 0.3,
        }),
      })

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

      for (const item of parsed.translations) {
        result.set(item.id, item.text)
      }

      for (const cue of cues) {
        if (!result.has(cue.id)) {
          result.set(cue.id, cue.text)
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
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `将以下中文文本压缩到不超过 ${targetChars} 个字，保留核心语义。输出 JSON: {"text": "<压缩后文本>"}`,
            },
            { role: 'user', content: text },
          ],
          max_tokens: 512,
          temperature: 0.2,
        }),
      })

      if (!response.ok) throw new Error(`DeepSeek API ${response.status}`)
      const data = await response.json()
      const content = data.choices?.[0]?.message?.content
      if (!content) continue

      const parsed = JSON.parse(content)
      return parsed.text || text
    } catch {
      if (attempt === MAX_RETRIES - 1) return text
      await sleep(1000 * (attempt + 1))
    }
  }
  return text
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
