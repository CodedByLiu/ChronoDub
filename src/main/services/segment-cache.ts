import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { basename, extname, join } from 'path'
import type { SentenceGroup } from '../../types'
import type { AudioBoundary, ProcessedAudio } from './audio-processing'

export const SEGMENT_CACHE_VERSION = 1

interface CacheManifestFile {
  version: number
  taskId: string
  createdAt: string
}

interface TranslationCacheFile {
  version: number
  configSignature: string
  segmentTranslations: Array<{ id: number; text: string }>
}

interface SegmentMetadataFile {
  version: number
  configSignature: string
  textHash: string
  durationUs: number
  spokenText: string
  leadTrimUs: number
  boundaries: AudioBoundary[]
}

export interface CachedSegmentEntry {
  audio: ProcessedAudio
  textHash: string
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string'
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null
    return null
  }
}

function safeWriteJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

export function resolveCacheDir(outputDir: string, videoPath: string): string | null {
  if (!outputDir?.trim() || !videoPath?.trim()) return null
  const stem = basename(videoPath, extname(videoPath))
  if (!stem) return null
  return join(outputDir, `${stem}.chronodub-cache`)
}

function ensureCacheDir(cacheDir: string): void {
  mkdirSync(join(cacheDir, 'segments'), { recursive: true })
}

export function hashSegmentText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 16)
}

export function readCacheManifest(cacheDir: string): { taskId: string } | null {
  const file = safeReadJson<CacheManifestFile>(join(cacheDir, 'manifest.json'))
  if (!file || file.version !== SEGMENT_CACHE_VERSION) return null
  if (typeof file.taskId !== 'string' || !file.taskId) return null
  return { taskId: file.taskId }
}

function writeCacheManifest(cacheDir: string, taskId: string): void {
  ensureCacheDir(cacheDir)
  const manifest: CacheManifestFile = {
    version: SEGMENT_CACHE_VERSION,
    taskId,
    createdAt: new Date().toISOString(),
  }
  safeWriteJson(join(cacheDir, 'manifest.json'), manifest)
}

function manifestMatchesTask(cacheDir: string, taskId: string): boolean {
  const manifest = readCacheManifest(cacheDir)
  return manifest?.taskId === taskId
}

export interface LoadedTranslationCache {
  configSignature: string
  segmentTranslations: Map<number, string>
}

export function loadTranslationCache(
  cacheDir: string,
  taskId: string
): LoadedTranslationCache | null {
  if (!existsSync(cacheDir) || !manifestMatchesTask(cacheDir, taskId)) return null

  const file = safeReadJson<TranslationCacheFile>(join(cacheDir, 'translation.json'))
  if (!file || file.version !== SEGMENT_CACHE_VERSION) return null
  if (typeof file.configSignature !== 'string') return null
  if (!Array.isArray(file.segmentTranslations)) return null

  const map = new Map<number, string>()
  for (const entry of file.segmentTranslations) {
    if (!entry || typeof entry !== 'object') continue
    const { id, text } = entry as { id?: unknown; text?: unknown }
    if (typeof id !== 'number' || !Number.isFinite(id)) continue
    if (typeof text !== 'string') continue
    map.set(id, text)
  }

  return { configSignature: file.configSignature, segmentTranslations: map }
}

interface SentenceGroupCacheFile {
  version: number
  signature: string
  groups: Array<{ cueIds: number[] }>
}

export function loadSentenceGroupCache(
  cacheDir: string,
  taskId: string,
  signature: string
): SentenceGroup[] | null {
  if (!existsSync(cacheDir) || !manifestMatchesTask(cacheDir, taskId)) return null

  const file = safeReadJson<SentenceGroupCacheFile>(join(cacheDir, 'sentence-groups.json'))
  if (!file || file.version !== SEGMENT_CACHE_VERSION) return null
  if (file.signature !== signature) return null
  if (!Array.isArray(file.groups)) return null

  const groups: SentenceGroup[] = []
  for (const g of file.groups) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.cueIds)) continue
    const cueIds: number[] = []
    for (const id of g.cueIds) {
      if (typeof id === 'number' && Number.isInteger(id)) cueIds.push(id)
    }
    if (cueIds.length > 0) groups.push({ cueIds })
  }
  return groups.length > 0 ? groups : null
}

