import { create } from 'zustand'
import type { AppConfig, VideoTask, TaskStatus, Cue, ReviewMode } from '../types'
import { DEFAULT_CONFIG } from '../types'

interface TaskCueState {
  englishCues?: Cue[]
  chineseCues?: Cue[]
}

interface AppState {
  config: AppConfig
  tasks: VideoTask[]
  taskCues: Record<string, TaskCueState>
  sidebarOpen: boolean
  editingTaskId: string | null

  setConfig: (config: Partial<AppConfig>) => void
  loadConfig: (config: AppConfig) => void
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  setEditingTaskId: (id: string | null) => void

  setTasks: (tasks: VideoTask[]) => void
  addTasks: (tasks: VideoTask[]) => void
  removeTask: (id: string) => void
  clearTasks: () => void
  updateTaskStatus: (id: string, status: TaskStatus, progress?: number, detail?: string) => void
  updateTaskError: (id: string, error: string, errorDetail?: string) => void
  updateTaskSubtitlePath: (id: string, subtitlePath: string) => void
  replaceTaskSubtitlePath: (id: string, subtitlePath: string) => void
  updateTaskCues: (id: string, englishCues?: Cue[], chineseCues?: Cue[]) => void
  updateTaskCountdown: (id: string, remaining: number) => void
  updateTaskChineseCues: (id: string, cues: Cue[]) => void
}

function splitTaskCues(tasks: VideoTask[]): {
  tasks: VideoTask[]
  taskCues: Record<string, TaskCueState>
} {
  const taskCues: Record<string, TaskCueState> = {}
  const sanitizedTasks = tasks.map(({ englishCues, chineseCues, ...task }) => {
    if (englishCues !== undefined || chineseCues !== undefined) {
      taskCues[task.id] = {
        ...(englishCues !== undefined ? { englishCues } : {}),
        ...(chineseCues !== undefined ? { chineseCues } : {}),
      }
    }
    return task
  })

  return { tasks: sanitizedTasks, taskCues }
}

export const useAppStore = create<AppState>((set) => ({
  config: DEFAULT_CONFIG,
  tasks: [],
  taskCues: {},
  sidebarOpen: true,
  editingTaskId: null,

  setConfig: (partial) => set((state) => ({ config: { ...state.config, ...partial } })),

  loadConfig: (config) => set({ config }),

  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setEditingTaskId: (id) => set({ editingTaskId: id }),

  setTasks: (tasks) => {
    const next = splitTaskCues(tasks)
    set({ tasks: next.tasks, taskCues: next.taskCues })
  },

  addTasks: (tasks) => {
    const next = splitTaskCues(tasks)
    set((state) => ({
      tasks: [...state.tasks, ...next.tasks],
      taskCues: { ...state.taskCues, ...next.taskCues },
    }))
  },

  removeTask: (id) =>
    set((state) => {
      const taskCues = { ...state.taskCues }
      delete taskCues[id]
      return {
        tasks: state.tasks.filter((t) => t.id !== id),
        taskCues,
      }
    }),

  clearTasks: () => set({ tasks: [], taskCues: {} }),

  updateTaskStatus: (id, status, progress, detail) =>
    set((state) => {
      let changed = false
      const tasks = state.tasks.map((t) => {
        if (t.id !== id) return t
        const nextProgress = progress !== undefined ? progress : t.progress
        if (t.status === status && t.progress === nextProgress && t.detail === detail) return t
        changed = true
        const statusChanged = t.status !== status
        const detailChanged = t.detail !== detail
        return {
          ...t,
          status,
          ...(progress !== undefined ? { progress } : {}),
          ...(detail !== undefined ? { detail } : { detail: undefined }),
          ...(status !== 'error' ? { error: undefined, errorDetail: undefined } : {}),
          ...(statusChanged || detailChanged ? { statusUpdatedAt: Date.now() } : {}),
        }
      })
      return changed ? { tasks } : state
    }),

  updateTaskError: (id, error, errorDetail) =>
    set((state) => {
      let changed = false
      const tasks = state.tasks.map((t) => {
        if (t.id !== id) return t
        if (t.status === 'error' && t.error === error && t.errorDetail === errorDetail) return t
        changed = true
        return {
          ...t,
          status: 'error' as TaskStatus,
          error,
          errorDetail,
          detail: undefined,
          statusUpdatedAt: Date.now(),
        }
      })
      return changed ? { tasks } : state
    }),

  updateTaskSubtitlePath: (id, subtitlePath) =>
    set((state) => {
      let changed = false
      const tasks = state.tasks.map((t) => {
        if (t.id !== id) return t
        if (t.subtitlePath === subtitlePath) return t
        changed = true
        return { ...t, subtitlePath }
      })
      return changed ? { tasks } : state
    }),

  replaceTaskSubtitlePath: (id, subtitlePath) =>
    set((state) => {
      let changed = false
      const tasks = state.tasks.map((t) => {
        if (t.id !== id) return t
        if (
          t.subtitlePath === subtitlePath &&
          t.status === 'waiting' &&
          t.progress === 0 &&
          !t.error &&
          t.countdownRemaining === undefined
        ) {
          return t
        }
        changed = true
        return {
          ...t,
          subtitlePath,
          status: 'waiting' as TaskStatus,
          progress: 0,
          error: undefined,
          errorDetail: undefined,
          detail: undefined,
          statusUpdatedAt: Date.now(),
          countdownRemaining: undefined,
        }
      })

      if (!changed) return state

      const taskCues = { ...state.taskCues }
      delete taskCues[id]
      return { tasks, taskCues }
    }),

  updateTaskCues: (id, englishCues, chineseCues) =>
    set((state) => ({
      taskCues: {
        ...state.taskCues,
        [id]: {
          ...state.taskCues[id],
          ...(englishCues !== undefined ? { englishCues } : {}),
          ...(chineseCues !== undefined ? { chineseCues } : {}),
        },
      },
    })),

  updateTaskCountdown: (id, remaining) =>
    set((state) => {
      let changed = false
      const tasks = state.tasks.map((t) => {
        if (t.id !== id) return t
        if (t.countdownRemaining === remaining) return t
        changed = true
        return { ...t, countdownRemaining: remaining }
      })
      return changed ? { tasks } : state
    }),

  updateTaskChineseCues: (id, cues) =>
    set((state) => ({
      taskCues: {
        ...state.taskCues,
        [id]: {
          ...state.taskCues[id],
          chineseCues: cues,
        },
      },
    })),
}))
