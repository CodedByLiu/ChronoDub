import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcApi } from '../types'

const api: IpcApi = {
  openSubtitlePicker: (defaultDir) =>
    ipcRenderer.invoke('dialog:open-subtitle', defaultDir ?? undefined),
  filePathFromDragFile: (file) => webUtils.getPathForFile(file),
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (config) => ipcRenderer.invoke('config:save', config),
  },
  deepseek: {
    testKey: (apiKey) => ipcRenderer.invoke('deepseek:test-key', apiKey),
  },
  dialog: {
    openVideos: () => ipcRenderer.invoke('dialog:open-videos'),
    openOutput: () => ipcRenderer.invoke('dialog:open-output'),
    openSubtitle: (defaultDir) =>
      ipcRenderer.invoke('dialog:open-subtitle', defaultDir ?? undefined),
  },
  tts: {
    getVoices: () => ipcRenderer.invoke('tts:get-voices'),
    testVoice: (voice) => ipcRenderer.invoke('tts:test-voice', voice),
  },
  subtitle: {
    parse: (filePath) => ipcRenderer.invoke('subtitle:parse', filePath),
    save: (filePath, cues) => ipcRenderer.invoke('subtitle:save', filePath, cues),
    detect: (videoPath) => ipcRenderer.invoke('subtitle:detect', videoPath),
    pathFromFile: (file) => webUtils.getPathForFile(file),
  },
  task: {
    loadSnapshot: () => ipcRenderer.invoke('task:load-snapshot'),
    loadCues: (taskId) => ipcRenderer.invoke('task:load-cues', taskId),
    register: (tasks) => ipcRenderer.send('task:register', tasks),
    updateSubtitlePath: (taskId, subtitlePath) =>
      ipcRenderer.send('task:update-subtitle-path', taskId, subtitlePath),
    replaceSubtitlePath: (taskId, subtitlePath) =>
      ipcRenderer.send('task:replace-subtitle-path', taskId, subtitlePath),
    start: (tasks) => ipcRenderer.send('task:start', tasks),
    pauseAll: () => ipcRenderer.send('task:pause-all'),
    resumeAll: (taskIds) => ipcRenderer.send('task:resume-all', taskIds),
    pause: (taskId) => ipcRenderer.send('task:pause', taskId),
    resume: (taskId) => ipcRenderer.send('task:resume', taskId),
    cancel: (taskId) => ipcRenderer.send('task:cancel', taskId),
    cancelAll: (taskIds) => ipcRenderer.send('task:cancel-all', taskIds),
    saveReview: (taskId, cues) => ipcRenderer.send('task:save-review', taskId, cues),
    confirmReview: (taskId, cues) => ipcRenderer.send('task:confirm-review', taskId, cues),
    onProgress: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        taskId: string,
        status: string,
        progress: number,
        detail?: string
      ) => callback(taskId, status as any, progress, detail)
      ipcRenderer.on('task:progress', handler)
      return () => ipcRenderer.removeListener('task:progress', handler)
    },
    onReviewCountdown: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, taskId: string, remaining: number) =>
        callback(taskId, remaining)
      ipcRenderer.on('task:review-countdown', handler)
      return () => ipcRenderer.removeListener('task:review-countdown', handler)
    },
    onReviewReady: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        taskId: string,
        englishCues: any[],
        chineseCues: any[]
      ) => callback(taskId, englishCues, chineseCues)
      ipcRenderer.on('task:review-ready', handler)
      return () => ipcRenderer.removeListener('task:review-ready', handler)
    },
    onError: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, taskId: string, message: string) =>
        callback(taskId, message)
      ipcRenderer.on('task:error', handler)
      return () => ipcRenderer.removeListener('task:error', handler)
    },
  },
}

contextBridge.exposeInMainWorld('api', api)
