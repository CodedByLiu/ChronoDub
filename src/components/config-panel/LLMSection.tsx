import { Eye, EyeOff, FlaskConical } from 'lucide-react'
import type { LLMConfig } from '../../types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

interface LLMSectionProps {
  llm: LLMConfig
  showKey: boolean
  testing: boolean
  hint: { ok: boolean; text: string } | null
  onChangeLLM: (partial: Partial<LLMConfig>) => void
  onToggleShowKey: () => void
  onTest: () => void
}

export function LLMSection({
  llm,
  showKey,
  testing,
  hint,
  onChangeLLM,
  onToggleShowKey,
  onTest,
}: LLMSectionProps) {
  const canTest =
    !!llm.baseUrl.trim() && !!llm.model.trim() && !!llm.apiKey.trim() && !testing

  return (
    <div className="space-y-3">
      <Label>LLM 服务（OpenAI 兼容）</Label>

      <div className="space-y-1.5">
        <Label className="text-xs font-normal text-muted-foreground">Base URL</Label>
        <Input
          type="text"
          placeholder="https://api.deepseek.com/v1"
          value={llm.baseUrl}
          onChange={(event) => onChangeLLM({ baseUrl: event.target.value })}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-normal text-muted-foreground">Model</Label>
        <Input
          type="text"
          placeholder="deepseek-chat"
          value={llm.model}
          onChange={(event) => onChangeLLM({ model: event.target.value })}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-normal text-muted-foreground">API Key</Label>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Input
              type={showKey ? 'text' : 'password'}
              placeholder="sk-..."
              value={llm.apiKey}
              onChange={(event) => onChangeLLM({ apiKey: event.target.value })}
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
            disabled={!canTest}
            onClick={onTest}
          >
            <FlaskConical className="size-3.5" />
            {testing ? '测试中...' : '测试'}
          </Button>
        </div>
      </div>

      {hint && <p className={`text-xs ${hint.ok ? 'text-green-600' : 'text-red-500'}`}>{hint.text}</p>}
    </div>
  )
}
