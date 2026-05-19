import { readFileSync, writeFileSync } from 'fs'
import { extname } from 'path'
import { parseSync, stringifySync } from 'subtitle'
import type { Cue } from '../../../types'

const MS_TO_US = 1000

const RE_TIMESTAMP = /^((?:\d{1,}:)?\d{1,2}:\d{1,2}[,.]\d{1,3}) --> ((?:\d{1,}:)?\d{1,2}:\d{1,2}[,.]\d{1,3})(?: (.*))?$/

export function parseSubtitleFile(filePath: string): Cue[] {
  const ext = extname(filePath).toLowerCase()
  const content = readFileSync(filePath, 'utf-8')
  return parseSubtitleContent(content, ext)
}

export function parseSubtitleContent(content: string, ext: string): Cue[] {
  if (ext === '.ass' || ext === '.ssa') {
    return parseASS(content)
  }
  return parseSrtVtt(content)
}

// The `subtitle` package only recognizes numeric cue identifiers; WebVTT allows
// alphanumeric ones like "cue-1". Drop those lines so the underlying parser
// treats the following timestamp line as the start of the cue.
function stripNonNumericCueIds(content: string): string {
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const next = lines[i + 1] ?? ''
    const trimmed = line.trim()
    if (
      trimmed &&
      !RE_TIMESTAMP.test(line) &&
      !/^\d+$/.test(trimmed) &&
      !/^WEBVTT/.test(line) &&
      !/^NOTE\b/.test(line) &&
      RE_TIMESTAMP.test(next)
    ) {
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

function parseSrtVtt(content: string): Cue[] {
  const nodes = parseSync(stripNonNumericCueIds(content))
  const cues: Cue[] = []
  let id = 0

  for (const node of nodes) {
    if (node.type !== 'cue') continue
    cues.push({
      id: id++,
      startUs: node.data.start * MS_TO_US,
      endUs: node.data.end * MS_TO_US,
      text: node.data.text.replace(/<[^>]+>/g, '').trim(),
    })
  }

  return cues
}

const ASS_OVERRIDE_RE = /\{[^}]*\}/g
const ASS_NEWLINE_RE = /\\[Nn]/g

function parseASS(content: string): Cue[] {
  const lines = content.split(/\r?\n/)
  let inEvents = false
  let formatFields: string[] = []
  const cues: Cue[] = []
  let id = 0

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.toLowerCase() === '[events]') {
      inEvents = true
      continue
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inEvents = false
      continue
    }
    if (!inEvents) continue

    if (trimmed.toLowerCase().startsWith('format:')) {
      formatFields = trimmed
        .slice(7)
        .split(',')
        .map((f) => f.trim().toLowerCase())
      continue
    }

    if (!trimmed.toLowerCase().startsWith('dialogue:')) continue
    if (formatFields.length === 0) continue

    const valuesPart = trimmed.slice(trimmed.indexOf(':') + 1)
    const values = splitAssFields(valuesPart, formatFields.length)

    const startIdx = formatFields.indexOf('start')
    const endIdx = formatFields.indexOf('end')
    const textIdx = formatFields.indexOf('text')
    const styleIdx = formatFields.indexOf('style')

    if (startIdx < 0 || endIdx < 0 || textIdx < 0) continue

    const startUs = parseAssTimestamp(values[startIdx]?.trim() || '')
    const endUs = parseAssTimestamp(values[endIdx]?.trim() || '')
    let text = values[textIdx]?.trim() || ''

    text = text.replace(ASS_OVERRIDE_RE, '').replace(ASS_NEWLINE_RE, ' ').trim()
    if (!text) continue

    cues.push({
      id: id++,
      startUs,
      endUs,
      text,
      rawStyle: values[styleIdx]?.trim(),
    })
  }

  cues.sort((a, b) => a.startUs - b.startUs)
  return cues
}

function splitAssFields(line: string, fieldCount: number): string[] {
  const parts: string[] = []
  let start = 0
  for (let i = 0; i < fieldCount - 1; i++) {
    const commaIdx = line.indexOf(',', start)
    if (commaIdx < 0) break
    parts.push(line.slice(start, commaIdx))
    start = commaIdx + 1
  }
  parts.push(line.slice(start))
  return parts
}

// ASS timestamp format: h:mm:ss.cc (centiseconds)
function parseAssTimestamp(ts: string): number {
  const match = ts.match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/)
  if (!match) return 0
  const [, h, m, s, cs] = match
  return (parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s)) * 1_000_000 + parseInt(cs) * 10_000
}

export function cuesToSrt(cues: Cue[]): string {
  const nodes = cues.map((cue) => ({
    type: 'cue' as const,
    data: {
      start: Math.round(cue.startUs / MS_TO_US),
      end: Math.round(cue.endUs / MS_TO_US),
      text: cue.text,
    },
  }))
  return stringifySync(nodes, { format: 'SRT' })
}

export function saveSubtitleFile(filePath: string, cues: Cue[]): void {
  writeFileSync(filePath, cuesToSrt(cues), 'utf-8')
}
