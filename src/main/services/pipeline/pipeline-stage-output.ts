import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppConfig, Cue, Segment } from '../../../types'
import { assembleToWav, type AssemblerSegment } from '../audio'
import { burnSubtitlesIntoVideo, muxVideoWithAudio, type ProbeResult } from '../ffmpeg'
import { reserveOutputTarget } from '../output-path'
import { checkCancelled, checkPaused, isCancelled } from './pipeline-control'
import { reportProgress, sendToRenderer } from './pipeline-progress'
import { clearTaskTranslationRuntime } from './pipeline-translation-cache'
import { clearSegmentCacheByPath } from '../segment-cache'
import { repartitionCuesPerSegment, saveAssSubtitleFile, saveSubtitleFile } from '../subtitle'
import { saveTaskCues } from '../../task-cue-store'

interface OutputStageContext {
  taskId: string
  videoPath: string
  config: AppConfig
  probeResult: ProbeResult
  englishCues: Cue[]
  finalizedCues: Cue[]
  segments: Segment[]
  assemblerSegments: AssemblerSegment[]
}

export async function runOutputStage(context: OutputStageContext): Promise<void> {
  const { taskId, videoPath, config, probeResult, englishCues, finalizedCues, segments, assemblerSegments } = context
  const displayCues = repartitionCuesPerSegment(finalizedCues, segments)

  let tempDir: string | undefined
  let reservedOutput: ReturnType<typeof reserveOutputTarget> | undefined
  let releaseOutput: (() => void) | undefined
  let outputVideoReady = false
  let stageCompleted = false

  const cleanupOutputArtifacts = () => {
    if (!reservedOutput) return
    try {
      rmSync(reservedOutput.outputVideoPath, { force: true })
    } catch {
      /* noop */
    }
    if (reservedOutput.outputSubtitlePath) {
      try {
        rmSync(reservedOutput.outputSubtitlePath, { force: true })
      } catch {
        /* noop */
      }
    }
    if (config.createVideoSubfolder) {
      try {
        rmSync(reservedOutput.outputDir, { recursive: false })
      } catch {
        /* noop */
      }
    }
  }

  try {
    reportProgress(taskId, 'assembling', 82, '正在拼接整条配音轨道')
    tempDir = join(tmpdir(), `chronodub-${taskId}-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    const wavPath = join(tempDir, 'dubbed.wav')
    await assembleToWav(assemblerSegments, probeResult.durationUs, wavPath)
    checkCancelled(taskId)
    await checkPaused(taskId)
    checkCancelled(taskId)

    reportProgress(taskId, 'encoding', 88, '正在封装输出视频')
    reservedOutput = reserveOutputTarget(
      videoPath,
      config.outputDir,
      config.createVideoSubfolder,
      config.subtitleOutputMode === 'external'
    )
    releaseOutput = reservedOutput.release
    mkdirSync(reservedOutput.outputDir, { recursive: true })
    await checkPaused(taskId)
    checkCancelled(taskId)

    const onEncodingProgress = (ratio: number): void => {
      const pct = 88 + Math.round(ratio * 7)
      reportProgress(taskId, 'encoding', Math.min(95, Math.max(88, pct)), '正在封装输出视频')
    }
    const pickDim = (a: number | null | undefined, b: number | null | undefined, fallback: number): number => {
      for (const v of [a, b]) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
      }
      return fallback
    }
    if (config.subtitleOutputMode === 'burned') {
      const assPath = join(tempDir, 'burned.ass')
      saveAssSubtitleFile(assPath, displayCues, config.subtitleStyle, {
        width: pickDim(probeResult.displayWidth, probeResult.videoWidth, 1920),
        height: pickDim(probeResult.displayHeight, probeResult.videoHeight, 1080),
      })
      await burnSubtitlesIntoVideo(videoPath, wavPath, assPath, reservedOutput.outputVideoPath, {
        isCancelled: () => isCancelled(taskId),
        onProgress: onEncodingProgress,
        totalDurationUs: probeResult.durationUs,
      })
    } else {
      await muxVideoWithAudio(videoPath, wavPath, reservedOutput.outputVideoPath, {
        isCancelled: () => isCancelled(taskId),
        onProgress: onEncodingProgress,
        totalDurationUs: probeResult.durationUs,
      })
    }
    outputVideoReady = true
    checkCancelled(taskId)

    reportProgress(taskId, 'encoding', 95, '正在写出字幕和结果文件')
    if (config.subtitleOutputMode === 'external' && reservedOutput.outputSubtitlePath) {
      saveSubtitleFile(reservedOutput.outputSubtitlePath, displayCues)
    }
    await saveTaskCues(taskId, { englishCues, chineseCues: finalizedCues })
    sendToRenderer('task:cues-updated', taskId, englishCues, finalizedCues)
    clearTaskTranslationRuntime(taskId)
    void clearSegmentCacheByPath(config.outputDir, videoPath).catch((err) => {
      console.warn(`[pipeline] clearSegmentCacheByPath failed for ${taskId}:`, err)
    })

    reportProgress(taskId, 'completed', 100, '处理完成')
    stageCompleted = true
  } finally {
    if (isCancelled(taskId) || (!stageCompleted && !outputVideoReady)) {
      cleanupOutputArtifacts()
    }
    releaseOutput?.()
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        /* noop */
      }
    }
  }
}
