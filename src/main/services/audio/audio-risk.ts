import type { MicrosecondTimestamp, Segment } from '../../types'
import { HIGH_RISK_WINDOW_US, MEDIUM_RISK_WINDOW_US, TECH_TOKEN_RE } from './audio-constants'

export type SegmentRisk = 'low' | 'medium' | 'high'

function countTechnicalTokens(text: string): number {
  return text.match(TECH_TOKEN_RE)?.length ?? 0
}

export function classifySegmentRisk(
  segment: Pick<Segment, 'textEn' | 'cueIds'>,
  windowUs: MicrosecondTimestamp
): SegmentRisk {
  let score = 0
  const windowSec = windowUs / 1_000_000
  const charsPerSec = segment.textEn.length / Math.max(windowSec, 0.1)
  const technicalTokens = countTechnicalTokens(segment.textEn)

  if (windowUs <= HIGH_RISK_WINDOW_US) score += 3
  else if (windowUs <= MEDIUM_RISK_WINDOW_US) score += 2
  else if (windowUs <= 4_000_000) score += 1

  if (charsPerSec >= 18) score += 2
  else if (charsPerSec >= 12) score += 1

  if (technicalTokens >= 4) score += 2
  else if (technicalTokens >= 2) score += 1

  if (segment.cueIds.length >= 4) score += 1

  if (score >= 5) return 'high'
  if (score >= 3) return 'medium'
  return 'low'
}
