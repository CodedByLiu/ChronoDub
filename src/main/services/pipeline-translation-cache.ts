import type { AppConfig } from '../../types'
import { sendToRenderer } from './pipeline-progress'
import { TRANSLATION_STRATEGY_VERSION, type TranslationIssueItem } from './deepseek'
import {
  taskSegmentTranslationCache,
  taskTranslationIssues,
  type TaskTranslationCacheEntry,
} from './pipeline-store'
import { updateTaskTranslationIssuesSnapshot } from '../task-registry'
import {
  clearSegmentCacheByPath,
  loadTranslationCache,
  resolveCacheDir,
  saveTranslationCache,
} from './segment-cache'

function cloneTranslationIssues(issues: TranslationIssueItem[]): TranslationIssueItem[] {
  return issues.map((item) => ({
    id: item.id,
    text: item.text,
    ...(typeof item.max_chars === 'number' ? { max_chars: item.max_chars } : {}),
  }))
}

function reportTaskTranslationIssues(taskId: string, issues: TranslationIssueItem[]): void {
  sendToRenderer('task:translation-issues', taskId, cloneTranslationIssues(issues))
}

export function setTaskTranslationIssues(taskId: string, issues: TranslationIssueItem[]): void {
  if (issues.length === 0) {
    taskTranslationIssues.delete(taskId)
    updateTaskTranslationIssuesSnapshot(taskId, [])
    reportTaskTranslationIssues(taskId, [])
    return
  }

  const normalized = cloneTranslationIssues(issues)
  taskTranslationIssues.set(taskId, normalized)
  updateTaskTranslationIssuesSnapshot(taskId, normalized)
  reportTaskTranslationIssues(taskId, normalized)
}

function clearTaskTranslationIssues(taskId: string): void {
  setTaskTranslationIssues(taskId, [])
}

export function buildTranslationConfigSignature(
  config: AppConfig,
  groupingSignature?: string
): string {
  const dictionary = config.dictionary
    .map((item) => ({
      en: item.en.trim(),
      zh: item.zh.trim(),
    }))
    .filter((item) => item.en.length > 0)

  return JSON.stringify({
    strategyVersion: TRANSLATION_STRATEGY_VERSION,
    dictionary,
    selectedVoice: config.selectedVoice.trim(),
    grouping: groupingSignature ?? 'naive',
  })
}

export function getTaskSegmentTranslations(taskId: string, configSignature: string): Map<number, string> {
  const cached = taskSegmentTranslationCache.get(taskId)
  if (!cached) return new Map()
  if (cached.configSignature !== configSignature) {
    taskSegmentTranslationCache.delete(taskId)
    return new Map()
  }

  return new Map(cached.translations)
}

export function setTaskSegmentTranslations(
  taskId: string,
  configSignature: string,
  translations: Map<number, string>,
  outputDir: string,
  videoPath: string
): void {
  const cacheEntry: TaskTranslationCacheEntry = {
    configSignature,
    translations: new Map(translations),
  }
  taskSegmentTranslationCache.set(taskId, cacheEntry)

  const cacheDir = resolveCacheDir(outputDir, videoPath)
  if (!cacheDir) return
  try {
    saveTranslationCache(cacheDir, taskId, configSignature, cacheEntry.translations)
  } catch (err) {
    console.error(`Failed to persist translation cache [${taskId}]:`, err)
  }
}

export function clearTaskTranslationRuntime(taskId: string): void {
  taskSegmentTranslationCache.delete(taskId)
  clearTaskTranslationIssues(taskId)
}

export function clearTaskSegmentCacheOnDisk(outputDir: string, videoPath: string): void {
  if (!outputDir?.trim() || !videoPath?.trim()) return
  void clearSegmentCacheByPath(outputDir, videoPath)
}

export function hydrateTaskTranslationCache(
  taskId: string,
  outputDir: string,
  videoPath: string
): void {
  if (taskSegmentTranslationCache.has(taskId)) return

  const cacheDir = resolveCacheDir(outputDir, videoPath)
  if (!cacheDir) return

  const persisted = loadTranslationCache(cacheDir, taskId)
  if (!persisted) return

  taskSegmentTranslationCache.set(taskId, {
    configSignature: persisted.configSignature,
    translations: new Map(persisted.segmentTranslations),
  })
}
