import { useEffect, useRef } from 'react'
import { useAppStore } from './stores/app-store'
import { useIpcListeners } from './hooks/use-electron'
import { TooltipProvider } from './components/ui/tooltip'
import { ConfigPanel } from './components/ConfigPanel'
import { ActionBar } from './components/ActionBar'
import { VideoTable } from './components/VideoTable'
import { SubtitleEditor } from './components/SubtitleEditor'

export default function App() {
  const { config, tasks, sidebarOpen, loadConfig, setTasks } = useAppStore()
  const configLoaded = useRef(false)
  const tasksLoaded = useRef(false)

  useIpcListeners()

  useEffect(() => {
    const configPromise = window.api?.config.load()
    if (configPromise) {
      configPromise
        .then((cfg) => {
          loadConfig(cfg)
        })
        .finally(() => {
          configLoaded.current = true
        })
    } else {
      configLoaded.current = true
    }

    const taskPromise = window.api?.task.loadSnapshot()
    if (taskPromise) {
      taskPromise
        .then((saved) => {
          if (Array.isArray(saved) && saved.length > 0) {
            setTasks(saved)
          }
        })
        .finally(() => {
          tasksLoaded.current = true
        })
    } else {
      tasksLoaded.current = true
    }
  }, [loadConfig, setTasks])

  useEffect(() => {
    if (!configLoaded.current) return
    const timer = setTimeout(() => {
      window.api?.config.save(config)
    }, 500)
    return () => clearTimeout(timer)
  }, [config])

  useEffect(() => {
    if (!tasksLoaded.current) return
    const timer = setTimeout(() => {
      window.api?.task.saveSnapshot(tasks)
    }, 500)
    return () => clearTimeout(timer)
  }, [tasks])

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground antialiased">
        <div
          className="shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out"
          style={{ width: sidebarOpen ? 360 : 0 }}
        >
          <ConfigPanel />
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <ActionBar />
          <VideoTable />
        </div>

        <SubtitleEditor />
      </div>
    </TooltipProvider>
  )
}
