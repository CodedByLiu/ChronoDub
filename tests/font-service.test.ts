import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeFontEntries } from '../src/main/services/font-service'

test('normalizeFontEntries splits alias chains and deduplicates results', () => {
  const fonts = normalizeFontEntries([
    'Microsoft YaHei & Microsoft YaHei UI (TrueType)',
    '微软雅黑 (TrueType)',
    'Microsoft YaHei',
  ])

  assert.equal(fonts.length, 3)
  assert.ok(fonts.includes('Microsoft YaHei'))
  assert.ok(fonts.includes('Microsoft YaHei UI'))
  assert.ok(fonts.includes('微软雅黑'))
})
