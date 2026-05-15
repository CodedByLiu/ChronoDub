import type { TaskStatus } from '../../types'

type ErrorArea =
  | '字幕翻译'
  | '语音合成'
  | '音频拼接'
  | '视频封装'
  | '字幕解析'
  | '视频分析'
  | '视频处理'
  | '处理过程'

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() || ''
}

function collectErrorText(err: unknown, seen = new Set<unknown>()): string[] {
  if (err == null || seen.has(err)) return []

  if (typeof err === 'string') {
    const text = firstLine(err)
    return text ? [text] : []
  }
  if (typeof err !== 'object') return []

  seen.add(err)
  const parts: string[] = []
  const record = err as {
    message?: unknown
    code?: unknown
    syscall?: unknown
    address?: unknown
    port?: unknown
    cause?: unknown
    errors?: unknown
  }

  if (typeof record.message === 'string') parts.push(firstLine(record.message))
  if (typeof record.code === 'string') parts.push(record.code)
  if (typeof record.syscall === 'string') parts.push(record.syscall)
  if (typeof record.address === 'string') parts.push(record.address)
  if (typeof record.port === 'number') parts.push(String(record.port))
  if (record.cause !== undefined) parts.push(...collectErrorText(record.cause, seen))
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) {
      parts.push(...collectErrorText(item, seen))
    }
  }

  return parts.filter(Boolean)
}

export function extractTaskErrorDetail(err: unknown): string | undefined {
  const uniqueParts = Array.from(new Set(collectErrorText(err).map((item) => item.trim()).filter(Boolean)))
  if (uniqueParts.length === 0) return undefined
  const detail = uniqueParts.join(' | ')
  return detail.length > 500 ? `${detail.slice(0, 497)}...` : detail
}

function extractLLMStatus(text: string): number | null {
  const match = text.match(/llm api\s+(\d{3})/i)
  return match ? Number(match[1]) : null
}

function inferErrorArea(status: TaskStatus | undefined, haystack: string, rawMessage: string): ErrorArea {
  if (status === 'translating' || /llm|translation|chat\/completions/i.test(haystack)) {
    return '字幕翻译'
  }
  if (status === 'synthesizing' || /tts|speech\.platform\.bing\.com|readaloud|websocket/i.test(haystack)) {
    return '语音合成'
  }
  if (status === 'assembling') return '音频拼接'
  if (status === 'encoding') return '视频封装'
  if (status === 'parsing' || /subtitle|srt|ass|vtt/i.test(rawMessage)) return '字幕解析'
  if (/ffprobe/i.test(rawMessage)) return '视频分析'
  if (/ffmpeg/i.test(rawMessage)) return '视频处理'
  return '处理过程'
}

function formatTaskError(area: ErrorArea, reason: string, action?: string): string {
  return action ? `${area}：${reason}。${action}` : `${area}：${reason}`
}

function networkAreaName(area: ErrorArea): string {
  if (area === '字幕翻译') return '翻译服务'
  if (area === '语音合成') return '语音合成服务'
  return area
}

export function normalizeTaskError(err: unknown, status?: TaskStatus): string {
  const signals = collectErrorText(err)
  const haystack = signals.join(' | ').toLowerCase()
  const rawMessage = signals.find((item) => item && !/^(aggregateerror|error)$/i.test(item)) || ''
  const llmStatus = extractLLMStatus(rawMessage)
  const area = inferErrorArea(status, haystack, rawMessage)
  const serviceName = networkAreaName(area)

  if (haystack.includes('etimedout') || haystack.includes('timed out') || /超时/.test(rawMessage)) {
    if (area === '字幕翻译' || area === '语音合成') {
      return formatTaskError(area, '连接超时', '请检查网络后重试')
    }
    return formatTaskError(area, '处理超时', '请稍后重试')
  }

  if (haystack.includes('enotfound') || haystack.includes('eai_again') || haystack.includes('getaddrinfo')) {
    return formatTaskError(area, `无法连接${serviceName}`, '请检查网络或 DNS')
  }

  if (
    haystack.includes('econnrefused') ||
    haystack.includes('econnreset') ||
    haystack.includes('network error') ||
    haystack.includes('fetch failed') ||
    haystack.includes('socket hang up') ||
    haystack.includes('proxy')
  ) {
    return formatTaskError(area, `无法连接${serviceName}`, '请检查网络或代理')
  }

  if (llmStatus === 401 || /invalid api key|unauthorized|authentication/i.test(rawMessage)) {
    return formatTaskError('字幕翻译', 'LLM API Key 无效', '请检查配置')
  }
  if (llmStatus === 403 || /forbidden/i.test(rawMessage)) {
    return formatTaskError('字幕翻译', 'LLM 请求被拒绝', '请检查权限或网络环境')
  }
  if (llmStatus === 429 || /too many requests|rate limit/i.test(rawMessage)) {
    return formatTaskError('字幕翻译', 'LLM 请求过于频繁', '请稍后重试')
  }
  if ((llmStatus !== null && llmStatus >= 500) || /bad gateway|service unavailable|gateway timeout/i.test(rawMessage)) {
    return formatTaskError(area === '语音合成' ? '语音合成' : '字幕翻译', '服务暂时不可用', '请稍后重试')
  }

  if (/未选择 TTS 声音/i.test(rawMessage)) return formatTaskError('语音合成', '未选择 TTS 声音', '请先在配置面板中选择语音')
  if (/未填写?\s*LLM\s*(?:Base URL|模型|API Key)/i.test(rawMessage)) return formatTaskError('字幕翻译', '未完成 LLM 配置', '请先在配置面板中完成配置')
  if (/未选择输出目录/i.test(rawMessage)) return formatTaskError('视频封装', '未选择输出目录', '请先设置输出目录')
  if (/subtitle|字幕.*解析/i.test(rawMessage)) return formatTaskError('字幕解析', '字幕文件无效或解析失败', '请检查字幕格式')
  if (/ffmpeg|ffprobe/i.test(rawMessage) && /enoent|not recognized|not found/i.test(rawMessage)) {
    return formatTaskError('视频处理', '未找到 FFmpeg/FFprobe', '请确认已安装并加入 PATH')
  }
  if (/ffprobe/i.test(rawMessage)) return formatTaskError('视频分析', '分析失败', '请检查视频文件或 FFprobe')
  if (/ffmpeg/i.test(rawMessage)) return formatTaskError(area === '视频封装' ? '视频封装' : '视频处理', '处理失败', '请检查视频文件或 FFmpeg')
  if (/aborterror|aborted/i.test(haystack)) return formatTaskError(area, '请求超时', '请稍后重试')
  if (!rawMessage || /^aggregateerror$/i.test(rawMessage)) return formatTaskError(area, '失败', '请查看日志')
  return formatTaskError(area, rawMessage)
}
