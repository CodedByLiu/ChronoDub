import type { AppConfig } from '../types'
import { DEFAULT_CONFIG } from '../types'

let runtimeConfig: AppConfig = {
  ...DEFAULT_CONFIG,
  llm: { ...DEFAULT_CONFIG.llm },
  dictionary: DEFAULT_CONFIG.dictionary.map((item) => ({ ...item })),
  subtitleStyle: { ...DEFAULT_CONFIG.subtitleStyle },
}

function cloneConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    llm: { ...config.llm },
    dictionary: config.dictionary.map((item) => ({ ...item })),
    subtitleStyle: { ...config.subtitleStyle },
  }
}

export function setRuntimeConfig(config: AppConfig): void {
  runtimeConfig = cloneConfig(config)
}

export function getRuntimeConfig(): AppConfig {
  return cloneConfig(runtimeConfig)
}
