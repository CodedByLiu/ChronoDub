import { Eye, EyeOff, FlaskConical } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

interface ApiKeySectionProps {
  deepseekKey: string
  showKey: boolean
  testing: boolean
  hint: { ok: boolean; text: string } | null
  onChangeKey: (value: string) => void
  onToggleShowKey: () => void
  onTest: () => void
}

export function ApiKeySection({
  deepseekKey,
  showKey,
  testing,
  hint,
  onChangeKey,
  onToggleShowKey,
  onTest,
}: ApiKeySectionProps) {
  return (
    <div className="space-y-2">
      <Label>DeepSeek API Key</Label>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            type={showKey ? 'text' : 'password'}
            placeholder="sk-..."
            value={deepseekKey}
            onChange={(event) => onChangeKey(event.target.value)}
            className="pr-10"
            autoComplete="off"
            spellCheck={false}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="absolute right-1 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={onToggleShowKey}
                aria-label={showKey ? '隐藏密钥' : '显示密钥'}
              >
                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{showKey ? '隐藏明文' : '显示明文'}</TooltipContent>
          </Tooltip>
        </div>
        <Button
          type="button"
          variant="outline"
          size="default"
          className="shrink-0 px-3"
          disabled={!deepseekKey.trim() || testing}
          onClick={onTest}
        >
          <FlaskConical className="size-3.5" />
          {testing ? '测试中...' : '测试'}
        </Button>
      </div>
      {hint && <p className={`text-xs ${hint.ok ? 'text-green-600' : 'text-red-500'}`}>{hint.text}</p>}
    </div>
  )
}
