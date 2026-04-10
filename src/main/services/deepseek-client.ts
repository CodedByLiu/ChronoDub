export const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'
export const DEEPSEEK_TEST_TIMEOUT_MS = 15_000
export const DEEPSEEK_TRANSLATE_TIMEOUT_MS = 45_000
export const DEEPSEEK_COMPRESS_TIMEOUT_MS = 45_000
export const DEEPSEEK_REWRITE_TIMEOUT_MS = 60_000

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

function buildChatRequest(
  apiKey: string,
  messages: ChatMessage[],
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

export async function fetchWithTimeout(
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

export async function requestDeepseekJson<T>(
  apiKey: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  const response = await fetchWithTimeout(
    DEEPSEEK_API_URL,
    buildChatRequest(apiKey, messages, maxTokens, temperature),
    timeoutMs,
    timeoutMessage
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

  return JSON.parse(content) as T
}

export async function testDeepseekPing(apiKey: string): Promise<{ ok: boolean; message?: string }> {
  const key = apiKey.trim()
  if (!key) return { ok: false, message: '未填写 API Key' }

  try {
    const response = await fetchWithTimeout(
      DEEPSEEK_API_URL,
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
      `DeepSeek 连接超时（${Math.round(DEEPSEEK_TEST_TIMEOUT_MS / 1000)} 秒）`
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
