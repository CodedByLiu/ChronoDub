import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  hashChineseSplitKey,
  loadChineseSplitCache,
  saveChineseSplitCache,
} from '../src/main/services/segment-cache'

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'chrono-cache-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('hashChineseSplitKey: identical inputs produce identical keys', () => {
  const a = hashChineseSplitKey('你好世界。', 1500)
  const b = hashChineseSplitKey('你好世界。', 1500)
  assert.equal(a, b)
})

test('hashChineseSplitKey: different duration produces different key', () => {
  const a = hashChineseSplitKey('你好世界。', 1500)
  const b = hashChineseSplitKey('你好世界。', 1600)
  assert.notEqual(a, b)
})

test('hashChineseSplitKey: different text produces different key', () => {
  const a = hashChineseSplitKey('你好世界。', 1500)
  const b = hashChineseSplitKey('你好。世界。', 1500)
  assert.notEqual(a, b)
})

test('saveChineseSplitCache + loadChineseSplitCache: roundtrip', () => {
  withTempDir((dir) => {
    const entries = new Map<string, string[]>([
      ['abc123', ['好的，', '我们开始吧。']],
      ['def456', ['今天天气真好。']],
    ])
    saveChineseSplitCache(dir, 'task-1', '2026-05-23-v1', entries)
    const loaded = loadChineseSplitCache(dir, 'task-1', '2026-05-23-v1')
    assert.equal(loaded.size, 2)
    assert.deepEqual(loaded.get('abc123'), ['好的，', '我们开始吧。'])
    assert.deepEqual(loaded.get('def456'), ['今天天气真好。'])
  })
})

test('loadChineseSplitCache: schemaVersion mismatch returns empty map', () => {
  withTempDir((dir) => {
    const entries = new Map<string, string[]>([['k', ['a。', 'b。']]])
    saveChineseSplitCache(dir, 'task-1', '2026-05-23-v1', entries)
    const loaded = loadChineseSplitCache(dir, 'task-1', '2026-05-23-v2')
    assert.equal(loaded.size, 0)
  })
})

test('loadChineseSplitCache: different taskId returns empty map', () => {
  withTempDir((dir) => {
    const entries = new Map<string, string[]>([['k', ['a。']]])
    saveChineseSplitCache(dir, 'task-1', '2026-05-23-v1', entries)
    const loaded = loadChineseSplitCache(dir, 'task-2', '2026-05-23-v1')
    assert.equal(loaded.size, 0)
  })
})

test('loadChineseSplitCache: missing cache directory returns empty map', () => {
  const loaded = loadChineseSplitCache(
    join(tmpdir(), 'definitely-does-not-exist-' + Date.now()),
    'task-1',
    '2026-05-23-v1'
  )
  assert.equal(loaded.size, 0)
})
