import { app } from 'electron'
import { existsSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Cue } from '../types'
import {
  cloneCue,
  cloneTaskCueSnapshot,
  cuesFromTaskCueSnapshot,
  deserializeTaskTranslationCache,
  hasTaskCueContent,
  parseTaskCueFile,
  serializeTaskTranslationCache,
  toTaskCueFileV2,
  type SerializedTranslationCache,
  type TaskCueSnapshot,
} from './task-cue-codec'

export interface TaskTranslationCache {
  configSignature: string
  segmentTranslations: Map<number, string>
}

const cueCache = new Map<string, TaskCueSnapshot | null>()
const cueWriteChains = new Map<string, Promise<void>>()

function getTaskCueDir(): string {
  return join(app.getPath('userData'), 'task-cues')
}

function getTaskCuePath(taskId: string): string {
  return join(getTaskCueDir(), `${taskId}.json`)
}

async function loadTaskCueSnapshot(taskId: string): Promise<TaskCueSnapshot | null> {
  if (cueCache.has(taskId)) return cloneTaskCueSnapshot(cueCache.get(taskId) ?? null)

  try {
    const filePath = getTaskCuePath(taskId)
    if (!existsSync(filePath)) {
      cueCache.set(taskId, null)
      return null
    }
    const raw = await readFile(filePath, 'utf-8')
    const loaded = parseTaskCueFile(JSON.parse(raw))
    cueCache.set(taskId, loaded)
    return cloneTaskCueSnapshot(loaded)
  } catch {
    cueCache.set(taskId, null)
    return null
  }
}

interface TaskCueSaveUpdate {
  englishCues?: Cue[]
  chineseCues?: Cue[]
  translationCache?: SerializedTranslationCache | null
}

async function persistTaskCueSnapshot(taskId: string, data: TaskCueSaveUpdate): Promise<void> {
  const nextWrite = (cueWriteChains.get(taskId) ?? Promise.resolve())
    .catch(() => {
      /* continue chained writes after a previous failure */
    })
    .then(async () => {
      try {
        const current = cueCache.has(taskId)
          ? cloneTaskCueSnapshot(cueCache.get(taskId) ?? null)
          : await loadTaskCueSnapshot(taskId)

        const merged: TaskCueSnapshot = {
          ...(current?.englishCues ? { englishCues: current.englishCues.map(cloneCue) } : {}),
          ...(current?.chineseCues ? { chineseCues: current.chineseCues.map(cloneCue) } : {}),
          ...(current?.translationCache ? { translationCache: current.translationCache } : {}),
          ...(data.englishCues !== undefined ? { englishCues: data.englishCues.map(cloneCue) } : {}),
          ...(data.chineseCues !== undefined ? { chineseCues: data.chineseCues.map(cloneCue) } : {}),
          ...(data.translationCache !== undefined
            ? data.translationCache === null
              ? { translationCache: undefined }
              : { translationCache: data.translationCache }
            : {}),
        }

        if (!hasTaskCueContent(merged)) {
          cueCache.set(taskId, null)
          await rm(getTaskCuePath(taskId), { force: true })
          return
        }

        cueCache.set(taskId, merged)
        await mkdir(getTaskCueDir(), { recursive: true })
        const payload = toTaskCueFileV2(merged)
        await writeFile(getTaskCuePath(taskId), JSON.stringify(payload, null, 2), 'utf-8')
      } catch (err) {
        console.error(`Failed to save task cues [${taskId}]:`, err)
      }
    })

  cueWriteChains.set(taskId, nextWrite)
  await nextWrite
}

export async function loadTaskCues(
  taskId: string
): Promise<{ englishCues?: Cue[]; chineseCues?: Cue[] } | null> {
  const loaded = await loadTaskCueSnapshot(taskId)
  return cuesFromTaskCueSnapshot(loaded)
}

export async function saveTaskCues(
  taskId: string,
  data: { englishCues?: Cue[]; chineseCues?: Cue[] }
): Promise<void> {
  await persistTaskCueSnapshot(taskId, data)
}

export async function loadTaskTranslationCache(taskId: string): Promise<TaskTranslationCache | null> {
  const loaded = await loadTaskCueSnapshot(taskId)
  return deserializeTaskTranslationCache(loaded?.translationCache)
}

export async function saveTaskTranslationCache(
  taskId: string,
  cache: TaskTranslationCache | null
): Promise<void> {
  if (!cache) {
    await persistTaskCueSnapshot(taskId, { translationCache: null })
    return
  }

  await persistTaskCueSnapshot(taskId, {
    translationCache: serializeTaskTranslationCache(cache),
  })
}

export async function deleteTaskCues(taskId: string): Promise<void> {
  try {
    await (cueWriteChains.get(taskId) ?? Promise.resolve()).catch(() => {
      /* noop */
    })
    cueCache.delete(taskId)
    cueWriteChains.delete(taskId)
    await rm(getTaskCuePath(taskId), { force: true })
  } catch (err) {
    console.error(`Failed to delete task cues [${taskId}]:`, err)
  }
}
