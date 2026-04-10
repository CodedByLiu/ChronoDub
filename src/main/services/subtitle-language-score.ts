const LOW_CONFIDENCE_SCORE = 12
const LOW_CONFIDENCE_VALUE = 18
const SDH_TOKEN_RE =
  /\b(music|applause|laughs?|laughing|sighs?|breathing|gasps?|crowd|audience|door|phone|ringing|beeping)\b/gi
const STRONG_ENGLISH_WORD_RE =
  /\b(the|and|you|that|this|with|for|have|are|not|but|what|when|where|why|how|more|from|into|your|they|their|there|about|would|could|should|think|going|because|really|want|need|know|mean|make|take|look|right|yeah|okay|well|then|than)\b/gi

export function isLowConfidenceEnglish(score: number, confidence: number): boolean {
  return confidence >= LOW_CONFIDENCE_VALUE && score >= LOW_CONFIDENCE_SCORE
}

export function scoreEnglishLikelihood(text: string): { score: number; confidence: number } {
  if (!text) return { score: 0, confidence: 0 }

  const sdhTokenCount = (text.match(SDH_TOKEN_RE) || []).length
  const musicalMarkerCount = (text.match(/[♪♫]/g) || []).length
  const asciiLetterCount = (text.match(/[A-Za-z]/g) || []).length
  const cjkCount = (text.match(/[\u3400-\u9FFF]/g) || []).length
  const englishWordCount = (text.match(/\b[A-Za-z]{2,}\b/g) || []).length
  const commonEnglishWordCount = (text.match(STRONG_ENGLISH_WORD_RE) || []).length

  const totalLanguageChars = asciiLetterCount + cjkCount
  if (totalLanguageChars === 0 && englishWordCount === 0) {
    return { score: 0, confidence: 0 }
  }

  let score = 0
  score += Math.round((asciiLetterCount / Math.max(totalLanguageChars, 1)) * 100)
  score -= Math.round((cjkCount / Math.max(totalLanguageChars, 1)) * 120)
  score += Math.min(englishWordCount * 2, 24)
  score += Math.min(commonEnglishWordCount * 4, 24)
  score -= Math.min((sdhTokenCount + musicalMarkerCount) * 5, 20)

  if (asciiLetterCount >= 18 && cjkCount === 0) score += 20
  if (cjkCount >= 12 && asciiLetterCount === 0) score -= 20
  if (asciiLetterCount >= 10 && cjkCount >= 10) score -= 18
  else if (asciiLetterCount >= 8 && cjkCount >= 4) score -= 10

  let confidence = Math.min(totalLanguageChars + englishWordCount * 4, 100)
  if (asciiLetterCount >= 10 && cjkCount >= 10) confidence = Math.max(0, confidence - 30)
  else if (asciiLetterCount >= 8 && cjkCount >= 4) confidence = Math.max(0, confidence - 18)
  if (sdhTokenCount + musicalMarkerCount >= 2) confidence = Math.max(0, confidence - 12)
  if (englishWordCount <= 1 && commonEnglishWordCount === 0) confidence = Math.max(0, confidence - 10)

  return { score, confidence }
}
