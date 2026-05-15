import type { Cue } from '../types'

export interface TaskCueFileV1 {
  version: 1
  englishCues?: Cue[]
  chineseCues?: Cue[]
}

export interface TaskCueFileV2 {
  version: 2
  englishCues?: Cue[]
  chineseCues?: Cue[]
}

export type TaskCueFile = TaskCueFileV1 | TaskCueFileV2

export interface TaskCueSnapshot {
  englishCues?: Cue[]
  chineseCues?: Cue[]
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

export function cloneTaskCueSnapshot(data: TaskCueSnapshot | null): TaskCueSnapshot | null {
  if (!data) return null
  return {
    ...(data.englishCues ? { englishCues: data.englishCues.map(cloneCue) } : {}),
    ...(data.chineseCues ? { chineseCues: data.chineseCues.map(cloneCue) } : {}),
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

export function parseTaskCueFile(parsed: unknown): TaskCueSnapshot | null {
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as TaskCueFile
  if (record.version !== 1 && record.version !== 2) return null

  return {
    ...(Array.isArray(record.englishCues) ? { englishCues: record.englishCues.map(cloneCue) } : {}),
    ...(Array.isArray(record.chineseCues) ? { chineseCues: record.chineseCues.map(cloneCue) } : {}),
  }
}

export function hasTaskCueContent(snapshot: TaskCueSnapshot): boolean {
  return snapshot.englishCues !== undefined || snapshot.chineseCues !== undefined
}

export function toTaskCueFileV2(snapshot: TaskCueSnapshot): TaskCueFileV2 {
  return {
    version: 2,
    ...(snapshot.englishCues ? { englishCues: snapshot.englishCues.map(cloneCue) } : {}),
    ...(snapshot.chineseCues ? { chineseCues: snapshot.chineseCues.map(cloneCue) } : {}),
  }
}
