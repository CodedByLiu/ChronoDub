# ChronoDub

A desktop app for generating Chinese subtitles and Chinese dubbing tracks from English-subtitled videos. See [简体中文](./README.zh-CN.md) for the Chinese version.

<p align="left">
  <img src="./src/renderer/public/logo.png" alt="ChronoDub Logo" width="180" />
</p>

<p align="left">
  <img src="./docs/image.png" alt="ChronoDub UI Screenshot" width="960" />
</p>

## Overview

ChronoDub combines subtitle parsing, DeepSeek translation, Edge TTS synthesis, and FFmpeg muxing into one Electron workflow.

It is designed around practical dubbing constraints:

- keep subtitle timing fixed
- keep speech inside the available subtitle window
- avoid overlap between adjacent voice segments
- preserve technical meaning while making Chinese narration read more naturally

This makes it suitable for tutorial videos, technical walkthroughs, and other narration-heavy content where timing and terminology both matter.

## Features

- Batch import multiple videos from the same folder.
- Auto-detect matching subtitle files such as `video.srt`, `video.en.srt`, `video_en.srt`, and `video-en.srt`.
- Parse `SRT`, `VTT`, and `ASS/SSA` subtitles.
- Translate subtitles with DeepSeek using segment-level translation.
- Keep terminology stable with a glossary and review the generated Chinese subtitles before dubbing.
- Generate Chinese dubbing with Edge TTS and preview voices in the app.
- Measure synthesized duration and apply timing-safe fallback strategies when a segment is too long.
- Pause, resume, cancel, and recover tasks after restart or sleep.
- Export dubbed videos together with generated Chinese subtitle files.

## Workflow

ChronoDub treats subtitle timestamps as hard anchors.

1. Import video files and detect matching subtitle files.
2. Parse subtitles and merge cues into synthesis-friendly timing segments.
3. Estimate text budgets from measured voice speed.
4. Translate each segment into natural, accurate Chinese.
5. Review or edit subtitles before starting dubbing.
6. Synthesize audio, measure actual duration, and retry with safe fallbacks when needed.
7. Assemble the final Chinese audio track and mux it back into the source video.

## Architecture

```mermaid
flowchart LR
  UI[Renderer UI]
  IPC[Preload IPC Bridge]
  PIPE[Pipeline Orchestrator]
  SUB[Subtitle Parser]
  DS[DeepSeek Translation]
  TTS[Edge TTS]
  AUD[Audio Processor]
  FFMPEG[FFmpeg Muxing]

  UI --> IPC
  IPC --> PIPE
  PIPE --> SUB
  PIPE --> DS
  PIPE --> TTS
  PIPE --> AUD
  PIPE --> FFMPEG
```

The app is split into three main parts:

- `renderer`: React UI for task management, subtitle review, and configuration.
- `preload`: IPC bridge that exposes safe APIs to the renderer.
- `main`: Electron services for subtitles, translation, TTS, audio timing, task persistence, and FFmpeg orchestration.

## Tech Stack

- Electron + `electron-vite`
- React 19 + TypeScript
- Zustand
- Tailwind CSS + Radix UI
- DeepSeek API
- `node-edge-tts`
- FFmpeg / FFprobe

## Requirements

Before running ChronoDub, make sure you have:

- Node.js 20 or newer
- npm
- `ffmpeg` and `ffprobe`
  - available in system `PATH` during development
  - or bundled under `resources/bin` in packaged builds
- a valid DeepSeek API key
- network access for DeepSeek and Edge TTS

## Installation

### Build From Source

```bash
git clone https://github.com/CodedByLiu/ChronoDub.git
cd ChronoDub
npm install
```

### Start Development Mode

```bash
npm run dev
```

### Build Production Bundles

```bash
npm run build
```

## Packaging

Build a distributable package for your platform:

```bash
npm run dist
```

Platform-specific commands:

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
```

Artifacts are written to:

```text
release/<version>/
```

## Available Scripts

```bash
# Start the development server and Electron
npm run dev

# Build main, preload, and renderer bundles
npm run build

# Preview the production build locally
npm run preview

# Run lint checks
npm run lint

# Auto-fix lint issues
npm run lint:fix

# Format the repository
npm run format

# Check formatting
npm run format:check

# Package the app
npm run dist
```

## Output Layout

For an input video named `MyVideo.mp4`, ChronoDub writes:

```text
<outputDir>/MyVideo/
  MyVideo.mp4
  MyVideo.srt
```

## Project Structure

```text
src/
├─ components/   React UI components
├─ hooks/        UI hooks
├─ lib/          Frontend utilities
├─ main/         Electron main process and backend services
├─ preload/      IPC bridge
├─ renderer/     Renderer entry and static assets
├─ stores/       Zustand state management
└─ types/        Shared type definitions
docs/
├─ chronodub.md  Research and architecture notes
└─ image.png     Application screenshot
scripts/
├─ generate-mac-icon.sh
└─ generate-win-icon.mjs
```

## Troubleshooting

- If subtitle auto-detection fails, confirm the subtitle file is next to the video and uses a supported naming pattern.
- If translation fails, verify the DeepSeek API key and API connectivity.
- If TTS fails, check network access and test the configured Edge voice in the app first.
- If muxing fails, confirm `ffmpeg` and `ffprobe` are installed and discoverable.
- If a task was interrupted by system sleep, reopen the app and resume it from the task list.

## Contributing

Issues and pull requests are welcome.

## License

No license file is included yet.
