export type MicrosecondTimestamp = number

export type TaskStatus =
  | 'waiting'
  | 'queued'
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
export type ConcurrencyOption = 2 | 4 | 6 | 8
export type SubtitleOutputMode = 'external' | 'burned'
export type SubtitlePosition = 'top-safe' | 'bottom-safe'

export const CONCURRENCY_OPTIONS: ConcurrencyOption[] = [2, 4, 6, 8]

export interface SubtitleStyleConfig {
  fontFamily: string
  fontSize: number
  bold: boolean
  italic: boolean
  textColor: string
  outlineEnabled: boolean
  outlineWidth: number
  outlineColor: string
  backgroundEnabled: boolean
  backgroundColor: string
  backgroundOpacity: number
  backgroundPadding: number
  position: SubtitlePosition
  safeMargin: number
}

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
  detail?: string
  statusUpdatedAt?: number
  countdownRemaining?: number
  error?: string
  errorDetail?: string
  englishCues?: Cue[]
  chineseCues?: Cue[]
}

export interface AppConfig {
  deepseekKey: string
  dictionary: Array<{ en: string; zh: string }>
  selectedVoice: string
  outputDir: string
  createVideoSubfolder: boolean
  subtitleOutputMode: SubtitleOutputMode
  subtitleStyle: SubtitleStyleConfig
  reviewMode: ReviewMode
  autoReviewCountdown: number
  maxConcurrentTasks: ConcurrencyOption
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyleConfig = {
  fontFamily: '',
  fontSize: 42,
  bold: false,
  italic: false,
  textColor: '#FFFFFF',
  outlineEnabled: false,
  outlineWidth: 3,
  outlineColor: '#000000',
  backgroundEnabled: true,
  backgroundColor: '#000000',
  backgroundOpacity: 70,
  backgroundPadding: 6,
  position: 'bottom-safe',
  safeMargin: 72,
}

export const DEFAULT_CONFIG: AppConfig = {
  deepseekKey: '',
  dictionary: [],
  selectedVoice: '',
  outputDir: '',
  createVideoSubfolder: true,
  subtitleOutputMode: 'external',
  subtitleStyle: DEFAULT_SUBTITLE_STYLE,
  reviewMode: 'auto',
  autoReviewCountdown: 30,
  maxConcurrentTasks: 2,
}

export const TASK_STATUS_META: Record<TaskStatus, { label: string; color: string }> = {
  waiting: { label: '等待中', color: 'gray' },
  queued: { label: '排队中', color: 'slate' },
  parsing: { label: '解析中', color: 'blue' },
  translating: { label: '翻译中', color: 'purple' },
  reviewing: { label: '待审核', color: 'amber' },
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
  openSubtitlePicker: (defaultDir?: string | null) => Promise<string | null>
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
    listFonts: () => Promise<string[]>
    pathFromFile: (file: File) => string
  }
  task: {
    loadSnapshot: () => Promise<VideoTask[]>
    loadCues: (taskId: string) => Promise<{ englishCues?: Cue[]; chineseCues?: Cue[] } | null>
    register: (tasks: VideoTask[]) => void
    updateSubtitlePath: (taskId: string, subtitlePath: string) => void
    replaceSubtitlePath: (taskId: string, subtitlePath: string) => void
    start: (tasks: TaskStartInfo[], config: AppConfig) => void
    pauseAll: () => void
    resumeAll: (taskIds: string[], config: AppConfig) => void
    pause: (taskId: string) => void
    resume: (taskId: string, config: AppConfig) => void
    cancel: (taskId: string) => void
    cancelAll: (taskIds: string[]) => void
    saveReview: (taskId: string, cues: Cue[]) => void
    confirmReview: (taskId: string, cues: Cue[]) => void
    onProgress: (
      callback: (taskId: string, status: TaskStatus, progress: number, detail?: string) => void
    ) => () => void
    onReviewCountdown: (callback: (taskId: string, remaining: number) => void) => () => void
    onReviewReady: (
      callback: (taskId: string, englishCues: Cue[], chineseCues: Cue[]) => void
    ) => () => void
    onCuesUpdated: (
      callback: (taskId: string, englishCues?: Cue[], chineseCues?: Cue[]) => void
    ) => () => void
    onError: (callback: (taskId: string, message: string, detail?: string) => void) => () => void
  }
}

declare global {
  interface Window {
    api: IpcApi
  }
}
