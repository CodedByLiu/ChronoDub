import type { ConcurrencyOption, SubtitleOutputMode, SubtitlePosition } from '../../types'

export const VOICE_CN_NAMES: Record<string, string> = {
  'zh-CN-XiaoxiaoNeural': '晓晓',
  'zh-CN-XiaoyiNeural': '晓伊',
  'zh-CN-YunjianNeural': '云健',
  'zh-CN-YunxiNeural': '云希',
  'zh-CN-YunxiaNeural': '云夏',
  'zh-CN-YunyangNeural': '云扬',
  'zh-CN-XiaochenNeural': '晓辰',
  'zh-CN-XiaohanNeural': '晓涵',
  'zh-CN-XiaomengNeural': '晓梦',
  'zh-CN-XiaomoNeural': '晓墨',
  'zh-CN-XiaoruiNeural': '晓睿',
  'zh-CN-XiaoshuangNeural': '晓双',
  'zh-CN-XiaoxuanNeural': '晓萱',
  'zh-CN-XiaoyanNeural': '晓颜',
  'zh-CN-XiaozhenNeural': '晓甄',
  'zh-CN-YunfengNeural': '云枫',
  'zh-CN-YunhaoNeural': '云皓',
  'zh-CN-YunzeNeural': '云泽',
  'zh-CN-liaoning-XiaobeiNeural': '晓北（辽宁）',
  'zh-CN-shaanxi-XiaoniNeural': '晓妮（陕西）',
}

export const CONCURRENCY_LABELS: Record<ConcurrencyOption, string> = {
  2: '2 个任务，同时处理更稳',
  4: '4 个任务，均衡速度和占用',
  6: '6 个任务，适合较高配置',
  8: '8 个任务，仅建议高配机器',
}

export const SUBTITLE_OUTPUT_MODE_LABELS: Record<SubtitleOutputMode, string> = {
  external: '生成字幕文件',
  burned: '硬嵌字幕',
}

export const SUBTITLE_POSITION_LABELS: Record<SubtitlePosition, string> = {
  'top-safe': '顶部安全区',
  'bottom-safe': '底部安全区',
}

export const PREFERRED_SUBTITLE_FONTS = [
  'Noto Sans CJK SC',
  'Source Han Sans SC',
  'Microsoft YaHei',
  'PingFang SC',
  'Heiti SC',
  'Arial',
] as const

export const FALLBACK_SUBTITLE_FONTS = ['Arial'] as const

export type SubtitleNumberField =
  | 'fontSize'
  | 'outlineWidth'
  | 'backgroundOpacity'
  | 'backgroundPadding'
  | 'safeMargin'

export const SUBTITLE_NUMBER_LIMITS: Record<SubtitleNumberField, { min: number; max: number }> = {
  fontSize: { min: 20, max: 120 },
  outlineWidth: { min: 0, max: 12 },
  backgroundOpacity: { min: 0, max: 100 },
  backgroundPadding: { min: 0, max: 24 },
  safeMargin: { min: 24, max: 240 },
}
