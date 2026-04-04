import { useEffect, useRef, useState } from 'react'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { cn } from '../lib/utils'

interface FontComboboxProps {
  fonts: string[]
  value: string
  onChange: (value: string) => void
  preferredFonts?: readonly string[]
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function buildSearchParts(font: string): string[] {
  const aliases = font.split(/\s*&\s*/).map((value) => value.trim()).filter(Boolean)
  const parts = new Set<string>()

  for (const alias of aliases) {
    const normalizedAlias = normalizeSearchText(alias)
    if (!normalizedAlias) continue

    parts.add(normalizedAlias)

    for (const word of normalizedAlias.split(/[\s-]+/)) {
      if (word) parts.add(word)
    }
  }

  return Array.from(parts)
}

function getFontMatchScore(font: string, query: string): number {
  if (!query) return 0

  const parts = buildSearchParts(font)
  let bestScore = -1

  for (const part of parts) {
    if (part === query) bestScore = Math.max(bestScore, 400)
    else if (part.startsWith(query)) bestScore = Math.max(bestScore, 300 - part.length)
    else if (part.includes(query)) bestScore = Math.max(bestScore, 200 - part.indexOf(query))
  }

  return bestScore
}

export function FontCombobox({
  fonts,
  value,
  onChange,
  preferredFonts = [],
}: FontComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const normalizedQuery = normalizeSearchText(query)
  const preferredSet = new Set(preferredFonts.map((font) => normalizeSearchText(font)))

  const filteredFonts = fonts
    .map((font, index) => ({
      font,
      index,
      score: getFontMatchScore(font, normalizedQuery),
      preferred: preferredSet.has(normalizeSearchText(font)),
      selected: normalizeSearchText(font) === normalizeSearchText(value),
    }))
    .filter((item) => !normalizedQuery || item.score >= 0)
    .sort((left, right) => {
      if (normalizedQuery && left.score !== right.score) return right.score - left.score
      if (!normalizedQuery && left.selected !== right.selected) return left.selected ? -1 : 1
      if (!normalizedQuery && left.preferred !== right.preferred) return left.preferred ? -1 : 1
      return left.index - right.index
    })
    .slice(0, 120)

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }

    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [open])

  const selectedFont = value || fonts[0] || 'Arial'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="truncate text-left">{selectedFont}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && filteredFonts[0]) {
                  event.preventDefault()
                  onChange(filteredFonts[0].font)
                  setOpen(false)
                }
              }}
              placeholder="输入字体名搜索，如 yahei"
              className="pl-8"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto overscroll-contain p-1">
          {filteredFonts.length > 0 ? (
            filteredFonts.map((item) => (
              <button
                key={item.font}
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground',
                  item.selected && 'bg-accent/60'
                )}
                onClick={() => {
                  onChange(item.font)
                  setOpen(false)
                }}
              >
                <Check
                  className={cn(
                    'size-4 shrink-0 text-primary transition-opacity',
                    item.selected ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className="min-w-0 truncate">{item.font}</span>
              </button>
            ))
          ) : (
            <div className="px-2 py-3 text-sm text-muted-foreground">没有匹配的字体</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
