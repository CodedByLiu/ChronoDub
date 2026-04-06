import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTaskSnapshotFile, sanitizeTaskSnapshot } from '../src/main/task-store-codec'
import type { VideoTask } from '../src/types'

function createTask(overrides: Partial<VideoTask> = {}): VideoTask {
  return {
    id: 'task-1',
    videoPath: 'C:\\videos\\lesson.mp4',
    videoName: 'lesson.mp4',
    subtitlePath: 'C:\\videos\\lesson.srt',
    status: 'waiting',
    progress: 0,
    ...overrides,
  }
}

test('sanitizeTaskSnapshot keeps persisted fields and translation issues', () => {
  const sanitized = sanitizeTaskSnapshot(
    createTask({
      status: 'error',
      progress: 0,
      error: 'translate failed',
      errorDetail: 'line 4 unchanged',
      detail: 'processing',
      countdownRemaining: 8,
      translationIssues: [{ id: 4, text: 'Please keep this in Chinese.' }],
      statusUpdatedAt: Date.now(),
      englishCues: [
        {
          id: 1,
          startUs: 0,
          endUs: 1_000_000,
          text: 'source',
        },
      ],
    })
  )

  assert.equal(sanitized.id, 'task-1')
  assert.equal(sanitized.error, 'translate failed')
  assert.equal(sanitized.errorDetail, 'line 4 unchanged')
  assert.equal(sanitized.countdownRemaining, 8)
  assert.equal(sanitized.translationIssues?.length, 1)
  assert.equal(sanitized.translationIssues?.[0]?.id, 4)
  assert.equal((sanitized as unknown as { statusUpdatedAt?: number }).statusUpdatedAt, undefined)
  assert.equal((sanitized as unknown as { englishCues?: unknown[] }).englishCues, undefined)
})

test('sanitizeTaskSnapshot drops empty translation issues', () => {
  const sanitized = sanitizeTaskSnapshot(
    createTask({
      translationIssues: [],
    })
  )

  assert.equal(sanitized.translationIssues, undefined)
})

test('parseTaskSnapshotFile returns [] for incompatible payload', () => {
  const parsed = parseTaskSnapshotFile(
    JSON.stringify({
      version: 2,
      tasks: [createTask()],
    })
  )

  assert.deepEqual(parsed, [])
})

test('parseTaskSnapshotFile sanitizes loaded tasks', () => {
  const parsed = parseTaskSnapshotFile(
    JSON.stringify({
      version: 1,
      tasks: [
        {
          ...createTask({
            status: 'paused',
            progress: 56,
            translationIssues: [{ id: 7, text: 'left in english' }],
          }),
          statusUpdatedAt: Date.now(),
          englishCues: [
            {
              id: 7,
              startUs: 0,
              endUs: 1_000_000,
              text: 'source',
            },
          ],
        },
      ],
    })
  )

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].status, 'paused')
  assert.equal(parsed[0].progress, 56)
  assert.equal(parsed[0].translationIssues?.[0]?.id, 7)
  assert.equal((parsed[0] as unknown as { statusUpdatedAt?: number }).statusUpdatedAt, undefined)
  assert.equal((parsed[0] as unknown as { englishCues?: unknown[] }).englishCues, undefined)
})

test('parseTaskSnapshotFile skips malformed task entries but keeps valid ones', () => {
  const parsed = parseTaskSnapshotFile(
    JSON.stringify({
      version: 1,
      tasks: [
        createTask({ id: 'ok-1', status: 'waiting', progress: 0 }),
        { id: 'bad-1', status: 'waiting', progress: 0 },
        createTask({ id: 'ok-2', status: 'paused', progress: 50, subtitlePath: null }),
        'not-an-object',
      ],
    })
  )

  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].id, 'ok-1')
  assert.equal(parsed[1].id, 'ok-2')
})
