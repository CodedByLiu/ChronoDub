# ChronoDub

[English](./README.md) | [简体中文](./README.zh-CN.md)

<p align="left">
  <img src="./src/renderer/public/logo.png" alt="ChronoDub Logo" width="180" />
</p>

ChronoDub is a desktop app (Electron + React + TypeScript) for generating Chinese dubbing tracks from English videos and subtitle files.

It translates subtitle cues with DeepSeek, synthesizes speech with Edge TTS, and muxes the dubbed audio back into the source video via FFmpeg.

## Features

- Import one or more videos in batch.
- Auto-detect or manually select subtitle files.
- Supports subtitle parsing from `SRT`, `VTT`, and `ASS/SSA`.
- DeepSeek-powered English-to-Chinese subtitle translation.
- Terminology dictionary to enforce fixed translations.
- Edge TTS Chinese voice synthesis with voice test.
- Review checkpoint before synthesis:
  - `Auto` mode: countdown-based review.
  - `Manual` mode: explicit confirm to continue.
- Pause/resume/cancel task pipeline.
- Task snapshot persistence and recovery across app restarts/sleep.
- Output both:
  - dubbed video
  - generated Chinese `.srt`

## Pipeline

1. Parse subtitle cues.
2. Segment and assign character budgets.
3. Translate cues with DeepSeek.
4. Review and edit translated cues.
5. Synthesize Chinese speech with Edge TTS.
6. Assemble WAV and mux into original video using FFmpeg.
7. Export dubbed video + Chinese subtitle.

## Tech Stack

- Electron + electron-vite
- React 19 + TypeScript
- Zustand
- Tailwind CSS + Radix UI
- DeepSeek API
- node-edge-tts
- FFmpeg / FFprobe

## Requirements

- Node.js 20+ (recommended)
- npm
- FFmpeg and FFprobe available:
  - In development: installed in system `PATH`
  - In packaged app: place binaries under `resources/bin`
- A valid DeepSeek API key
- Network access (DeepSeek + Edge TTS)

## Quick Start

```bash
npm install
npm run dev
```

Build app bundles:

```bash
npm run build
```

## Packaging

Mac package:

```bash
npm run dist:mac
```

Windows package:

```bash
npm run dist:win
```

Linux package:

```bash
npm run dist:linux
```

Artifacts are generated under:

```text
release/<version>/
```

## Available Scripts

- `npm run dev` - start Electron + renderer dev server
- `npm run build` - build main/preload/renderer
- `npm run lint` - run ESLint
- `npm run lint:fix` - run ESLint with autofix
- `npm run format` - run Prettier write
- `npm run format:check` - run Prettier check
- `npm run dist` - build and package with electron-builder
- `npm run dist:mac` - package macOS app (zip)
- `npm run dist:win` - package Windows installer (nsis)
- `npm run dist:linux` - package Linux AppImage

## Output Structure

For input video `MyVideo.mp4`, output directory is:

```text
<outputDir>/MyVideo/
  ├─ MyVideo.mp4    # dubbed video
  └─ MyVideo.srt    # generated Chinese subtitles
```

## Project Structure

```text
src/
  main/         # Electron main process, pipeline, ffmpeg/deepseek/tts services
  preload/      # IPC bridge
  components/   # React UI components
  stores/       # Zustand state store
  renderer/     # Renderer entry and static assets
scripts/
  generate-mac-icon.sh
  generate-win-icon.mjs
```

## Troubleshooting

- If packaging uses a default app icon, ensure icon generation runs before packaging.
- If audio/video mux fails, verify `ffmpeg` and `ffprobe` are available.
- If translation fails, verify DeepSeek API key and network connectivity.
- If tasks pause after system sleep, use Resume in the task table.

## Contributing

Issues and pull requests are welcome.

## License

No license file is included yet.
