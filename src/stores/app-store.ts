import { create } from 'zustand'
import type { AppConfig, VideoTask, TaskStatus, Cue, ReviewMode } from '../types'
import { DEFAULT_CONFIG } from '../types'

interface AppState {
  config: AppConfig
  tasks: VideoTask[]
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
  updateTaskStatus: (id: string, status: TaskStatus, progress?: number) => void
  updateTaskError: (id: string, error: string) => void
  updateTaskSubtitlePath: (id: string, subtitlePath: string) => void
  updateTaskCues: (id: string, englishCues?: Cue[], chineseCues?: Cue[]) => void
  updateTaskCountdown: (id: string, remaining: number) => void
  updateTaskChineseCues: (id: string, cues: Cue[]) => void
}

export const useAppStore = create<AppState>((set) => ({
  config: DEFAULT_CONFIG,
  tasks: [],
  sidebarOpen: true,
  editingTaskId: null,

  setConfig: (partial) => set((state) => ({ config: { ...state.config, ...partial } })),

  loadConfig: (config) => set({ config }),

  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setEditingTaskId: (id) => set({ editingTaskId: id }),

  setTasks: (tasks) => set({ tasks }),

  addTasks: (tasks) => set((state) => ({ tasks: [...state.tasks, ...tasks] })),

  removeTask: (id) => set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) })),

  clearTasks: () => set({ tasks: [] }),

  updateTaskStatus: (id, status, progress) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, status, ...(progress !== undefined ? { progress } : {}) } : t
      ),
    })),

  updateTaskError: (id, error) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, status: 'error' as TaskStatus, error } : t
      ),
    })),

  updateTaskSubtitlePath: (id, subtitlePath) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, subtitlePath } : t)),
    })),

  updateTaskCues: (id, englishCues, chineseCues) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              ...(englishCues !== undefined ? { englishCues } : {}),
              ...(chineseCues !== undefined ? { chineseCues } : {}),
            }
          : t
      ),
    })),

  updateTaskCountdown: (id, remaining) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, countdownRemaining: remaining } : t)),
    })),

  updateTaskChineseCues: (id, cues) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, chineseCues: cues } : t)),
    })),
}))
