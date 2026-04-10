export { SR, SAFETY_GAP_US } from './audio-constants'

export { buildSegments, buildTimeWindows } from './audio-segmentation'

export { calibrateCPS, computeBudget, assignBudgets, resetCpsCache } from './audio-cps'

export {
  processAudio,
  applyFadeInOut,
  assembleTrack,
  assembleToWav,
  synthesizeProcessedText,
  clipProcessedAudioToWindow,
  type AudioBoundary,
  type ProcessedAudio,
  type AssemblerSegment,
} from './audio-processing'

export { classifySegmentRisk, type SegmentRisk } from './audio-risk'

export { synthesizeWithFallback, type FallbackContext } from './audio-fallback'
