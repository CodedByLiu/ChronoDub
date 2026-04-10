const EN_WORD_RE = /[A-Za-z]+(?:'[A-Za-z]+)?/g
const EN_LETTER_RE = /[A-Za-z]/g
const EN_COPULA_SENTENCE_RE =
  /^(?:so\s+)?(?:this|that|it|there)\s+(?:is|was|are|were|means|refers\s+to)\b/i
const EN_THIS_IS_ARTICLE_RE = /^this\s+is\s+(?:the|a|an)\b/i

export function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text)
}

export function looksLikeSentence(text: string): boolean {
  return /\s/.test(text) || /[,.!?;:\u3002\uFF0C\uFF1F\uFF01\uFF1B\uFF1A]/.test(text) || text.length >= 20
}

function countEnglishWords(text: string): number {
  return text.match(EN_WORD_RE)?.length ?? 0
}

function countEnglishLetters(text: string): number {
  return text.match(EN_LETTER_RE)?.length ?? 0
}

function countVisibleChars(text: string): number {
  return text.replace(/\s+/g, '').length
}

export function isMostlyEnglishText(text: string): boolean {
  const normalized = normalizeSpaces(text)
  if (!normalized || hasCjk(normalized)) return false

  const visibleChars = countVisibleChars(normalized)
  if (visibleChars === 0) return false

  const englishLetters = countEnglishLetters(normalized)
  const englishWords = countEnglishWords(normalized)
  const englishRatio = englishLetters / visibleChars

  if (englishWords >= 2 && englishRatio >= 0.45) return true
  if (englishWords >= 1 && visibleChars >= 20 && englishRatio >= 0.6) return true
  return false
}

export function shouldRetryAsOverCompressed(source: string, translated: string): boolean {
  const src = normalizeSpaces(source)
  const dst = normalizeSpaces(translated)
  if (!src || !dst || !looksLikeSentence(src) || !hasCjk(dst)) return false

  const dstChars = countVisibleChars(dst)
  const srcWords = countEnglishWords(src)
  if (srcWords >= 4 && EN_COPULA_SENTENCE_RE.test(src) && dstChars <= 4) return true
  if (srcWords >= 4 && EN_THIS_IS_ARTICLE_RE.test(src) && dstChars <= 6) return true
  return false
}

export function shouldRetryAsUntranslated(source: string, translated: string): boolean {
  const src = normalizeSpaces(source)
  const dst = normalizeSpaces(translated)
  if (!dst) return true

  if (src !== dst) {
    if (looksLikeSentence(src) && isMostlyEnglishText(dst)) return true
    return false
  }
  if (hasCjk(src)) return false
  return looksLikeSentence(src)
}

export function isAcceptableTranslatedText(source: string, translated: string): boolean {
  const normalized = normalizeSpaces(translated)
  if (!normalized) return false
  if (shouldRetryAsUntranslated(source, normalized)) return false
  if (shouldRetryAsOverCompressed(source, normalized)) return false
  return true
}

export function isAcceptableCompressedChinese(source: string, compressed: string): boolean {
  const src = normalizeSpaces(source)
  const dst = normalizeSpaces(compressed)
  if (!dst) return false
  if (!hasCjk(src)) return true
  if (hasCjk(dst)) return true
  return !isMostlyEnglishText(dst)
}
