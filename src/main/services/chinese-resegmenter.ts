import type { LLMConfig } from '../../types'
import {
  CHINESE_SPLIT_BATCH_SIZE,
  LLM_CHINESE_SPLIT_TIMEOUT_MS,
  SUBTITLE_MAX_CHARS_PER_CUE,
  SUBTITLE_MIN_CHARS_PER_CUE,
} from './audio'
import { requestLLMJson, type ChatMessage } from './llm'

export type RequestJsonFn = <T>(
  llm: LLMConfig,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
  timeoutMessage: string
) => Promise<T>

export interface ChineseResegmentInput {
  segmentId: number
  text: string
  durationMs: number
}

export interface ChineseResegmentOptions {
  llm: LLMConfig
  requestJson?: RequestJsonFn
  betweenBatches?: () => void | Promise<void>
}

const SYSTEM_PROMPT = `You are a Chinese subtitle line-break planner for TTS dubbing.

Input: an array of items, each with an id, a Chinese text, and the total duration in milliseconds the dubbed audio occupies.

Your job: split each Chinese text into one or more on-screen subtitle lines optimized for natural Mandarin speech pauses and TTS readability.

Rules:
1. Each output line MUST contain between ${SUBTITLE_MIN_CHARS_PER_CUE} and ${SUBTITLE_MAX_CHARS_PER_CUE} Chinese characters (counting punctuation). Never produce 1-3 character orphan lines like "我。" or "电子。".
2. Prefer breaks at strong terminators 。 ！ ？; fall back to soft terminators ，； : 、 if needed.
3. Preserve content. The concatenation of your output lines, after stripping whitespace and ASCII punctuation, MUST equal the input text under the same normalization. You MAY reflow a trailing punctuation across the boundary (e.g. move "，" from the end of one line to the start of the next), but you MUST NOT add, drop, or paraphrase any Chinese character.
4. If duration_ms is below 1500 OR the input is shorter than ${SUBTITLE_MAX_CHARS_PER_CUE} characters, prefer a single line. Long durations (>5000ms) usually benefit from 2-3 lines.
5. Output strict JSON: {"results":[{"id":<segment-id>,"lines":["...","..."]}]}. Every input id MUST appear exactly once. No prose, no markdown fences.`

function buildBatches(items: ChineseResegmentInput[]): ChineseResegmentInput[][] {
  if (items.length === 0) return []
  const batches: ChineseResegmentInput[][] = []
  for (let i = 0; i < items.length; i += CHINESE_SPLIT_BATCH_SIZE) {
    batches.push(items.slice(i, i + CHINESE_SPLIT_BATCH_SIZE))
  }
  return batches
}

function buildUserPayload(batch: ChineseResegmentInput[]): string {
  return JSON.stringify({
    items: batch.map((s) => ({ id: s.segmentId, text: s.text, duration_ms: s.durationMs })),
  })
}

const NORMALIZE_STRIP_RE = /[\s\p{P}]+/gu

function normalizeForCompare(s: string): string {
  return s.replace(NORMALIZE_STRIP_RE, '')
}

// Validate LLM output and collect ONLY the segments that pass. Per-segment validation:
// a single bad item in the batch (paraphrased / dropped chars / id mismatch) no longer
// poisons the whole batch — the rest still benefit from the LLM result while the bad one
// falls back to the heuristic upstream.
function validateBatchOutput(
  raw: unknown,
  batch: ChineseResegmentInput[]
): Map<number, string[]> {
  const result = new Map<number, string[]>()
  if (!raw || typeof raw !== 'object') return result
  const obj = raw as { results?: unknown }
  if (!Array.isArray(obj.results)) return result
  const inputMap = new Map(batch.map((s) => [s.segmentId, s]))

  for (const item of obj.results) {
    if (!item || typeof item !== 'object') continue
    const o = item as { id?: unknown; lines?: unknown }
    if (typeof o.id !== 'number' || !Number.isInteger(o.id)) continue
    const input = inputMap.get(o.id)
    if (!input) continue
    if (!Array.isArray(o.lines) || o.lines.length === 0) continue
    if (result.has(o.id)) continue

    const lines: string[] = []
    let invalid = false
    for (const ln of o.lines) {
      if (typeof ln !== 'string') {
        invalid = true
        break
      }
      const t = ln.trim()
      if (!t) {
        invalid = true
        break
      }
      lines.push(t)
    }
    if (invalid) continue

    if (normalizeForCompare(lines.join('')) !== normalizeForCompare(input.text)) continue

    result.set(o.id, lines)
  }
  return result
}

async function callLLMForBatch(
  batch: ChineseResegmentInput[],
  llm: LLMConfig,
  requestJson: RequestJsonFn
): Promise<Map<number, string[]>> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPayload(batch) },
  ]
  try {
    const raw = await requestJson<unknown>(
      llm,
      messages,
      4096,
      0,
      LLM_CHINESE_SPLIT_TIMEOUT_MS,
      `LLM 中文分句超时（${Math.round(LLM_CHINESE_SPLIT_TIMEOUT_MS / 1000)} 秒）`
    )
    return validateBatchOutput(raw, batch)
  } catch (err) {
    console.warn(
      `[chinese-resegmenter] batch call failed:`,
      err instanceof Error ? err.message : err
    )
    return new Map()
  }
}

export async function resegmentChineseSegments(
  inputs: ChineseResegmentInput[],
  options: ChineseResegmentOptions
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>()
  if (inputs.length === 0) return result

  const llm = options.llm
  if (!llm?.apiKey?.trim() || !llm?.baseUrl?.trim() || !llm?.model?.trim()) {
    return result
  }

  const requestJson = options.requestJson ?? requestLLMJson
  const batches = buildBatches(inputs)

  for (let i = 0; i < batches.length; i++) {
    if (options.betweenBatches && i > 0) {
      await options.betweenBatches()
    }
    const batchResult = await callLLMForBatch(batches[i], llm, requestJson)
    for (const [id, lines] of batchResult.entries()) {
      result.set(id, lines)
    }
  }

  return result
}
