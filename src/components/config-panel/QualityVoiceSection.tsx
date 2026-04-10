import { Volume2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { Voice } from './helpers'

interface QualityVoiceSectionProps {
  selectedVoice: string
  voices: Voice[]
  voiceTesting: boolean
  voiceTestError: string
  onChangeVoice: (voice: string) => void
  onTestVoice: () => void
  renderVoiceLabel: (voiceName: string, voices: Voice[]) => ReactNode
}

export function QualityVoiceSection({
  selectedVoice,
  voices,
  voiceTesting,
  voiceTestError,
  onChangeVoice,
  onTestVoice,
  renderVoiceLabel,
}: QualityVoiceSectionProps) {
  return (
    <div className="space-y-2">
      <Label>Edge TTS 声音</Label>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <Select value={selectedVoice} onValueChange={onChangeVoice}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择声音...">
                {selectedVoice ? renderVoiceLabel(selectedVoice, voices) : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {voices.map((voice) => (
                <SelectItem key={voice.name} value={voice.name}>
                  {renderVoiceLabel(voice.name, voices)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          size="default"
          className="shrink-0 px-3"
          onClick={onTestVoice}
          disabled={!selectedVoice || voiceTesting}
        >
          <Volume2 className="size-3.5" />
          {voiceTesting ? '播放中...' : '试听'}
        </Button>
      </div>
      {voiceTestError && <p className="text-xs text-red-500">{voiceTestError}</p>}
    </div>
  )
}
