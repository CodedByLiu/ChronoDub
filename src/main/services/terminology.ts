function escapeRegexTerm(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function englishCueHasTerm(cueText: string, term: string): boolean {
  const t = term.trim()
  if (!t) return false

  const lower = cueText.toLowerCase()
  const termLower = t.toLowerCase()
  if (lower.includes(termLower)) return true

  if (/^[\w.+$#@-]+$/.test(t)) {
    try {
      return new RegExp(`\\b${escapeRegexTerm(t)}\\b`, 'i').test(cueText)
    } catch {
      return false
    }
  }

  return false
}

export function applyTerminologyToChinese(
  englishCue: string,
  chineseText: string,
  dictionary: Array<{ en: string; zh: string }>
): string {
  let out = chineseText
  for (const { en, zh } of dictionary) {
    const term = en.trim()
    if (!term || term.length < 2) continue
    if (!englishCueHasTerm(englishCue, term)) continue
    out = out.replace(new RegExp(escapeRegexTerm(term), 'gi'), zh.trim())
  }
  return out
}
