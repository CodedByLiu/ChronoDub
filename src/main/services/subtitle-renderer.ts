import { writeFileSync } from 'fs'
import type { Cue, SubtitlePosition, SubtitleStyleConfig } from '../../types'

const DEFAULT_PLAY_RES_X = 1920
const DEFAULT_PLAY_RES_Y = 1080
const FONT_SCALE_BASE_HEIGHT = 1080

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

function escapeAssText(text: string): string {
  return text
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

export function renderAssSubtitles(
  cues: Cue[],
  style: SubtitleStyleConfig,
  target?: SubtitleRenderTarget
): string {
  const renderTarget = resolveRenderTarget(target)
  const fontFamily = normalizeFontFamily(style.fontFamily)
  const resolvedFontSize = Math.max(20, scaleToRenderHeight(style.fontSize, renderTarget.height))
  const borderStyle = style.backgroundEnabled ? 4 : 1
  const outlineWidth = style.outlineEnabled
    ? Math.max(0, scaleToRenderHeight(style.outlineWidth, renderTarget.height))
    : 0
  const backgroundPadding = style.backgroundEnabled
    ? Math.max(0, scaleToRenderHeight(style.backgroundPadding ?? 0, renderTarget.height))
    : 0
  const effectiveOutlineWidth = style.backgroundEnabled
    ? outlineWidth + backgroundPadding
    : outlineWidth
  const alignment = getAssAlignment(style.position)
  const marginV = Math.max(24, scaleToRenderHeight(style.safeMargin, renderTarget.height))
  const primaryColor = toAssColor(style.textColor)
  const outlineColor = toAssColor(style.outlineColor)
  const backColor = style.backgroundEnabled
    ? toAssColor(style.backgroundColor, style.backgroundOpacity)
    : '&H00000000'
  const shadowSize = style.backgroundEnabled ? Math.max(2, Math.round(resolvedFontSize * 0.08)) : 0
  const bold = style.bold ? -1 : 0
  const italic = style.italic ? -1 : 0

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${renderTarget.width}
PlayResY: ${renderTarget.height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontFamily},${resolvedFontSize},${primaryColor},${primaryColor},${outlineColor},${backColor},${bold},${italic},0,0,100,100,0,0,${borderStyle},${effectiveOutlineWidth},${shadowSize},${alignment},120,120,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`

  const dialogues = cues
    .filter((cue) => cue.endUs > cue.startUs && cue.text.trim())
    .map(
      (cue) =>
        `Dialogue: 0,${assTime(cue.startUs)},${assTime(cue.endUs)},Default,,0,0,0,,${escapeAssText(cue.text)}`
    )

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
