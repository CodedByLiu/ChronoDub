import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CONFIG, type AppConfig } from '../src/types'
import { setRuntimeConfig } from '../src/main/runtime-config-store'
import { resolveQueuedTaskConfig } from '../src/main/services/pipeline-scheduler'

function cloneConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    dictionary: config.dictionary.map((item) => ({ ...item })),
    subtitleStyle: { ...config.subtitleStyle },
  }
}

test('resolveQueuedTaskConfig prefers queued config snapshot over runtime config', () => {
  const runtimeConfig: AppConfig = cloneConfig({
    ...DEFAULT_CONFIG,
    dictionary: [{ en: 'runtime', zh: '运行时' }],
  })
  setRuntimeConfig(runtimeConfig)

  const queuedConfig: AppConfig = cloneConfig({
    ...DEFAULT_CONFIG,
    dictionary: [{ en: 'queued', zh: '排队快照' }],
  })
  const resolved = resolveQueuedTaskConfig({
    taskId: 'task-1',
    videoPath: 'a.mp4',
    subtitlePath: 'a.srt',
    configSnapshot: queuedConfig,
  })

  assert.deepEqual(resolved.dictionary, [{ en: 'queued', zh: '排队快照' }])

  resolved.dictionary.push({ en: 'mutated', zh: '已改' })
  assert.deepEqual(queuedConfig.dictionary, [{ en: 'queued', zh: '排队快照' }])
})

test('resolveQueuedTaskConfig falls back to runtime config when snapshot is absent', () => {
  const runtimeConfig: AppConfig = cloneConfig({
    ...DEFAULT_CONFIG,
    dictionary: [{ en: 'runtime2', zh: '运行时二' }],
  })
  setRuntimeConfig(runtimeConfig)

  const resolved = resolveQueuedTaskConfig({
    taskId: 'task-2',
    videoPath: 'b.mp4',
    subtitlePath: 'b.srt',
  })

  assert.deepEqual(resolved.dictionary, [{ en: 'runtime2', zh: '运行时二' }])
})
