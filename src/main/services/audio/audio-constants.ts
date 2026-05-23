export const SR = 48000
export const SAFETY_GAP_US = 50_000

export const MERGE_GAP_US = 200_000
export const MAX_SEGMENT_DURATION_US = 30_000_000
export const MAX_SEGMENT_TEXT_CHARS = 320
export const STRONG_TERMINALS = /[.?!…。？；]+$/

export const SENTENCE_GROUP_CHUNK_SIZE = 40
export const SENTENCE_GROUP_OVERLAP = 4
export const SENTENCE_GROUPING_VERSION = '2026-05-23-v2'
export const LLM_GROUPING_TIMEOUT_MS = 30_000

export const CHINESE_SPLIT_BATCH_SIZE = 12
export const CHINESE_SPLIT_VERSION = '2026-05-23-v1'
export const LLM_CHINESE_SPLIT_TIMEOUT_MS = 25_000

export const SUBTITLE_MAX_CHARS_PER_CUE = 40
export const SUBTITLE_SOFT_SPLIT_TARGET = 30
export const SUBTITLE_MIN_CHARS_PER_CUE = 6
export const SUBTITLE_MIN_DURATION_US = 800_000
export const ASS_SOFT_WRAP_MAX_CHARS = 20

export const MARGIN_SEC = 0.15
export const CPS_SAFETY_FACTOR = 0.9

export const FADE_MS = 10
export const FADE_SAMPLES = Math.round((FADE_MS / 1000) * SR)

export const MAX_RETRIES_PER_LEVEL = 2
export const SLIGHT_RATE_STEPS = ['+4%', '+6%', '+8%'] as const
export const MAX_SLIGHT_RATE_OVERRUN = 1.18

export const HIGH_RISK_WINDOW_US = 1_800_000
export const MEDIUM_RISK_WINDOW_US = 2_800_000
export const TECH_TOKEN_RE =
  /\b(?:[A-Z][A-Za-z0-9_]*|[A-Za-z]+(?:[./#_-][A-Za-z0-9_]+)+|[A-Za-z]+\d+)\b/g
