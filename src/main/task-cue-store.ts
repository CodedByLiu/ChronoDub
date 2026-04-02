import { app } from 'electron'
import { existsSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import type { Cue } from '../types'

interface TaskCueFile {
  version: 1
  englishCues?: Cue[]
  chineseCues?: Cue[]
}

const cueCache = new Map<string, { englishCues?: Cue[]; chineseCues?: Cue[] } | null>()
const cueWriteChains = new Map<string, Promise<void>>()

function getTaskCueDir(): string {
  return join(app.getPath('userData'), 'task-cues')
}

function getTaskCuePath(taskId: string): string {
  return join(getTaskCueDir(), `${taskId}.json`)
}

function cloneCue(cue: Cue): Cue {
  return {
    id: cue.id,
    startUs: cue.startUs,
    endUs: cue.endUs,
    text: cue.text,
    ...(cue.rawStyle !== undefined ? { rawStyle: cue.rawStyle } : {}),
  }
}

function cloneCueSet(data: { englishCues?: Cue[]; chineseCues?: Cue[] } | null) {
  if (!data) return null
  return {
    ...(data.englishCues ? { englishCues: data.englishCues.map(cloneCue) } : {}),
    ...(data.chineseCues ? { chineseCues: data.chineseCues.map(cloneCue) } : {}),
  }
}

export async function loadTaskCues(
  taskId: string
): Promise<{ englishCues?: Cue[]; chineseCues?: Cue[] } | null> {
  if (cueCache.has(taskId)) {
    return cloneCueSet(cueCache.get(taskId) ?? null)
  }

  try {
    const filePath = getTaskCuePath(taskId)
    if (!existsSync(filePath)) {
      cueCache.set(taskId, null)
      return null
    }
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as TaskCueFile
    if (!parsed || parsed.version !== 1) {
      cueCache.set(taskId, null)
      return null
    }

    const loaded = {
      ...(parsed.englishCues ? { englishCues: parsed.englishCues.map(cloneCue) } : {}),
      ...(parsed.chineseCues ? { chineseCues: parsed.chineseCues.map(cloneCue) } : {}),
    }
    cueCache.set(taskId, loaded)
    return cloneCueSet(loaded)
  } catch {
    cueCache.set(taskId, null)
    return null
  }
}

export async function saveTaskCues(
  taskId: string,
  data: { englishCues?: Cue[]; chineseCues?: Cue[] }
): Promise<void> {
  const nextWrite = (cueWriteChains.get(taskId) ?? Promise.resolve())
    .catch(() => {
      /* continue chained writes after a previous failure */
    })
    .then(async () => {
      try {
        const current = cueCache.has(taskId) ? cueCache.get(taskId) ?? null : await loadTaskCues(taskId)
        const merged = {
          ...(current?.englishCues ? { englishCues: current.englishCues.map(cloneCue) } : {}),
          ...(current?.chineseCues ? { chineseCues: current.chineseCues.map(cloneCue) } : {}),
          ...(data.englishCues !== undefined ? { englishCues: data.englishCues.map(cloneCue) } : {}),
          ...(data.chineseCues !== undefined ? { chineseCues: data.chineseCues.map(cloneCue) } : {}),
        }

        cueCache.set(taskId, merged)
        await mkdir(getTaskCueDir(), { recursive: true })
        const payload: TaskCueFile = {
          version: 1,
          ...(merged.englishCues ? { englishCues: merged.englishCues } : {}),
          ...(merged.chineseCues ? { chineseCues: merged.chineseCues } : {}),
        }
        await writeFile(getTaskCuePath(taskId), JSON.stringify(payload, null, 2), 'utf-8')
      } catch (err) {
        console.error(`Failed to save task cues [${taskId}]:`, err)
      }
    })

  cueWriteChains.set(taskId, nextWrite)
  await nextWrite
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
