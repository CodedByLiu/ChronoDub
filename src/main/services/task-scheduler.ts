export interface ScheduledTaskEntry {
  taskId: string
  videoPath: string
  subtitlePath: string
}

interface TaskSchedulerCallbacks {
  getRunnableActiveCount: () => number
  resumeTaskNow: (taskId: string) => boolean
  runTask: (task: ScheduledTaskEntry) => void
  reportQueued: (taskId: string, progress: number) => void
}

export class TaskScheduler {
  private limit = 2
  private readonly pendingTasks: ScheduledTaskEntry[] = []
  private readonly queuedTaskIds = new Set<string>()
  private readonly pendingResumeTaskIds: string[] = []
  private readonly queuedResumeTaskIds = new Set<string>()

  constructor(private readonly callbacks: TaskSchedulerCallbacks) {}

  setLimit(limit: number): void {
    this.limit = Math.max(1, limit)
    this.process()
  }

  hasQueuedTask(taskId: string): boolean {
    return this.queuedTaskIds.has(taskId)
  }

  listQueuedTaskIds(): string[] {
    return this.pendingTasks.map((task) => task.taskId)
  }

  listQueuedResumeTaskIds(): string[] {
    return [...this.pendingResumeTaskIds]
  }

  enqueueTask(task: ScheduledTaskEntry, front = false): boolean {
    if (this.queuedTaskIds.has(task.taskId)) return false

    if (front) this.pendingTasks.unshift(task)
    else this.pendingTasks.push(task)

    this.queuedTaskIds.add(task.taskId)
    this.callbacks.reportQueued(task.taskId, 0)
    this.process()
    return true
  }

  enqueueResume(taskId: string, progress: number): boolean {
    if (this.queuedResumeTaskIds.has(taskId)) return false
    this.pendingResumeTaskIds.push(taskId)
    this.queuedResumeTaskIds.add(taskId)
    this.callbacks.reportQueued(taskId, progress)
    this.process()
    return true
  }

  removeQueuedTask(taskId: string): boolean {
    const index = this.pendingTasks.findIndex((task) => task.taskId === taskId)
    if (index < 0) return false
    this.pendingTasks.splice(index, 1)
    this.queuedTaskIds.delete(taskId)
    return true
  }

  removeQueuedResume(taskId: string): boolean {
    const index = this.pendingResumeTaskIds.findIndex((id) => id === taskId)
    if (index < 0) return false
    this.pendingResumeTaskIds.splice(index, 1)
    this.queuedResumeTaskIds.delete(taskId)
    return true
  }

  process(): void {
    while (this.callbacks.getRunnableActiveCount() < this.limit) {
      const nextResumeTaskId = this.pendingResumeTaskIds.shift()
      if (nextResumeTaskId) {
        this.queuedResumeTaskIds.delete(nextResumeTaskId)
        if (this.callbacks.resumeTaskNow(nextResumeTaskId)) continue
      }

      const nextTask = this.pendingTasks.shift()
      if (!nextTask) return
      this.queuedTaskIds.delete(nextTask.taskId)
      this.callbacks.runTask(nextTask)
    }
  }
}
