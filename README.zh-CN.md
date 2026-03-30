# ChronoDub

[English](./README.md) | [简体中文](./README.zh-CN.md)

<p align="left">
  <img src="./src/renderer/public/logo.png" alt="ChronoDub Logo" width="180" />
</p>

ChronoDub 是一个桌面应用（Electron + React + TypeScript），用于根据英文视频与字幕文件生成中文字幕配音。

它使用 DeepSeek 翻译字幕，使用 Edge TTS 合成中文语音，并通过 FFmpeg 将配音音轨封装回原视频。

## 界面预览

<p align="left">
  <img src="./docs/image.png" alt="ChronoDub 界面截图" width="960" />
</p>

## 功能特性

- 支持批量导入视频。
- 自动检测或手动选择字幕文件。
- 支持 `SRT`、`VTT`、`ASS/SSA` 字幕解析。
- 基于 DeepSeek 的英译中字幕翻译。
- 支持术语词典（固定翻译）。
- Edge TTS 中文音色合成（含试听）。
- 合成前字幕审校：
  - `自动模式`：倒计时后继续。
  - `手动模式`：手动确认后继续。
- 支持任务暂停 / 继续 / 取消。
- 支持任务快照持久化，应用重启或休眠后可恢复。
- 输出内容包括：
  - 配音后视频
  - 中文字幕 `.srt`

## 处理流程

1. 解析字幕 cue。
2. 分段并分配字符预算。
3. 调用 DeepSeek 翻译。
4. 进入审校编辑。
5. 使用 Edge TTS 合成中文语音。
6. 组装 WAV，并通过 FFmpeg 封装回原视频。
7. 导出配音视频与中文字幕。

## 技术栈

- Electron + electron-vite
- React 19 + TypeScript
- Zustand
- Tailwind CSS + Radix UI
- DeepSeek API
- node-edge-tts
- FFmpeg / FFprobe

## 环境要求

- Node.js 20+（推荐）
- npm
- FFmpeg / FFprobe 可用：
  - 开发环境：系统 `PATH` 中可找到
  - 打包环境：可放到 `resources/bin`
- 有效的 DeepSeek API Key
- 可访问外网（DeepSeek + Edge TTS）

## 快速开始

```bash
npm install
npm run dev
```

构建产物：

```bash
npm run build
```

## 打包

macOS 打包：

```bash
npm run dist:mac
```

Windows 打包：

```bash
npm run dist:win
```

Linux 打包：

```bash
npm run dist:linux
```

打包输出目录：

```text
release/<version>/
```

## 可用脚本

- `npm run dev` - 启动 Electron + 渲染进程开发环境
- `npm run build` - 构建 main / preload / renderer
- `npm run lint` - 执行 ESLint
- `npm run lint:fix` - ESLint 自动修复
- `npm run format` - Prettier 写入格式化
- `npm run format:check` - Prettier 检查
- `npm run dist` - 构建并使用 electron-builder 打包
- `npm run dist:mac` - 打包 macOS（zip）
- `npm run dist:win` - 打包 Windows（nsis）
- `npm run dist:linux` - 打包 Linux（AppImage）

## 输出结构

输入视频例如 `MyVideo.mp4`，输出目录结构为：

```text
<outputDir>/MyVideo/
  ├─ MyVideo.mp4    # 配音后视频
  └─ MyVideo.srt    # 生成的中文字幕
```

## 项目结构

```text
src/
  main/         # Electron 主进程、pipeline、ffmpeg/deepseek/tts 服务
  preload/      # IPC 桥接
  components/   # React 组件
  stores/       # Zustand 状态管理
  renderer/     # 渲染进程入口与静态资源
scripts/
  generate-mac-icon.sh
  generate-win-icon.mjs
```

## 常见问题

- 打包后图标不对：确认打包前已执行图标生成脚本。
- 音视频封装失败：确认 `ffmpeg` 与 `ffprobe` 可用。
- 翻译失败：检查 DeepSeek Key 与网络连接。
- 系统休眠后任务暂停：在任务表点击“继续”即可。

## 贡献

欢迎提交 Issue 和 PR。

## 许可证

当前仓库尚未提供 License 文件。
