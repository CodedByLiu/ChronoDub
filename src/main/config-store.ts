import { app } from 'electron'
import { join, dirname } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import type { AppConfig } from '../types'
import { CONCURRENCY_OPTIONS, DEFAULT_CONFIG } from '../types'

let cachedConfig: AppConfig | null = null

function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function normalizeConfig(config: Partial<AppConfig> | null | undefined): AppConfig {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  const maxConcurrentTasks = CONCURRENCY_OPTIONS.includes(merged.maxConcurrentTasks)
    ? merged.maxConcurrentTasks
    : DEFAULT_CONFIG.maxConcurrentTasks

  return {
    ...merged,
    maxConcurrentTasks,
  }
}

function cloneConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    dictionary: config.dictionary.map((item) => ({ ...item })),
  }
}

function readConfigFromDiskSync(): AppConfig {
  try {
    const configPath = getConfigPath()
    if (!existsSync(configPath)) {
      return cloneConfig(DEFAULT_CONFIG)
    }
    const raw = readFileSync(configPath, 'utf-8')
    return cloneConfig(normalizeConfig(JSON.parse(raw)))
  } catch {
    return cloneConfig(DEFAULT_CONFIG)
  }
}

export function loadConfigSync(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = readConfigFromDiskSync()
  }
  return cloneConfig(cachedConfig)
}

export async function loadConfig(): Promise<AppConfig> {
  if (cachedConfig) return cloneConfig(cachedConfig)

  try {
    const raw = await readFile(getConfigPath(), 'utf-8')
    cachedConfig = normalizeConfig(JSON.parse(raw))
  } catch {
    cachedConfig = cloneConfig(DEFAULT_CONFIG)
  }

  return cloneConfig(cachedConfig)
}

export async function saveConfig(config: AppConfig): Promise<void> {
  try {
    const normalized = normalizeConfig(config)
    cachedConfig = cloneConfig(normalized)
    const configPath = getConfigPath()
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, JSON.stringify(normalized, null, 2), 'utf-8')
  } catch (err) {
    console.error('Failed to save config:', err)
  }
}
