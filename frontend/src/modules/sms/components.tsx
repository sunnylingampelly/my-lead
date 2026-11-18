import { useMemo, useRef } from 'react'
import { AlertTriangle, BatteryFull, ChevronLeft, Signal, Sparkles, Wifi } from 'lucide-react'
import { Badge } from '@/components/ui/misc'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/form-controls'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { analyseSms } from '@/lib/smsEncoding'
import { VariablePicker } from '../email/components'

const SMART: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', ' ': ' ' }

/** Textarea with personalisation, live GSM-7 / UCS-2 segment counting and a fix for accidental Unicode. */
export function SmsComposer({
  appId,
  value,
  onChange,
  suffix,
  disabled,
  id = 'sms-body',
}: {
  appId: string
  value: string
  onChange: (v: string) => void
  suffix?: string
  disabled?: boolean
  id?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const full = suffix ? `${value.trim()} ${suffix}` : value
  const info = useMemo(() => analyseSms(full), [full])
  const fixable = info.nonGsm.filter((c) => SMART[c])
  const insert = (token: string) => {
    const el = ref.current
    if (!el) return onChange(value + token)
    const s = el.selectionStart ?? value.length
    const e = el.selectionEnd ?? value.length
    const next = value.slice(0, s) + token + value.slice(e)
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(s + token.length, s + token.length)
    })
  }
  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border bg-card focus-within:ring-2 focus-within:ring-ring/40">
        <Textarea
          id={id}
          ref={ref}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          className="resize-y border-0 shadow-none focus-visible:ring-0"
          placeholder="Hi {{first_name}}, …"
          aria-describedby={`${id}-meter`}
        />
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-3 py-2">
          <VariablePicker appId={appId} onInsert={insert} />
          {suffix && <span className="truncate text-xs text-muted-foreground">+ “{suffix}” added automatically</span>}
          <SegmentMeter info={info} id={`${id}-meter`} className="ml-auto" />
        </div>
      </div>
      {info.encoding === 'UCS-2' && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning-strong">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="flex-1">
            {fixable.length ? 'Curly quotes or dashes' : 'Characters such as'} <strong className="font-mono">{info.nonGsm.slice(0, 6).join(' ')}</strong> switch this text to Unicode: 70 characters per SMS instead of 160.
            {!fixable.length && ' That is expected for Hindi, Tamil and emoji.'}
          </span>
          {fixable.length > 0 && (
            <Button size="sm" variant="outline" className="h-7" onClick={() => onChange(Array.from(value).map((c) => SMART[c] ?? c).join(''))}>
              <Sparkles /> Replace with plain characters
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function SegmentMeter({ info, className, id }: { info: ReturnType<typeof analyseSms>; className?: string; id?: string }) {
  const tone = info.segments > 3 ? 'text-danger-strong' : info.segments > 1 ? 'text-warning-strong' : 'text-muted-foreground'
  return (
    <div id={id} className={cn('flex items-center gap-2 text-xs tabular-nums', className)} data-testid="segment-meter" aria-live="polite">
      <Tooltip content={info.encoding === 'GSM-7' ? 'Standard SMS alphabet: 160 characters, or 153 per part when split.' : 'Unicode: 70 characters, or 67 per part when split.'}>
        <span>
          <Badge variant={info.encoding === 'GSM-7' ? 'secondary' : 'warning'}>{info.encoding}</Badge>
        </span>
      </Tooltip>
      <span className="text-muted-foreground">
        {info.units} chars · {info.remaining} left
      </span>
      <span className={cn('font-semibold', tone)}>
        {info.segments} {info.segments === 1 ? 'SMS' : 'SMS parts'}
      </span>
    </div>
  )
}

/** A phone mockup showing the message as the recipient sees it. */
export function PhonePreview({ sender, text, label, className }: { sender: string | null | undefined; text: string; label?: string; className?: string }) {
  return (
    <div className={cn('mx-auto w-[280px] select-none', className)} data-testid="phone-preview">
      <div className="rounded-[2.4rem] border-[10px] border-neutral-900 bg-neutral-900 shadow-xl dark:border-neutral-700">
        <div className="overflow-hidden rounded-[1.8rem] bg-background">
          <div className="flex items-center justify-between px-5 pb-1 pt-2.5 text-[10px] font-semibold">
            <span>9:41</span>
            <span className="h-4 w-16 rounded-full bg-neutral-900" />
            <span className="flex items-center gap-0.5">
              <Signal className="size-3" />
              <Wifi className="size-3" />
              <BatteryFull className="size-3.5" />
            </span>
          </div>
          <div className="flex flex-col items-center border-b px-4 pb-2.5 pt-1">
            <ChevronLeft className="absolute -ml-48 mt-2 size-4 text-primary" />
            <div className="flex size-9 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">{(sender ?? '?').replace('+', '').slice(0, 2)}</div>
            <div className="mt-1 text-xs font-semibold">{sender || 'Choose a sender'}</div>
          </div>
          <div className="flex h-[300px] flex-col justify-end gap-1 overflow-y-auto px-3 py-4">
            <div className="text-center text-[10px] text-muted-foreground">Text Message · Today</div>
            {text ? (
              <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-[13px] leading-snug">{text}</div>
            ) : (
              <div className="max-w-[88%] rounded-2xl rounded-bl-md border border-dashed px-3 py-2 text-[13px] text-muted-foreground">Your message appears here</div>
            )}
          </div>
          <div className="px-3 pb-4">
            <div className="rounded-full border px-3 py-1.5 text-[11px] text-muted-foreground">Text Message</div>
          </div>
        </div>
      </div>
      {label && <p className="mt-2 text-center text-xs text-muted-foreground">{label}</p>}
    </div>
  )
}
