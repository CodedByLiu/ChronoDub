export { getFFmpegPath, getFFprobePath } from './ffmpeg-binary'
export { ffprobe, resolveDisplaySize, type ProbeResult } from './ffmpeg-probe'
export {
  decodeMp3ToPcm,
  measurePcmDurationUs,
  trimSilence,
  trimSilenceDetailed,
  writePcmToWav,
  type TrimSilenceResult,
} from './ffmpeg-audio'
export { burnSubtitlesIntoVideo, muxVideoWithAudio } from './ffmpeg-video'
