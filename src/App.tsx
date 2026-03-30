import { useEffect, useRef } from 'react'
import { useAppStore } from './stores/app-store'
import { useIpcListeners } from './hooks/use-electron'
import { TooltipProvider } from './components/ui/tooltip'
import { ConfigPanel } from './components/ConfigPanel'
import { ActionBar } from './components/ActionBar'
import { VideoTable } from './components/VideoTable'
import { SubtitleEditor } from './components/SubtitleEditor'

export default function App() {
  const { config, sidebarOpen, loadConfig } = useAppStore()
  const configLoaded = useRef(false)

  useIpcListeners()

  useEffect(() => {
    window.api?.config.load().then((cfg) => {
      loadConfig(cfg)
      configLoaded.current = true
    })
  }, [])

  useEffect(() => {
    if (!configLoaded.current) return
    const timer = setTimeout(() => {
      window.api?.config.save(config)
    }, 500)
    return () => clearTimeout(timer)
  }, [config])

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden">
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
