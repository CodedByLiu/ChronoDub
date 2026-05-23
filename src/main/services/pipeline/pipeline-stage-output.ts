import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppConfig, Cue, Segment } from '../../../types'
import { assembleToWav, CHINESE_SPLIT_VERSION, type AssemblerSegment } from '../audio'
import {
  resegmentChineseSegments,
  type ChineseResegmentInput,
} from '../chinese-resegmenter'
import { burnSubtitlesIntoVideo, muxVideoWithAudio, type ProbeResult } from '../ffmpeg'
import { reserveOutputTarget } from '../output-path'
import { checkCancelled, checkPaused, isCancelled } from './pipeline-control'
import { reportProgress, sendToRenderer } from './pipeline-progress'
import { clearTaskTranslationRuntime } from './pipeline-translation-cache'
import {
  clearSegmentCacheByPath,
  hashChineseSplitKey,
  loadChineseSplitCache,
  resolveCacheDir,
  saveChineseSplitCache,
} from '../segment-cache'
import {
  joinCueTextsForSpeech,
  repartitionCuesPerSegment,
  saveAssSubtitleFile,
  saveSubtitleFile,
} from '../subtitle'
import { saveTaskCues } from '../../task-cue-store'

interface ChineseSplitBuildContext {
  taskId: string
  videoPath: string
}

async function buildChineseSplitMap(
  finalizedCues: Cue[],
  segments: Segment[],
  config: AppConfig,
  ctx: ChineseSplitBuildContext
): Promise<Map<number, string[]> | undefined> {
  if (!config.useLLMChineseSegmentation) return undefined
  const llm = config.llm
  if (!llm?.apiKey?.trim() || !llm?.baseUrl?.trim() || !llm?.model?.trim()) return undefined

  const cueMap = new Map(finalizedCues.map((c) => [c.id, c]))
  interface PreparedInput extends ChineseResegmentInput {
    cacheKey: string
  }
  const prepared: PreparedInput[] = []
  for (const seg of segments) {
    const segCues = seg.cueIds.map((id) => cueMap.get(id)).filter((c): c is Cue => !!c)
    if (segCues.length === 0) continue
    const text = joinCueTextsForSpeech(segCues.map((c) => c.text))
    if (!text) continue
    const durationMs = Math.max(
      0,
      Math.round((segCues[segCues.length - 1].endUs - segCues[0].startUs) / 1000)
    )
    prepared.push({
      segmentId: seg.id,
      text,
      durationMs,
      cacheKey: hashChineseSplitKey(text, durationMs),
    })
  }
  if (prepared.length === 0) return undefined

  const cacheDir = resolveCacheDir(config.outputDir, ctx.videoPath)
  const cache = cacheDir
    ? loadChineseSplitCache(cacheDir, ctx.taskId, CHINESE_SPLIT_VERSION)
    : new Map<string, string[]>()

  const result = new Map<number, string[]>()
  const pending: ChineseResegmentInput[] = []
  const pendingKeyById = new Map<number, string>()
  let hits = 0
  for (const item of prepared) {
    const cached = cache.get(item.cacheKey)
    if (cached && cached.length > 0) {
      result.set(item.segmentId, cached)
      hits++
    } else {
      pending.push({ segmentId: item.segmentId, text: item.text, durationMs: item.durationMs })
      pendingKeyById.set(item.segmentId, item.cacheKey)
    }
  }
  console.log(
    `[pipeline-stage-output] Chinese-split cache: ${hits}/${prepared.length} hit, ${pending.length} pending`
  )

  if (pending.length > 0) {
    try {
      const llmResults = await resegmentChineseSegments(pending, { llm })
      for (const [segId, lines] of llmResults.entries()) {
        result.set(segId, lines)
        const key = pendingKeyById.get(segId)
        if (key) cache.set(key, lines)
      }
      if (cacheDir && llmResults.size > 0) {
        try {
          saveChineseSplitCache(cacheDir, ctx.taskId, CHINESE_SPLIT_VERSION, cache)
        } catch (err) {
          console.error(`Failed to persist Chinese-split cache [${ctx.taskId}]:`, err)
        }
      }
    } catch (err) {
      console.warn(
        '[pipeline-stage-output] LLM Chinese resegmentation failed, falling back to heuristic:',
        err instanceof Error ? err.message : err
      )
    }
  }

  return result.size > 0 ? result : undefined
}

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
  if (config.useLLMChineseSegmentation) {
    reportProgress(taskId, 'assembling', 80, '正在 LLM 优化中文字幕换行')
  } else {
    reportProgress(taskId, 'assembling', 80, '正在重新切分中文字幕')
  }
  const precomputedSplits = await buildChineseSplitMap(finalizedCues, segments, config, {
    taskId,
    videoPath,
  })
  checkCancelled(taskId)
  const displayCues = repartitionCuesPerSegment(finalizedCues, segments, undefined, precomputedSplits)

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
    await saveTaskCues(taskId, { englishCues, chineseCues: displayCues })
    sendToRenderer('task:cues-updated', taskId, englishCues, displayCues)
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
