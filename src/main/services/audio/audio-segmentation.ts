import type { Cue, MicrosecondTimestamp, Segment, SentenceGroup, TimeWindow } from '../../../types'
import {
  MAX_SEGMENT_DURATION_US,
  MAX_SEGMENT_TEXT_CHARS,
  MERGE_GAP_US,
  SAFETY_GAP_US,
} from './audio-constants'

const TRAILING_SOFT_PUNCT_RE = /[,;:\-–—]+$/

export function joinGroupTextForTranslation(cueTexts: string[]): string {
  return cueTexts
    .map((t, i) =>
      i < cueTexts.length - 1
        ? t.trimEnd().replace(TRAILING_SOFT_PUNCT_RE, '').trimEnd()
        : t.trimEnd()
    )
    .filter((t) => t.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function groupCuesByGap(cues: Cue[]): SentenceGroup[] {
  if (cues.length === 0) return []
  const sorted = [...cues].sort((a, b) => a.startUs - b.startUs)
  const groups: SentenceGroup[] = []
  let current: number[] = [sorted[0].id]
  let groupStartUs = sorted[0].startUs
  let prevEndUs = sorted[0].endUs

  for (let i = 1; i < sorted.length; i++) {
    const cue = sorted[i]
    const gap = cue.startUs - prevEndUs
    const wouldExceedMax = cue.endUs - groupStartUs > MAX_SEGMENT_DURATION_US
    if (gap <= MERGE_GAP_US && !wouldExceedMax) {
      current.push(cue.id)
    } else {
      groups.push({ cueIds: current })
      current = [cue.id]
      groupStartUs = cue.startUs
    }
    prevEndUs = cue.endUs
  }
  groups.push({ cueIds: current })
  return groups
}

function splitGroupByMaxDuration(cues: Cue[], group: SentenceGroup): SentenceGroup[] {
  const cueMap = new Map(cues.map((c) => [c.id, c]))
  const groupCues = group.cueIds.map((id) => cueMap.get(id)).filter((c): c is Cue => !!c)
  if (groupCues.length === 0) return []
  const span = groupCues[groupCues.length - 1].endUs - groupCues[0].startUs
  const joinedChars = joinGroupTextForTranslation(groupCues.map((c) => c.text)).length
  const exceedsSpan = span > MAX_SEGMENT_DURATION_US
  const exceedsChars = joinedChars > MAX_SEGMENT_TEXT_CHARS
  if ((!exceedsSpan && !exceedsChars) || groupCues.length === 1) {
    return [{ cueIds: groupCues.map((c) => c.id) }]
  }

  let largestGapIdx = 1
  let largestGap = -1
  for (let i = 1; i < groupCues.length; i++) {
    const gap = groupCues[i].startUs - groupCues[i - 1].endUs
    if (gap > largestGap) {
      largestGap = gap
      largestGapIdx = i
    }
  }

  const left: SentenceGroup = { cueIds: groupCues.slice(0, largestGapIdx).map((c) => c.id) }
  const right: SentenceGroup = { cueIds: groupCues.slice(largestGapIdx).map((c) => c.id) }
  return [...splitGroupByMaxDuration(cues, left), ...splitGroupByMaxDuration(cues, right)]
}

export function buildSegmentsFromGroups(cues: Cue[], groups: SentenceGroup[]): Segment[] {
  if (cues.length === 0 || groups.length === 0) return []
  const cueMap = new Map(cues.map((c) => [c.id, c]))
  const segments: Segment[] = []

  const safeGroups: SentenceGroup[] = []
  for (const group of groups) {
    for (const sub of splitGroupByMaxDuration(cues, group)) {
      if (sub.cueIds.length > 0) safeGroups.push(sub)
    }
  }

  for (const group of safeGroups) {
    const groupCues = group.cueIds.map((id) => cueMap.get(id)).filter((c): c is Cue => !!c)
    if (groupCues.length === 0) continue
    const first = groupCues[0]
    const last = groupCues[groupCues.length - 1]
    segments.push({
      id: segments.length,
      cueIds: groupCues.map((c) => c.id),
      startUs: first.startUs,
      endUs: last.endUs,
      textEn: joinGroupTextForTranslation(groupCues.map((c) => c.text)),
    })
  }

  return segments
}

export function buildSegments(cues: Cue[]): Segment[] {
  return buildSegmentsFromGroups(cues, groupCuesByGap(cues))
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
