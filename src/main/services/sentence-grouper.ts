import { createHash } from 'crypto'
import type { Cue, LLMConfig, SentenceGroup } from '../../types'
import {
  LLM_GROUPING_TIMEOUT_MS,
  SENTENCE_GROUP_CHUNK_SIZE,
  SENTENCE_GROUP_OVERLAP,
  SENTENCE_GROUPING_VERSION,
} from './audio'
import { requestLLMJson, type ChatMessage } from './llm'
import { groupCuesByGap } from './audio'

export type RequestJsonFn = <T>(
  llm: LLMConfig,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
  timeoutMessage: string
) => Promise<T>

export interface GroupSentencesOptions {
  llm: LLMConfig
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

Each input cue carries these fields:
- id: integer cue identifier
- text: the cue text
- gap_ms: silence between this cue and the previous one (0 for the first cue in the chunk)
- dur_ms: duration of this cue
- ends_strong: true if cue ends with . ? ! 。 ！ ？
- ends_soft: true if cue ends with , ; : , ; : — – (mid-sentence punctuation)
- starts_lower: true if cue starts with a lowercase letter (strong signal of mid-sentence continuation)

Rules:
1. Group consecutive cues only. Never reorder. Every input id MUST appear in exactly one group, in original order.
2. A group ends when the speaker has completed a thought: a cue with ends_strong=true AND the next cue starts a new topic / capital subject.
3. STRONGLY MERGE when the previous cue has ends_soft=true OR the next cue has starts_lower=true OR the next cue begins with "and / but / so / because / which / that / or / nor / yet". This applies even if gap_ms is large (1500-3000ms).
4. Only SPLIT when previous cue has ends_strong=true AND next cue clearly begins a new topic (capital noun/pronoun, no continuation conjunction).
5. AVOID singleton groups (a single short cue) unless that cue is itself a complete sentence ending with ends_strong=true and the speaker is genuinely shifting topic. Prefer groups that span at least 1500ms or contain a complete clause.
6. A single group's total span (last cue end - first cue start) SHOULD NOT exceed 7000ms. If a sentence is genuinely longer, split at the most natural sub-boundary.
7. Output strict JSON: {"groups":[[1,2,3],[4],[5,6]]}. No prose, no markdown fences.`

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

const STRONG_END_RE = /[.?!。！？]+["')\]]*\s*$/u
const SOFT_END_RE = /[,;:，；：\-–—]+["')\]]*\s*$/u
const STARTS_LOWERCASE_RE = /^["'([]*[a-z]/

function buildUserPayload(chunk: Cue[]): string {
  const items = chunk.map((cue, idx) => {
    const prev = chunk[idx - 1]
    const gapMs = prev ? Math.max(0, Math.round((cue.startUs - prev.endUs) / 1000)) : 0
    const durMs = Math.max(0, Math.round((cue.endUs - cue.startUs) / 1000))
    const trimmed = cue.text.trim()
    const endsStrong = STRONG_END_RE.test(trimmed)
    const endsSoft = !endsStrong && SOFT_END_RE.test(trimmed)
    const startsLower = STARTS_LOWERCASE_RE.test(trimmed)
    return {
      id: cue.id,
      text: cue.text,
      gap_ms: gapMs,
      dur_ms: durMs,
      ends_strong: endsStrong,
      ends_soft: endsSoft,
      starts_lower: startsLower,
    }
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

async function callLLMForChunk(
  chunk: Cue[],
  llm: LLMConfig,
  requestJson: RequestJsonFn
): Promise<SentenceGroup[] | null> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPayload(chunk) },
  ]
  try {
    const raw = await requestJson<LLMResponse>(
      llm,
      messages,
      2048,
      0,
      LLM_GROUPING_TIMEOUT_MS,
      `LLM 分句超时（${Math.round(LLM_GROUPING_TIMEOUT_MS / 1000)} 秒）`
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
  const cueOrder = allCues.map((c) => c.id)
  const cueIndex = new Map(cueOrder.map((id, idx) => [id, idx]))

  // Vote tally: for each cueId, count how many chunks saw it, and how many of those flagged it
  // as a group boundary (i.e. the last cue in a group). A cue becomes a boundary only when
  // every chunk that saw it agrees — this prevents stray mid-sentence splits in overlap regions.
  const seenCount = new Map<number, number>()
  const boundaryVotes = new Map<number, number>()

  for (let ci = 0; ci < chunkResults.length; ci++) {
    const { chunkCueIds, groups: chunkGroups } = chunkResults[ci]
    const groups =
      chunkGroups ??
      (() => {
        usedFallback = true
        const slice = chunkCueIds.map((id) => allCues[cueIndex.get(id)!])
        return groupCuesByGap(slice)
      })()

    const chunkBoundaries = new Set<number>()
    for (const g of groups) {
      if (g.cueIds.length === 0) continue
      const lastId = g.cueIds[g.cueIds.length - 1]
      chunkBoundaries.add(lastId)
    }

    for (const id of chunkCueIds) {
      seenCount.set(id, (seenCount.get(id) ?? 0) + 1)
      if (chunkBoundaries.has(id)) {
        boundaryVotes.set(id, (boundaryVotes.get(id) ?? 0) + 1)
      }
    }
  }

  const boundaries = new Set<number>()
  for (const id of cueOrder) {
    const seen = seenCount.get(id) ?? 0
    const votes = boundaryVotes.get(id) ?? 0
    if (seen === 0) continue
    // Unanimous vote required: every chunk that saw this cue flagged it as a boundary.
    if (votes === seen) boundaries.add(id)
  }
  // Final cue is always a boundary, otherwise the trailing group would be dropped.
  boundaries.add(cueOrder[cueOrder.length - 1])

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

  const llm = options.llm
  if (!llm?.apiKey?.trim() || !llm?.baseUrl?.trim() || !llm?.model?.trim()) {
    return { groups: groupCuesByGap(cues), usedFallback: true }
  }

  const requestJson = options.requestJson ?? requestLLMJson
  const chunks = buildChunks(cues)
  const chunkResults: Array<{ chunkCueIds: number[]; groups: SentenceGroup[] | null }> = []
  let allFailed = true

  for (let i = 0; i < chunks.length; i++) {
    if (options.betweenChunks && i > 0) {
      await options.betweenChunks()
    }
    const chunk = chunks[i]
    const result = await callLLMForChunk(chunk, llm, requestJson)
    if (result !== null) allFailed = false
    chunkResults.push({ chunkCueIds: chunk.map((c) => c.id), groups: result })
  }

  if (allFailed) {
    return { groups: groupCuesByGap(cues), usedFallback: true }
  }

  return mergeOverlappingChunks(chunkResults, cues)
}
