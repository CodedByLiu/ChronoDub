import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { AppConfig } from '../types'
import { DEFAULT_CONFIG } from '../types'

function getConfigPath(): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, 'config.json')
}

export function loadConfig(): AppConfig {
  try {
    const configPath = getConfigPath()
    if (!existsSync(configPath)) {
      return { ...DEFAULT_CONFIG }
    }
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: AppConfig): void {
  try {
    const configPath = getConfigPath()
    const dir = join(configPath, '..')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('Failed to save config:', err)
  }
}
