import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const FALLBACK_FONTS = [
  'Noto Sans CJK SC',
  'Source Han Sans SC',
  'Microsoft YaHei',
  'PingFang SC',
  'Heiti SC',
  'Arial',
] as const

const WINDOWS_REGISTRY_PATHS = [
  'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
] as const

let cachedFonts: string[] | null = null

function normalizeFontName(value: string): string {
  return value
    .replace(/\s*\(.*?\)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitFontAliases(value: string): string[] {
  return value
    .split(/\s*&\s*/)
    .map(normalizeFontName)
    .filter(Boolean)
}

export function normalizeFontEntries(fonts: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const font of fonts) {
    for (const alias of splitFontAliases(font)) {
      const key = alias.toLocaleLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(alias)
    }
  }

  return unique.sort((a, b) => a.localeCompare(b))
}

async function listWindowsFonts(): Promise<string[]> {
  const command = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $paths = @(${WINDOWS_REGISTRY_PATHS.map((path) => `'${path}'`).join(', ')})
    $ignore = @('PSPath', 'PSParentPath', 'PSChildName', 'PSDrive', 'PSProvider')
    $names = foreach ($path in $paths) {
      if (-not (Test-Path $path)) { continue }
      $item = Get-ItemProperty -Path $path
      foreach ($prop in $item.PSObject.Properties) {
        if ($ignore -contains $prop.Name) { continue }
        $prop.Name
      }
    }
    $names | ConvertTo-Json -Compress
  `

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      }
    )

    const normalizedOutput = stdout.replace(/^\uFEFF/, '').trim()
    const parsed = normalizedOutput ? JSON.parse(normalizedOutput) : []
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string')
    }
    return typeof parsed === 'string' ? [parsed] : []
  } catch {
    return []
  }
}

async function listMacFonts(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('system_profiler', ['SPFontsDataType', '-json'])
    const parsed = JSON.parse(stdout)
    const entries = Array.isArray(parsed?.SPFontsDataType) ? parsed.SPFontsDataType : []
    return entries
      .map((entry: Record<string, unknown>) =>
        typeof entry.family === 'string'
          ? entry.family
          : typeof entry._name === 'string'
            ? entry._name
            : ''
      )
      .filter(Boolean)
  } catch {
    return []
  }
}

async function listLinuxFonts(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('fc-list', [':', 'family'])
    return stdout
      .split(/\r?\n/)
      .flatMap((line) => line.split(','))
      .map((value) => value.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export async function listSystemFonts(): Promise<string[]> {
  if (cachedFonts) return [...cachedFonts]

  let fonts: string[] = []

  if (process.platform === 'win32') {
    fonts = await listWindowsFonts()
  } else if (process.platform === 'darwin') {
    fonts = await listMacFonts()
  } else {
    fonts = await listLinuxFonts()
  }

  cachedFonts = normalizeFontEntries([...fonts, ...FALLBACK_FONTS])
  return [...cachedFonts]
}

export function resetFontCache(): void {
  cachedFonts = null
}
