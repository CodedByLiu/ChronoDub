import type { Cue, MicrosecondTimestamp, Segment, TimeWindow } from '../../types'
import { MAX_SEGMENT_DURATION_US, MERGE_GAP_US, SAFETY_GAP_US, STRONG_TERMINALS } from './audio-constants'

export function buildSegments(cues: Cue[]): Segment[] {
  if (cues.length === 0) return []

  const sorted = [...cues].sort((a, b) => a.startUs - b.startUs)
  const segments: Segment[] = []
  let current: Segment = {
    id: 0,
    cueIds: [sorted[0].id],
    startUs: sorted[0].startUs,
    endUs: sorted[0].endUs,
    textEn: sorted[0].text,
  }

  for (let i = 1; i < sorted.length; i++) {
    const cue = sorted[i]
    const gap = cue.startUs - current.endUs
    const mergedDuration = cue.endUs - current.startUs
    const lastText = sorted[i - 1].text

    const canMerge =
      gap <= MERGE_GAP_US &&
      !STRONG_TERMINALS.test(lastText) &&
      mergedDuration <= MAX_SEGMENT_DURATION_US

    if (canMerge) {
      current.cueIds.push(cue.id)
      current.endUs = cue.endUs
      current.textEn += ` ${cue.text}`
    } else {
      segments.push(current)
      current = {
        id: segments.length,
        cueIds: [cue.id],
        startUs: cue.startUs,
        endUs: cue.endUs,
        textEn: cue.text,
      }
    }
  }
  segments.push(current)

  return segments
}

export function buildTimeWindows(
  segments: Segment[],
  videoDurationUs: MicrosecondTimestamp
): TimeWindow[] {
  const windows: TimeWindow[] = []

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const nextStart = i < segments.length - 1 ? segments[i + 1].startUs : videoDurationUs
    const hardDeadline = nextStart - SAFETY_GAP_US
    const deadline = Math.max(hardDeadline, seg.startUs + SAFETY_GAP_US)
    const windowUs = deadline - seg.startUs

    windows.push({
      segmentId: seg.id,
      startUs: seg.startUs,
      deadlineUs: deadline,
      windowUs,
      budgetChars: 0,
    })
  }

  return windows
}
