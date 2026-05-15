import { writeFileSync } from 'fs'
import type { Cue, SubtitlePosition, SubtitleStyleConfig } from '../../../types'
import { ASS_SOFT_WRAP_MAX_CHARS } from '../audio'

const DEFAULT_PLAY_RES_X = 1920
const DEFAULT_PLAY_RES_Y = 1080
const FONT_SCALE_BASE_HEIGHT = 1080
const LAYOUT_SCALE_BASE_WIDTH = 1920

export interface SubtitleRenderTarget {
  width: number
  height: number
}

function normalizeFontFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim()
  return trimmed ? trimmed.replace(/,/g, ' ') : 'Arial'
}

function toAssColor(hex: string, opacityPercent = 100): string {
  const normalized = hex.trim().replace(/^#/, '')
  const safeHex = /^[0-9a-fA-F]{6}$/.test(normalized) ? normalized : 'FFFFFF'
  const r = safeHex.slice(0, 2)
  const g = safeHex.slice(2, 4)
  const b = safeHex.slice(4, 6)
  const alpha = Math.round(((100 - opacityPercent) / 100) * 255)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0')

  return `&H${alpha}${b}${g}${r}`
}

function assTime(us: number): string {
  const totalCentiseconds = Math.max(0, Math.round(us / 10_000))
  const hours = Math.floor(totalCentiseconds / 360_000)
  const minutes = Math.floor((totalCentiseconds % 360_000) / 6_000)
  const seconds = Math.floor((totalCentiseconds % 6_000) / 100)
  const centiseconds = totalCentiseconds % 100
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`
}

const SOFT_WRAP_SPLIT_RE = /[，、；：,;:\s]/g

export function softWrapForAss(text: string, maxLineChars: number): string {
  if (maxLineChars <= 0 || text.length <= maxLineChars) return text

  const mid = Math.floor(text.length / 2)
  const candidates: number[] = []
  let m: RegExpExecArray | null
  SOFT_WRAP_SPLIT_RE.lastIndex = 0
  while ((m = SOFT_WRAP_SPLIT_RE.exec(text)) !== null) {
    candidates.push(m.index + 1)
  }

  const splitAt =
    candidates.length > 0
      ? candidates.reduce((best, idx) =>
          Math.abs(idx - mid) < Math.abs(best - mid) ? idx : best
        )
      : mid
  const left = text.slice(0, splitAt).trimEnd()
  const right = text.slice(splitAt).trimStart()
  if (!left || !right) return text
  return `${left}\n${right}`
}

function escapeAssText(text: string, softWrapChars: number): string {
  const wrapped = softWrapChars > 0 ? softWrapForAss(text, softWrapChars) : text
  return wrapped
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\N')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
}

function getAssAlignment(position: SubtitlePosition): number {
  return position === 'top-safe' ? 8 : 2
}

function resolveRenderTarget(target?: SubtitleRenderTarget): SubtitleRenderTarget {
  const width =
    typeof target?.width === 'number' && target.width > 0
      ? Math.round(target.width)
      : DEFAULT_PLAY_RES_X
  const height =
    typeof target?.height === 'number' && target.height > 0
      ? Math.round(target.height)
      : DEFAULT_PLAY_RES_Y

  return { width, height }
}

function scaleToRenderHeight(value: number, renderHeight: number): number {
  return Math.round((value * renderHeight) / FONT_SCALE_BASE_HEIGHT)
}

function scaleToRenderWidth(value: number, renderWidth: number): number {
  return Math.round((value * renderWidth) / LAYOUT_SCALE_BASE_WIDTH)
}

function transparentAssColor(): string {
  return '&HFF000000'
}

interface AssStyle {
  name: string
  fontFamily: string
  fontSize: number
  primaryColor: string
  secondaryColor: string
  outlineColor: string
  backColor: string
  bold: number
  italic: number
  borderStyle: number
  outline: number
  shadow: number
  alignment: number
  marginX: number
  marginV: number
}

function renderStyleLine(style: AssStyle): string {
  return `Style: ${style.name},${style.fontFamily},${style.fontSize},${style.primaryColor},${style.secondaryColor},${style.outlineColor},${style.backColor},${style.bold},${style.italic},0,0,100,100,0,0,${style.borderStyle},${style.outline},${style.shadow},${style.alignment},${style.marginX},${style.marginX},${style.marginV},1`
}

export function renderAssSubtitles(
  cues: Cue[],
  style: SubtitleStyleConfig,
  target?: SubtitleRenderTarget
): string {
  const renderTarget = resolveRenderTarget(target)
  const fontFamily = normalizeFontFamily(style.fontFamily)
  const resolvedFontSize = Math.max(20, scaleToRenderHeight(style.fontSize, renderTarget.height))
  const textOutlineWidth = style.outlineEnabled
    ? Math.max(0, scaleToRenderHeight(style.outlineWidth, renderTarget.height))
    : 0
  const backgroundPadding = style.backgroundEnabled
    ? Math.max(0, scaleToRenderHeight(style.backgroundPadding ?? 0, renderTarget.height))
    : 0
  const alignment = getAssAlignment(style.position)
  const marginX = Math.max(24, scaleToRenderWidth(120, renderTarget.width))
  const marginV = Math.max(24, scaleToRenderHeight(style.safeMargin, renderTarget.height))
  const primaryColor = toAssColor(style.textColor)
  const backColor = style.backgroundEnabled
    ? toAssColor(style.backgroundColor, style.backgroundOpacity)
    : '&H00000000'
  const outlineColor = toAssColor(style.outlineColor)
  const textShadowSize =
    style.outlineEnabled && style.backgroundEnabled
      ? Math.max(2, Math.round(resolvedFontSize * 0.08))
      : 0
  const bold = style.bold ? -1 : 0
  const italic = style.italic ? -1 : 0
  const backgroundBoxSize = backgroundPadding + (style.outlineEnabled ? textOutlineWidth : 0)

  const styles: AssStyle[] = []
  if (style.backgroundEnabled) {
    styles.push({
      name: 'Bg',
      fontFamily,
      fontSize: resolvedFontSize,
      primaryColor: transparentAssColor(),
      secondaryColor: transparentAssColor(),
      outlineColor: '&H00000000',
      backColor,
      bold,
      italic,
      borderStyle: 3,
      outline: backgroundBoxSize,
      shadow: 0,
      alignment,
      marginX,
      marginV,
    })
  }
  styles.push({
    name: 'Text',
    fontFamily,
    fontSize: resolvedFontSize,
    primaryColor,
    secondaryColor: primaryColor,
    outlineColor,
    backColor: '&H00000000',
    bold,
    italic,
    borderStyle: 1,
    outline: textOutlineWidth,
    shadow: style.outlineEnabled ? textShadowSize : 0,
    alignment,
    marginX,
    marginV,
  })

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${renderTarget.width}
PlayResY: ${renderTarget.height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.map(renderStyleLine).join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const softWrapChars = style.softWrapEnabled
    ? Math.max(0, Math.floor(style.softWrapMaxChars ?? ASS_SOFT_WRAP_MAX_CHARS))
    : 0
  const dialogues: string[] = []
  for (const cue of cues) {
    if (cue.endUs <= cue.startUs || !cue.text.trim()) continue
    const start = assTime(cue.startUs)
    const end = assTime(cue.endUs)
    const text = escapeAssText(cue.text, softWrapChars)

    if (style.backgroundEnabled) {
      dialogues.push(`Dialogue: 0,${start},${end},Bg,,0,0,0,,${text}`)
      dialogues.push(`Dialogue: 1,${start},${end},Text,,0,0,0,,${text}`)
      continue
    }

    dialogues.push(`Dialogue: 0,${start},${end},Text,,0,0,0,,${text}`)
  }

  return `${header}\n${dialogues.join('\n')}\n`
}

export function saveAssSubtitleFile(
  filePath: string,
  cues: Cue[],
  style: SubtitleStyleConfig,
  target?: SubtitleRenderTarget
): void {
  writeFileSync(filePath, renderAssSubtitles(cues, style, target), 'utf-8')
}
