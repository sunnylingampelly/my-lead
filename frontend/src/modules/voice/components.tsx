import { useEffect, useRef, useState } from 'react'
import { Hash, Mic, Pause, Play, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { cn } from '@/lib/utils'
import type { ScriptStepView, VoiceLanguage } from '@/types/voice'
import { VariablePicker } from '../email/components'
import { formatDuration } from './format'

const hasSpeech = () => typeof window !== 'undefined' && 'speechSynthesis' in window

/** Plays a call script in the browser: spoken steps with the browser's voice, recordings as audio. */
function useScriptPlayer(steps: ScriptStepView[], language: string | undefined) {
  const [playing, setPlaying] = useState<number | null>(null)
  const cancelled = useRef(false)
  const audio = useRef<HTMLAudioElement | null>(null)
  const stop = () => {
    cancelled.current = true
    if (hasSpeech()) window.speechSynthesis.cancel()
    audio.current?.pause()
    setPlaying(null)
  }
  useEffect(() => stop, [])
  const play = async () => {
    cancelled.current = false
    for (let i = 0; i < steps.length; i++) {
      if (cancelled.current) return
      const s = steps[i]!
      setPlaying(i)
      await new Promise<void>((resolve) => {
        if (s.kind === 'play' && s.url) {
          const a = new Audio(s.url)
          audio.current = a
          a.onended = () => resolve()
          a.onerror = () => resolve()
          a.play().catch(() => resolve())
        } else if (s.text && hasSpeech()) {
          const u = new SpeechSynthesisUtterance(s.text)
          if (language) u.lang = language
          u.onend = () => resolve()
          u.onerror = () => resolve()
          window.speechSynthesis.speak(u)
        } else resolve()
      })
    }
    setPlaying(null)
  }
  return { playing, play, stop }
}

export function ScriptPreview({ steps, language, seconds, label }: { steps: ScriptStepView[]; language?: string; seconds?: number; label?: string | null }) {
  const { playing, play, stop } = useScriptPlayer(steps, language)
  if (!steps.length) return <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Choose a message to see what callers will hear.</p>
  return (
    <div className="overflow-hidden rounded-xl border bg-card" data-testid="script-preview">
      <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-3">
        <Button size="sm" variant={playing === null ? 'default' : 'outline'} onClick={() => (playing === null ? play() : stop())}>
          {playing === null ? <Play /> : <Pause />} {playing === null ? 'Listen' : 'Stop'}
        </Button>
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">
          {label ?? 'Sample contact'} · about {formatDuration(seconds)}
          <span className="block">Preview uses your browser’s voice. The phone network voice will sound different.</span>
        </div>
      </div>
      <ol className="divide-y">
        {steps.map((s, i) => (
          <li key={i} className={cn('flex gap-3 px-4 py-3 text-sm transition', playing === i && 'bg-accent/50')}>
            <span className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full', s.kind === 'keypress' ? 'bg-warning-soft text-warning-strong' : 'bg-muted text-muted-foreground')}>
              {s.kind === 'play' ? <Volume2 className="size-3.5" /> : s.kind === 'keypress' ? <Hash className="size-3.5" /> : <Mic className="size-3.5" />}
            </span>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {s.kind === 'play' ? 'Recording' : s.kind === 'keypress' ? 'Opt-out prompt · waits 5 seconds for a key' : s.kind === 'agent' ? 'AI conversation' : i === 0 && steps[1]?.kind === 'agent' ? 'Greeting' : i === 0 && steps.length > 1 ? 'Introduction' : 'Message'}
              </div>
              {s.kind === 'play' ? <audio controls src={s.url ?? undefined} className="mt-1 h-8 w-full max-w-xs" /> : <p className="mt-0.5">{s.text}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function TtsForm({
  appId,
  languages,
  value,
  onChange,
}: {
  appId: string
  languages: Record<string, string> | undefined
  value: { name: string; tts_text: string; tts_language: VoiceLanguage; tts_voice: 'female' | 'male' }
  onChange: (v: { name: string; tts_text: string; tts_language: VoiceLanguage; tts_voice: 'female' | 'male' }) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const words = value.tts_text.trim() ? value.tts_text.trim().split(/\s+/).length : 0
  const insert = (token: string) => {
    const el = ref.current
    const s = el?.selectionStart ?? value.tts_text.length
    const e = el?.selectionEnd ?? value.tts_text.length
    onChange({ ...value, tts_text: value.tts_text.slice(0, s) + token + value.tts_text.slice(e) })
  }
  const speak = () => {
    if (!hasSpeech()) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(value.tts_text.replace(/\{\{\s*first_name[^}]*\}\}/g, 'Asha').replace(/\{\{[^}]*\}\}/g, ''))
    u.lang = value.tts_language
    window.speechSynthesis.speak(u)
  }
  return (
    <div className="grid gap-4">
      <Field label="Name" htmlFor="tts-name">
        <Input id="tts-name" value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Diwali offer" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Language" htmlFor="tts-lang">
          <Select id="tts-lang" value={value.tts_language} onChange={(e) => onChange({ ...value, tts_language: e.target.value as VoiceLanguage })}>
            {Object.entries(languages ?? {}).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Voice" htmlFor="tts-voice">
          <Select id="tts-voice" value={value.tts_voice} onChange={(e) => onChange({ ...value, tts_voice: e.target.value as 'female' | 'male' })}>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </Select>
        </Field>
      </div>
      <Field label="What should the call say?" htmlFor="tts-text" hint="Write it the way you would say it. Spell out numbers and short forms.">
        <div className="overflow-hidden rounded-lg border focus-within:ring-2 focus-within:ring-ring/40">
          <Textarea id="tts-text" ref={ref} rows={5} className="resize-y border-0 shadow-none focus-visible:ring-0" value={value.tts_text} onChange={(e) => onChange({ ...value, tts_text: e.target.value })} />
          <div className="flex items-center gap-2 border-t bg-muted/30 px-3 py-2">
            <VariablePicker appId={appId} onInsert={insert} />
            <Button size="sm" variant="ghost" disabled={!value.tts_text.trim()} onClick={speak}>
              <Volume2 /> Hear it
            </Button>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {words} words · about {formatDuration(words ? words / 2.5 + 1 : 0)}
            </span>
          </div>
        </div>
      </Field>
    </div>
  )
}
