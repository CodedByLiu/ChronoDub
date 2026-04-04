import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { reserveOutputTarget } from '../src/main/services/output-path'

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'chronodub-output-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('reserveOutputTarget avoids flat output collisions for same basename videos', () => {
  withTempDir((dir) => {
    const first = reserveOutputTarget('C:\\videos\\lesson.mp4', dir, false)
    const second = reserveOutputTarget('D:\\other\\lesson.mp4', dir, false)

    try {
      assert.match(first.outputVideoPath, /lesson\.mp4$/)
      assert.match(second.outputVideoPath, /lesson \(2\)\.mp4$/)
      assert.match(second.outputSubtitlePath, /lesson \(2\)\.srt$/)
    } finally {
      second.release()
      first.release()
    }
  })
})
