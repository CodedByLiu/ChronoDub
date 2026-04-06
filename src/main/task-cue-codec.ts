import type { Cue } from '../types'

export interface SerializedTranslationCache {
  configSignature: string
  segmentTranslations: Array<{ id: number; text: string }>
}

export interface TaskCueFileV1 {
  version: 1
  englishCues?: Cue[]
  chineseCues?: Cue[]
}

export interface TaskCueFileV2 {
  version: 2
  englishCues?: Cue[]
  chineseCues?: Cue[]
  translationCache?: SerializedTranslationCache
}

export type TaskCueFile = TaskCueFileV1 | TaskCueFileV2

export interface TaskCueSnapshot {
  englishCues?: Cue[]
  chineseCues?: Cue[]
  translationCache?: SerializedTranslationCache
}

export interface TaskTranslationCache {
  configSignature: string
  segmentTranslations: Map<number, string>
}

export function cloneCue(cue: Cue): Cue {
  return {
    id: cue.id,
    startUs: cue.startUs,
    endUs: cue.endUs,
    text: cue.text,
    ...(cue.rawStyle !== undefined ? { rawStyle: cue.rawStyle } : {}),
  }
}

export function cloneSerializedTranslationCache(
  cache: SerializedTranslationCache | undefined
): SerializedTranslationCache | undefined {
  if (!cache) return undefined
  return {
    configSignature: cache.configSignature,
    segmentTranslations: cache.segmentTranslations.map((item) => ({
      id: item.id,
      text: item.text,
    })),
  }
}

export function cloneTaskCueSnapshot(data: TaskCueSnapshot | null): TaskCueSnapshot | null {
  if (!data) return null
  return {
    ...(data.englishCues ? { englishCues: data.englishCues.map(cloneCue) } : {}),
    ...(data.chineseCues ? { chineseCues: data.chineseCues.map(cloneCue) } : {}),
    ...(data.translationCache
      ? { translationCache: cloneSerializedTranslationCache(data.translationCache) }
      : {}),
  }
}

export function cuesFromTaskCueSnapshot(data: TaskCueSnapshot | null) {
  if (!data) return null
  if (!data.englishCues && !data.chineseCues) return null
  return {
    ...(data.englishCues ? { englishCues: data.englishCues.map(cloneCue) } : {}),
    ...(data.chineseCues ? { chineseCues: data.chineseCues.map(cloneCue) } : {}),
  }
}

export function parseSerializedTranslationCache(raw: unknown): SerializedTranslationCache | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as {
    configSignature?: unknown
    segmentTranslations?: unknown
  }

  if (typeof record.configSignature !== 'string' || !Array.isArray(record.segmentTranslations)) {
    return undefined
  }

  const entries: Array<{ id: number; text: string }> = []
  for (const item of record.segmentTranslations) {
    if (!item || typeof item !== 'object') continue
    const pair = item as { id?: unknown; text?: unknown }
    if (typeof pair.id !== 'number' || !Number.isFinite(pair.id)) continue
    if (typeof pair.text !== 'string') continue
    entries.push({ id: pair.id, text: pair.text })
  }

  return {
    configSignature: record.configSignature,
    segmentTranslations: entries,
  }
}

export function parseTaskCueFile(parsed: unknown): TaskCueSnapshot | null {
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as TaskCueFile
  if (record.version !== 1 && record.version !== 2) return null

  return {
    ...(Array.isArray(record.englishCues) ? { englishCues: record.englishCues.map(cloneCue) } : {}),
    ...(Array.isArray(record.chineseCues) ? { chineseCues: record.chineseCues.map(cloneCue) } : {}),
    ...(record.version === 2
      ? { translationCache: parseSerializedTranslationCache(record.translationCache) }
      : {}),
  }
}

export function hasTaskCueContent(snapshot: TaskCueSnapshot): boolean {
  return (
    snapshot.englishCues !== undefined ||
    snapshot.chineseCues !== undefined ||
    snapshot.translationCache !== undefined
  )
}

export function toTaskCueFileV2(snapshot: TaskCueSnapshot): TaskCueFileV2 {
  return {
    version: 2,
    ...(snapshot.englishCues ? { englishCues: snapshot.englishCues.map(cloneCue) } : {}),
    ...(snapshot.chineseCues ? { chineseCues: snapshot.chineseCues.map(cloneCue) } : {}),
    ...(snapshot.translationCache
      ? { translationCache: cloneSerializedTranslationCache(snapshot.translationCache) }
      : {}),
  }
}

export function serializeTaskTranslationCache(cache: TaskTranslationCache): SerializedTranslationCache {
  return {
    configSignature: cache.configSignature,
    segmentTranslations: Array.from(cache.segmentTranslations.entries()).map(([id, text]) => ({
      id,
      text,
    })),
  }
}

export function deserializeTaskTranslationCache(
  cache: SerializedTranslationCache | undefined
): TaskTranslationCache | null {
  if (!cache) return null
  return {
    configSignature: cache.configSignature,
    segmentTranslations: new Map(cache.segmentTranslations.map((item) => [item.id, item.text])),
  }
}
