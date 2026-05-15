import { createHash } from 'crypto'
import type { Cue, SentenceGroup } from '../../types'
import {
  DEEPSEEK_GROUPING_TIMEOUT_MS,
  SENTENCE_GROUP_CHUNK_SIZE,
  SENTENCE_GROUP_OVERLAP,
  SENTENCE_GROUPING_VERSION,
} from './audio-constants'
import { requestDeepseekJson, type ChatMessage } from './deepseek-client'
import { groupCuesByGap } from './audio-segmentation'

export type RequestJsonFn = <T>(
  apiKey: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
  timeoutMessage: string
) => Promise<T>

export interface GroupSentencesOptions {
  apiKey: string
  cachedGroups?: SentenceGroup[] | null
  betweenChunks?: () => void | Promise<void>
  requestJson?: RequestJsonFn
}

export interface GroupSentencesResult {
  groups: SentenceGroup[]
  usedFallback: boolean
}

interface LLMResponse {
  groups: number[][]
}

const SYSTEM_PROMPT = `You are a sentence boundary detector for English subtitles that will be translated into Chinese and dubbed by a TTS engine. Subtitle cues are often split mid-sentence by the captioner; your job is to GROUP consecutive cue ids that belong to the SAME spoken sentence, so the TTS reads them as one continuous utterance.

Rules:
1. Group consecutive cues only. Never reorder. Every input id MUST appear in exactly one group, in original order.
2. A group ends when the speaker has completed a thought: declarative period, question, exclamation, OR a clear topic shift between adjacent cues.
3. Do NOT be misled by trailing commas / dashes / lowercase starts — those usually signal mid-sentence and SHOULD be merged regardless of gap_ms.
4. Even if gap_ms is large (1500-3000ms), if the previous cue ends with a comma or conjunction and the next starts lowercase / with "and / but / so / because / which / that", MERGE.
5. If the previous cue ends with "." "?" "!" and the next starts with a capital noun/pronoun beginning a new topic, SPLIT.
6. A single group's total span (last.end - first.start) SHOULD NOT exceed 7000ms. If a sentence is longer, split at the most natural sub-boundary.
7. Output strict JSON: {"groups":[[1,2,3],[4],[5,6]]}. No prose.`

export function computeGroupingSignature(cues: Cue[]): string {
  const hash = createHash('sha256')
  for (const cue of cues) {
    hash.update(String(cue.id))
    hash.update('\0')
    hash.update(String(cue.startUs))
    hash.update('\0')
    hash.update(String(cue.endUs))
    hash.update('\0')
    hash.update(cue.text)
    hash.update('\n')
  }
  return `${SENTENCE_GROUPING_VERSION}:${hash.digest('hex').slice(0, 16)}`
}

function buildChunks(cues: Cue[]): Cue[][] {
  if (cues.length === 0) return []
  const chunks: Cue[][] = []
  const step = Math.max(1, SENTENCE_GROUP_CHUNK_SIZE - SENTENCE_GROUP_OVERLAP)
  for (let start = 0; start < cues.length; start += step) {
    const end = Math.min(start + SENTENCE_GROUP_CHUNK_SIZE, cues.length)
    chunks.push(cues.slice(start, end))
    if (end >= cues.length) break
  }
  return chunks
}

function buildUserPayload(chunk: Cue[]): string {
  const items = chunk.map((cue, idx) => {
    const prev = chunk[idx - 1]
    const gapMs = prev ? Math.max(0, Math.round((cue.startUs - prev.endUs) / 1000)) : 0
    return { id: cue.id, text: cue.text, gap_ms: gapMs }
  })
  return JSON.stringify({ cues: items })
}

function validateChunkOutput(raw: unknown, chunk: Cue[]): SentenceGroup[] | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { groups?: unknown }
  if (!Array.isArray(obj.groups)) return null
  const expected = chunk.map((c) => c.id)
  const seen: number[] = []
  const result: SentenceGroup[] = []
  for (const g of obj.groups) {
    if (!Array.isArray(g) || g.length === 0) return null
    const cueIds: number[] = []
    for (const id of g) {
      if (typeof id !== 'number' || !Number.isInteger(id)) return null
      cueIds.push(id)
      seen.push(id)
    }
    result.push({ cueIds })
  }
  if (seen.length !== expected.length) return null
  for (let i = 0; i < expected.length; i++) {
    if (seen[i] !== expected[i]) return null
  }
  return result
}

