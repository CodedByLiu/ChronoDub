import { useEffect } from 'react'
import { useAppStore } from '../stores/app-store'

export function useIpcListeners() {
  const { updateTaskStatus, updateTaskCountdown, updateTaskCues, updateTaskError, setTaskTranslationIssues } =
    useAppStore()

  useEffect(() => {
    const unsubProgress = window.api?.task.onProgress((taskId, status, progress, detail) => {
      updateTaskStatus(taskId, status, progress, detail)
    })

    const unsubCountdown = window.api?.task.onReviewCountdown((taskId, remaining) => {
      updateTaskCountdown(taskId, remaining)
    })

    const unsubReviewReady = window.api?.task.onReviewReady((taskId, englishCues, chineseCues) => {
      updateTaskCues(taskId, englishCues, chineseCues)
      updateTaskStatus(taskId, 'reviewing')
    })

    const unsubCuesUpdated = window.api?.task.onCuesUpdated((taskId, englishCues, chineseCues) => {
      updateTaskCues(taskId, englishCues, chineseCues)
    })

    const unsubError = window.api?.task.onError((taskId, message, detail) => {
      updateTaskError(taskId, message, detail)
    })

    const unsubTranslationIssues = window.api?.task.onTranslationIssues((taskId, issues) => {
      setTaskTranslationIssues(taskId, issues)
    })

    return () => {
      unsubProgress?.()
      unsubCountdown?.()
      unsubReviewReady?.()
      unsubCuesUpdated?.()
      unsubError?.()
      unsubTranslationIssues?.()
    }
  }, [])
}
