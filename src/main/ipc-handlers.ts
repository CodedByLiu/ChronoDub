import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { loadConfig, saveConfig } from './config-store'
import { parseSubtitleFile, saveSubtitleFile } from './services/subtitle-parser'
import { detectSubtitleForVideo } from './services/subtitle-detect'
import { getChineseVoices, synthesizeToBuffer } from './services/edge-tts'
import { loadTaskSnapshots, normalizeInterruptedTasks, saveTaskSnapshots } from './task-store'
import {
  startTasks,
  pauseTask,
  resumeTask,
  cancelTask,
  cancelAllTasks,
  saveReviewCues,
  confirmReview,
} from './services/pipeline'
import type { AppConfig, Cue, TaskStartInfo, VideoTask } from '../types'

const INVOKE_CHANNELS = [
  'config:load',
  'config:save',
  'dialog:open-videos',
  'dialog:open-output',
  'dialog:open-subtitle',
  'subtitle:detect',
  'tts:get-voices',
  'tts:test-voice',
  'subtitle:parse',
  'subtitle:save',
  'task:load-snapshot',
  'task:save-snapshot',
] as const

function removeInvokeHandlers(): void {
  for (const ch of INVOKE_CHANNELS) {
    try {
      ipcMain.removeHandler(ch)
    } catch {
      /* noop */
    }
  }
}

export function registerIpcHandlers(): void {
  removeInvokeHandlers()

  ipcMain.handle('config:load', async () => {
    return loadConfig()
  })

  ipcMain.handle('config:save', async (_event, config: AppConfig) => {
    saveConfig(config)
  })

  ipcMain.handle('dialog:open-videos', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv'] }],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:open-output', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:open-subtitle', async (_event, defaultDir?: string) => {
    const result = await dialog.showOpenDialog({
      ...(defaultDir && existsSync(defaultDir) ? { defaultPath: defaultDir } : {}),
      properties: ['openFile'],
      filters: [{ name: '字幕文件', extensions: ['srt', 'vtt', 'ass'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('subtitle:detect', async (_event, videoPath: string) => {
    return detectSubtitleForVideo(videoPath)
  })

  ipcMain.handle('tts:get-voices', async () => {
    try {
      return await getChineseVoices()
    } catch (err) {
      console.error('获取语音列表失败:', err)
      return []
    }
  })

  ipcMain.handle('tts:test-voice', async (_event, voice: string) => {
    try {
      const testText = '你好，这是一段语音测试。'
      return await synthesizeToBuffer(testText, voice)
    } catch (err) {
      console.error('语音测试失败:', err)
      return new ArrayBuffer(0)
    }
  })

  ipcMain.handle('subtitle:parse', async (_event, filePath: string) => {
    try {
      return parseSubtitleFile(filePath)
    } catch (err) {
      console.error('字幕解析失败:', err)
      return []
    }
  })

  ipcMain.handle('subtitle:save', async (_event, filePath: string, cues: Cue[]) => {
    saveSubtitleFile(filePath, cues)
  })

  ipcMain.handle('task:load-snapshot', async () => {
    const tasks = loadTaskSnapshots()
    const normalized = normalizeInterruptedTasks(tasks)
    if (normalized.length !== tasks.length) {
      saveTaskSnapshots(normalized)
      return normalized
    }
    const statusChanged = normalized.some((task, i) => task.status !== tasks[i]?.status)
    if (statusChanged) {
      saveTaskSnapshots(normalized)
    }
    return normalized
  })

  ipcMain.handle('task:save-snapshot', async (_event, tasks: VideoTask[]) => {
    if (!Array.isArray(tasks)) return
    saveTaskSnapshots(tasks)
  })

  ipcMain.on('task:start', (_event, taskInfos: TaskStartInfo[]) => {
    const config = loadConfig()
    const taskIds = taskInfos.map((t) => t.id)
    const tasks = taskInfos.map((t) => ({
      videoPath: t.videoPath,
      subtitlePath: t.subtitlePath,
    }))
    startTasks(taskIds, tasks, config)
  })

  ipcMain.on('task:pause', (_event, taskId: string) => {
    pauseTask(taskId)
  })

  ipcMain.on('task:cancel', (_event, taskId: string) => {
    cancelTask(taskId)
  })

  ipcMain.on('task:cancel-all', (_event, taskIds: string[]) => {
    cancelAllTasks(Array.isArray(taskIds) ? taskIds : [])
  })

  ipcMain.on('task:save-review', (_event, taskId: string, cues: Cue[]) => {
    saveReviewCues(taskId, cues)
  })

  ipcMain.on('task:confirm-review', (_event, taskId: string, cues: Cue[]) => {
    confirmReview(taskId, cues)
  })

  ipcMain.on('task:resume', (_event, taskId: string) => {
    resumeTask(taskId, loadConfig())
  })
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  const windows = BrowserWindow.getAllWindows()
  windows.forEach((win) => {
    win.webContents.send(channel, ...args)
  })
}
