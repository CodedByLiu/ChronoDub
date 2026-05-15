import { Mars, Venus } from 'lucide-react'
import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyleConfig } from '../../types'
import { PREFERRED_SUBTITLE_FONTS, type SubtitleNumberField, VOICE_CN_NAMES } from './constants'

export interface Voice {
  name: string
  locale: string
  gender: string
}

export function pickPreferredFont(fonts: string[]): string {
  for (const preferred of PREFERRED_SUBTITLE_FONTS) {
    const match = fonts.find((font) => font.toLocaleLowerCase() === preferred.toLocaleLowerCase())
    if (match) return match
  }
  return fonts[0] || 'Arial'
}

export function clampNumber(value: string, fallback: number, min: number, max: number): number {
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

export function normalizeColorValue(value: string, fallback: string): string {
  const normalized = value.trim()
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized : fallback
}

export function digitsOnly(value: string): string {
  return value.replace(/\D+/g, '')
}

export function buildSubtitleNumberDrafts(style: SubtitleStyleConfig): Record<SubtitleNumberField, string> {
  return {
    fontSize: String(style.fontSize ?? DEFAULT_SUBTITLE_STYLE.fontSize),
    outlineWidth: String(style.outlineWidth ?? DEFAULT_SUBTITLE_STYLE.outlineWidth),
    backgroundOpacity: String(style.backgroundOpacity ?? DEFAULT_SUBTITLE_STYLE.backgroundOpacity),
    backgroundPadding: String(style.backgroundPadding ?? DEFAULT_SUBTITLE_STYLE.backgroundPadding),
    safeMargin: String(style.safeMargin ?? DEFAULT_SUBTITLE_STYLE.safeMargin),
  }
}

export function renderVoiceLabel(voiceName: string, voices: Voice[]) {
  const voice = voices.find((item) => item.name === voiceName)
  const cnName = VOICE_CN_NAMES[voiceName]
  const isFemale = voice?.gender === 'Female'

  return (
    <span className="flex items-center gap-1.5">
      {isFemale ? (
        <Venus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : (
        <Mars className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span>{cnName || voiceName}</span>
    </span>
  )
}
