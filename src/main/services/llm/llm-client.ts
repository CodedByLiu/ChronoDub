import type { LLMConfig } from '../../types'

export const LLM_TEST_TIMEOUT_MS = 15_000
export const LLM_TRANSLATE_TIMEOUT_MS = 45_000
export const LLM_COMPRESS_TIMEOUT_MS = 45_000
export const LLM_REWRITE_TIMEOUT_MS = 60_000

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

function resolveEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return `${trimmed}/chat/completions`
}

function buildChatRequest(
  llm: LLMConfig,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number
): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
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

export async function requestLLMJson<T>(
  llm: LLMConfig,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  const response = await fetchWithTimeout(
    resolveEndpoint(llm.baseUrl),
    buildChatRequest(llm, messages, maxTokens, temperature),
    timeoutMs,
    timeoutMessage
  )

  if (!response.ok) {
    const errBody = await response.text()
    throw new Error(`LLM API ${response.status}: ${errBody}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('LLM returned empty content')
  }

  return JSON.parse(content) as T
}

export async function testLLMPing(llm: LLMConfig): Promise<{ ok: boolean; message?: string }> {
  const baseUrl = llm.baseUrl?.trim() ?? ''
  const model = llm.model?.trim() ?? ''
  const apiKey = llm.apiKey?.trim() ?? ''
  if (!baseUrl) return { ok: false, message: '未填写 Base URL' }
  if (!model) return { ok: false, message: '未填写模型名称' }
  if (!apiKey) return { ok: false, message: '未填写 API Key' }

  try {
    const response = await fetchWithTimeout(
      resolveEndpoint(baseUrl),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      },
      LLM_TEST_TIMEOUT_MS,
      `LLM 连接超时（${Math.round(LLM_TEST_TIMEOUT_MS / 1000)} 秒）`
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
