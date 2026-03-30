export type MicrosecondTimestamp = number

export type TaskStatus =
  | 'waiting'
  | 'parsing'
  | 'translating'
  | 'reviewing'
  | 'synthesizing'
  | 'assembling'
  | 'encoding'
  | 'completed'
  | 'error'
  | 'paused'

export type ReviewMode = 'auto' | 'manual'

export interface Cue {
  id: number
  startUs: MicrosecondTimestamp
  endUs: MicrosecondTimestamp
  text: string
  rawStyle?: string
}

export interface Segment {
  id: number
  cueIds: number[]
  startUs: MicrosecondTimestamp
  endUs: MicrosecondTimestamp
  textEn: string
  textZh?: string
}

export interface TimeWindow {
  segmentId: number
  startUs: MicrosecondTimestamp
  deadlineUs: MicrosecondTimestamp
  windowUs: MicrosecondTimestamp
  budgetChars: number
}

export interface VideoTask {
  id: string
  videoPath: string
  videoName: string
  subtitlePath: string | null
  status: TaskStatus
  progress: number
  countdownRemaining?: number
  error?: string
  englishCues?: Cue[]
  chineseCues?: Cue[]
}

export interface AppConfig {
  deepseekKey: string
  dictionary: Array<{ en: string; zh: string }>
  selectedVoice: string
  outputDir: string
  reviewMode: ReviewMode
  autoReviewCountdown: number
}

export const DEFAULT_CONFIG: AppConfig = {
  deepseekKey: '',
  dictionary: [],
  selectedVoice: '',
  outputDir: '',
  reviewMode: 'auto',
  autoReviewCountdown: 30,
}

export const TASK_STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  waiting: { label: '等待中', color: 'gray' },
  parsing: { label: '解析中', color: 'blue' },
  translating: { label: '翻译中', color: 'purple' },
  reviewing: { label: '待审校', color: 'amber' },
  synthesizing: { label: '合成中', color: 'orange' },
  assembling: { label: '装配中', color: 'cyan' },
  encoding: { label: '封装中', color: 'indigo' },
  completed: { label: '已完成', color: 'green' },
  error: { label: '失败', color: 'red' },
  paused: { label: '已暂停', color: 'yellow' },
}

export interface TaskStartInfo {
  id: string
  videoPath: string
  subtitlePath: string | null
}

export interface DeepseekTestResult {
  ok: boolean
  message?: string
}

export interface IpcApi {
  /** 顶层方法，避免嵌套 dialog 在旧 preload 中缺失 */
  openSubtitlePicker: (defaultDir?: string | null) => Promise<string | null>
  /** 拖入文件的真实路径（preload webUtils） */
  filePathFromDragFile: (file: File) => string
  config: {
    load: () => Promise<AppConfig>
    save: (config: AppConfig) => Promise<void>
  }
  deepseek: {
    testKey: (apiKey: string) => Promise<DeepseekTestResult>
  }
  dialog: {
    openVideos: () => Promise<string[]>
    openOutput: () => Promise<string | null>
    openSubtitle: (defaultDir?: string | null) => Promise<string | null>
  }
  tts: {
    getVoices: () => Promise<Array<{ name: string; locale: string; gender: string }>>
    testVoice: (voice: string) => Promise<ArrayBuffer>
  }
  subtitle: {
    parse: (filePath: string) => Promise<Cue[]>
    save: (filePath: string, cues: Cue[]) => Promise<void>
    detect: (videoPath: string) => Promise<string | null>
    pathFromFile: (file: File) => string
  }
  task: {
    loadSnapshot: () => Promise<VideoTask[]>
    saveSnapshot: (tasks: VideoTask[]) => Promise<void>
    start: (tasks: TaskStartInfo[]) => void
    pause: (taskId: string) => void
    resume: (taskId: string) => void
    cancel: (taskId: string) => void
    cancelAll: (taskIds: string[]) => void
    saveReview: (taskId: string, cues: Cue[]) => void
    confirmReview: (taskId: string, cues: Cue[]) => void
    onProgress: (
      callback: (taskId: string, status: TaskStatus, progress: number) => void
    ) => () => void
    onReviewCountdown: (callback: (taskId: string, remaining: number) => void) => () => void
    onReviewReady: (
      callback: (taskId: string, englishCues: Cue[], chineseCues: Cue[]) => void
    ) => () => void
    onError: (callback: (taskId: string, message: string) => void) => () => void
  }
}

declare global {
  interface Window {
    api: IpcApi
  }
}