export function saveSentenceGroupCache(
  cacheDir: string,
  taskId: string,
  signature: string,
  groups: SentenceGroup[]
): void {
  ensureCacheDir(cacheDir)
  writeCacheManifest(cacheDir, taskId)
  const file: SentenceGroupCacheFile = {
    version: SEGMENT_CACHE_VERSION,
    signature,
    groups: groups.map((g) => ({ cueIds: [...g.cueIds] })),
  }
  safeWriteJson(join(cacheDir, 'sentence-groups.json'), file)
}

export function saveTranslationCache(
  cacheDir: string,
  taskId: string,
  configSignature: string,
  translations: Map<number, string>
): void {
  ensureCacheDir(cacheDir)
  writeCacheManifest(cacheDir, taskId)
  const file: TranslationCacheFile = {
    version: SEGMENT_CACHE_VERSION,
    configSignature,
    segmentTranslations: Array.from(translations.entries()).map(([id, text]) => ({ id, text })),
  }
  safeWriteJson(join(cacheDir, 'translation.json'), file)
}

function segmentPcmPath(cacheDir: string, id: number): string {
  return join(cacheDir, 'segments', `${id}.pcm`)
}

function segmentMetadataPath(cacheDir: string, id: number): string {
  return join(cacheDir, 'segments', `${id}.json`)
}

export function loadCachedSegment(
  cacheDir: string,
  taskId: string,
  id: number,
  configSignature: string,
  expectedTextHash: string
): CachedSegmentEntry | null {
  if (!existsSync(cacheDir) || !manifestMatchesTask(cacheDir, taskId)) return null

  const meta = safeReadJson<SegmentMetadataFile>(segmentMetadataPath(cacheDir, id))
  if (!meta || meta.version !== SEGMENT_CACHE_VERSION) return null
  if (meta.configSignature !== configSignature) return null
  if (meta.textHash !== expectedTextHash) return null
  if (typeof meta.durationUs !== 'number' || !Number.isFinite(meta.durationUs)) return null
  if (typeof meta.leadTrimUs !== 'number' || !Number.isFinite(meta.leadTrimUs)) return null
  if (typeof meta.spokenText !== 'string') return null
  if (!Array.isArray(meta.boundaries)) return null

  const pcmPath = segmentPcmPath(cacheDir, id)
  if (!existsSync(pcmPath)) return null

  let pcm: Buffer
  try {
    pcm = readFileSync(pcmPath)
  } catch {
    return null
  }

  const boundaries: AudioBoundary[] = []
  for (const entry of meta.boundaries) {
    if (!entry || typeof entry !== 'object') continue
    const { part, startUs, endUs } = entry as { part?: unknown; startUs?: unknown; endUs?: unknown }
    if (typeof part !== 'string') continue
    if (typeof startUs !== 'number' || !Number.isFinite(startUs)) continue
    if (typeof endUs !== 'number' || !Number.isFinite(endUs)) continue
    boundaries.push({ part, startUs, endUs })
  }

  return {
    audio: {
      pcm,
      durationUs: meta.durationUs,
      spokenText: meta.spokenText,
      boundaries,
      leadTrimUs: meta.leadTrimUs,
    },
    textHash: meta.textHash,
  }
}

export function saveCachedSegment(
  cacheDir: string,
  taskId: string,
  id: number,
  configSignature: string,
  textHash: string,
  audio: ProcessedAudio
): void {
  ensureCacheDir(cacheDir)
  writeCacheManifest(cacheDir, taskId)
  writeFileSync(segmentPcmPath(cacheDir, id), audio.pcm)
  const meta: SegmentMetadataFile = {
    version: SEGMENT_CACHE_VERSION,
    configSignature,
    textHash,
    durationUs: audio.durationUs,
    spokenText: audio.spokenText,
    leadTrimUs: audio.leadTrimUs,
    boundaries: audio.boundaries.map((boundary) => ({
      part: boundary.part,
      startUs: boundary.startUs,
      endUs: boundary.endUs,
    })),
  }
  safeWriteJson(segmentMetadataPath(cacheDir, id), meta)
}

export async function clearSegmentCache(cacheDir: string | null): Promise<void> {
  if (!cacheDir) return
  try {
    await rm(cacheDir, { recursive: true, force: true })
  } catch (err) {
    console.error(`Failed to clear segment cache at ${cacheDir}:`, err)
  }
}

export function clearSegmentCacheByPath(outputDir: string, videoPath: string): Promise<void> {
  return clearSegmentCache(resolveCacheDir(outputDir, videoPath))
}
