import type { AppConfig, Cue, Segment } from '../../types'
import type { ProbeResult } from './ffmpeg'
import type { SegmentRisk } from './audio-processor'

export interface TranslationStageResult {
  englishCues: Cue[]
  segments: Segment[]
  windows: Array<{
    segmentId: number
    startUs: number
    deadlineUs: number
    windowUs: number
    budgetChars: number
  }>
  probeResult: ProbeResult
  segmentRiskMap: Map<number, SegmentRisk>
  reviewedCues: Cue[]
}

export interface SynthesisStageResult {
  finalizedCues: Cue[]
  assemblerSegments: Array<{
    startUs: number
    deadlineUs: number
    pcm: Buffer
  }>
}

export interface PipelineStageContext {
  taskId: string
  videoPath: string
  subtitlePath: string
  config: AppConfig
}
