import type { LLMConfig } from '../../../types'
import {
  LLM_COMPRESS_TIMEOUT_MS,
  requestLLMJson,
} from './llm-client'
import { isAcceptableCompressedChinese, normalizeSpaces } from '../text-guard'

const MAX_RETRIES = 3

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function compressTranslation(
  text: string,
  targetChars: number,
  llm: LLMConfig
): Promise<string> {
  const systemPrompt = [
    `Compress the Chinese sentence below to no more than ${targetChars} characters.`,
    'Preserve technical meaning, terminology, logic, and procedural intent.',
    'Keep the output in Simplified Chinese (except unavoidable short technical tokens like API/HTTP).',
    'Do not output full English sentences.',
    'Keep it natural and complete, not keyword fragments.',
    'Output JSON only, with shape {"text":"..."}',
  ].join('\n')

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const parsed = await requestLLMJson<{ text?: string }>(
        llm,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        512,
        0.2,
        LLM_COMPRESS_TIMEOUT_MS,
        `LLM 压缩超时（${Math.round(LLM_COMPRESS_TIMEOUT_MS / 1000)} 秒）`
      )

      const candidate = normalizeSpaces(parsed.text ?? '')
      if (!candidate) continue
      if (!isAcceptableCompressedChinese(text, candidate)) continue
      return candidate
    } catch {
      if (attempt === MAX_RETRIES - 1) return text
      await sleep(1000 * (attempt + 1))
    }
  }
  return text
}
