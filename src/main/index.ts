import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc-handlers'
import { testDeepseekConnection } from './services/deepseek'
import { pauseAllActiveTasks } from './services/pipeline'
import { loadTaskSnapshots, normalizeInterruptedTasks, saveTaskSnapshots } from './task-store'

app.setName('ChronoDub')

let mainWindow: BrowserWindow | null = null

function resolveWindowIcon(): string | undefined {
  const fromRendererOut = join(__dirname, '../renderer/logo.png')
  const fromPublicSrc = join(__dirname, '../../src/renderer/public/logo.png')
  if (is.dev && existsSync(fromPublicSrc)) return fromPublicSrc
  if (existsSync(fromRendererOut)) return fromRendererOut
  if (existsSync(fromPublicSrc)) return fromPublicSrc
  return undefined
}

function createWindow(): void {
  const icon = resolveWindowIcon()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'ChronoDub',
    backgroundColor: '#1a1a2e',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: 'ChronoDub',
      applicationVersion: app.getVersion(),
    })
  }

  try {
    ipcMain.removeHandler('deepseek:test-key')
  } catch {
    /* noop */
  }
  ipcMain.handle('deepseek:test-key', async (_event, apiKey: string) => {
    return testDeepseekConnection(apiKey)
  })
  registerIpcHandlers()
  createWindow()

  powerMonitor.on('suspend', () => {
    pauseAllActiveTasks()
    const tasks = loadTaskSnapshots()
    if (tasks.length === 0) return
    saveTaskSnapshots(normalizeInterruptedTasks(tasks))
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