async function callDeepseekForChunk(
  chunk: Cue[],
  apiKey: string,
  requestJson: RequestJsonFn
): Promise<SentenceGroup[] | null> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPayload(chunk) },
  ]
  try {
    const raw = await requestJson<LLMResponse>(
      apiKey,
      messages,
      2048,
      0,
      DEEPSEEK_GROUPING_TIMEOUT_MS,
      `DeepSeek 分句超时（${Math.round(DEEPSEEK_GROUPING_TIMEOUT_MS / 1000)} 秒）`
    )
    return validateChunkOutput(raw, chunk)
  } catch (err) {
    console.warn(`[sentence-grouper] chunk call failed:`, err instanceof Error ? err.message : err)
    return null
  }
}

function mergeOverlappingChunks(
  chunkResults: Array<{ chunkCueIds: number[]; groups: SentenceGroup[] | null }>,
  allCues: Cue[]
): { groups: SentenceGroup[]; usedFallback: boolean } {
  if (chunkResults.length === 0) return { groups: [], usedFallback: false }

  let usedFallback = false
  const fallbackGroups = groupCuesByGap(allCues)
  const fallbackBoundaries = new Set<number>()
  for (const g of fallbackGroups) {
    if (g.cueIds.length > 0) fallbackBoundaries.add(g.cueIds[g.cueIds.length - 1])
  }

  const cueOrder = allCues.map((c) => c.id)
  const cueIndex = new Map(cueOrder.map((id, idx) => [id, idx]))

  const boundaries = new Set<number>()
  boundaries.add(cueOrder[cueOrder.length - 1])

  for (let ci = 0; ci < chunkResults.length; ci++) {
    const { chunkCueIds, groups: chunkGroups } = chunkResults[ci]
    const chunkSet = new Set(chunkCueIds)
    const isLastChunk = ci === chunkResults.length - 1

    const groups = chunkGroups ?? (() => {
      usedFallback = true
      const slice = chunkCueIds.map((id) => allCues[cueIndex.get(id)!])
      return groupCuesByGap(slice)
    })()

    const overlapStart = !isLastChunk
      ? chunkCueIds.length - SENTENCE_GROUP_OVERLAP
      : chunkCueIds.length
    for (const g of groups) {
      if (g.cueIds.length === 0) continue
      const lastId = g.cueIds[g.cueIds.length - 1]
      const lastPosInChunk = chunkCueIds.indexOf(lastId)
      if (lastPosInChunk < 0 || !chunkSet.has(lastId)) continue
      if (lastPosInChunk >= overlapStart) continue
      boundaries.add(lastId)
    }
  }

  const groups: SentenceGroup[] = []
  let current: number[] = []
  for (const id of cueOrder) {
    current.push(id)
    if (boundaries.has(id)) {
      groups.push({ cueIds: current })
      current = []
    }
  }
  if (current.length > 0) groups.push({ cueIds: current })

  return { groups, usedFallback }
}

export async function groupSentencesWithLLM(
  cues: Cue[],
  options: GroupSentencesOptions
): Promise<GroupSentencesResult> {
  if (cues.length === 0) return { groups: [], usedFallback: false }

  if (options.cachedGroups && options.cachedGroups.length > 0) {
    return { groups: options.cachedGroups, usedFallback: false }
  }

  const apiKey = options.apiKey?.trim()
  if (!apiKey) {
    return { groups: groupCuesByGap(cues), usedFallback: true }
  }

  const requestJson = options.requestJson ?? requestDeepseekJson
  const chunks = buildChunks(cues)
  const chunkResults: Array<{ chunkCueIds: number[]; groups: SentenceGroup[] | null }> = []
  let allFailed = true

  for (let i = 0; i < chunks.length; i++) {
    if (options.betweenChunks && i > 0) {
      await options.betweenChunks()
    }
    const chunk = chunks[i]
    const result = await callDeepseekForChunk(chunk, apiKey, requestJson)
    if (result !== null) allFailed = false
    chunkResults.push({ chunkCueIds: chunk.map((c) => c.id), groups: result })
  }

  if (allFailed) {
    return { groups: groupCuesByGap(cues), usedFallback: true }
  }

  return mergeOverlappingChunks(chunkResults, cues)
}
