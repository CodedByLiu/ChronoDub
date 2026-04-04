import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskScheduler, type ScheduledTaskEntry } from '../src/main/services/task-scheduler'

test('TaskScheduler respects concurrency limit and starts queued tasks in order', () => {
  let activeCount = 0
  const started: string[] = []
  const queued: Array<{ taskId: string; progress: number }> = []

  const scheduler = new TaskScheduler({
    getRunnableActiveCount: () => activeCount,
    resumeTaskNow: () => false,
    runTask: (task) => {
      started.push(task.taskId)
      activeCount += 1
    },
    reportQueued: (taskId, progress) => queued.push({ taskId, progress }),
  })

  scheduler.setLimit(2)
  scheduler.enqueueTask({ taskId: 'a', videoPath: 'a.mp4', subtitlePath: 'a.srt' })
  scheduler.enqueueTask({ taskId: 'b', videoPath: 'b.mp4', subtitlePath: 'b.srt' })
  scheduler.enqueueTask({ taskId: 'c', videoPath: 'c.mp4', subtitlePath: 'c.srt' })

  assert.deepEqual(started, ['a', 'b'])
  assert.deepEqual(
    queued.map((item) => item.taskId),
    ['a', 'b', 'c']
  )

  activeCount -= 1
  scheduler.process()

  assert.deepEqual(started, ['a', 'b', 'c'])
})

test('TaskScheduler prioritizes queued resumes before new tasks', () => {
  const resumed: string[] = []
  const started: string[] = []

  const scheduler = new TaskScheduler({
    getRunnableActiveCount: () => 0,
    resumeTaskNow: (taskId) => {
      resumed.push(taskId)
      return true
    },
    runTask: (task) => started.push(task.taskId),
    reportQueued: () => {},
  })

  scheduler.setLimit(1)
  scheduler.enqueueTask({ taskId: 'fresh', videoPath: 'fresh.mp4', subtitlePath: 'fresh.srt' })
  scheduler.enqueueResume('paused-task', 42)

  assert.deepEqual(resumed, ['paused-task'])
  assert.deepEqual(started, ['fresh'])
})

test('TaskScheduler can remove queued tasks and queued resumes', () => {
  let activeCount = 1
  const scheduler = new TaskScheduler({
    getRunnableActiveCount: () => activeCount,
    resumeTaskNow: () => false,
    runTask: () => {},
    reportQueued: () => {},
  })

  scheduler.setLimit(1)

  const task: ScheduledTaskEntry = { taskId: 'queued', videoPath: 'q.mp4', subtitlePath: 'q.srt' }
  scheduler.enqueueTask(task)
  scheduler.enqueueResume('resume-me', 12)

  assert.equal(scheduler.removeQueuedTask('queued'), true)
  assert.equal(scheduler.removeQueuedResume('resume-me'), true)
  assert.equal(scheduler.removeQueuedTask('missing'), false)
  assert.equal(scheduler.removeQueuedResume('missing'), false)

  activeCount = 0
  scheduler.process()
})
