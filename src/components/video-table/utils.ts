import type { DragEvent } from 'react'

export function videoDir(videoPath: string): string {
  const index = Math.max(videoPath.lastIndexOf('/'), videoPath.lastIndexOf('\\'))
  return index >= 0 ? videoPath.slice(0, index) : ''
}

export function pathFromFileUriInDrag(event: DragEvent): string {
  const raw = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
  const line = raw?.trim().split('\n')[0]?.trim()
  if (!line?.toLowerCase().startsWith('file:')) return ''

  try {
    const url = new URL(line.split('#')[0])
    let path = decodeURIComponent(url.pathname.replace(/\+/g, '%20'))
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
    return path
  } catch {
    return ''
  }
}
