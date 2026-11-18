import { useEffect, useMemo, useRef, useState } from 'react'
import { Braces, Copy, Monitor, Smartphone } from 'lucide-react'
import { toast } from 'sonner'
import { useVariables } from '@/api/email'
import { Badge } from '@/components/ui/misc'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { CampaignStatus } from '@/types/email'

export const STATUS_META: Record<CampaignStatus, { label: string; variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline' }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  scheduled: { label: 'Scheduled', variant: 'default' },
  queued: { label: 'Queued', variant: 'default' },
  sending: { label: 'Sending', variant: 'warning' },
  paused: { label: 'Paused', variant: 'warning' },
  completed: { label: 'Sent', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
  failed: { label: 'Failed', variant: 'destructive' },
}

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const m = STATUS_META[status]
  return (
    <Badge variant={m.variant}>
      {status === 'sending' && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {m.label}
    </Badge>
  )
}

export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(n >= 10 ? 1 : 2)}%`)

/** Insert personalisation fields. Inserts at the cursor of the given input, or copies to the clipboard. */
export function VariablePicker({
  appId,
  onInsert,
  label = 'Personalise',
  size = 'sm',
}: {
  appId: string
  onInsert?: (token: string) => void
  label?: string
  size?: 'sm' | 'default'
}) {
  const vars = useVariables(appId)
  const pick = async (key: string, fallback?: string) => {
    const token = fallback ? `{{${key} | default: "${fallback}"}}` : `{{${key}}}`
    if (onInsert) onInsert(token)
    else {
      await navigator.clipboard?.writeText(token).catch(() => undefined)
      toast.success(`Copied ${token}`, { description: 'Paste it into any text block.' })
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size={size}>
          <Braces /> {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel>Contact fields</DropdownMenuLabel>
        {vars.data?.core.map((v) => (
          <DropdownMenuItem key={v.key} onSelect={() => pick(v.key, v.key === 'first_name' ? 'there' : undefined)}>
            <span className="flex-1">{v.label}</span>
            <code className="text-[11px] text-muted-foreground">{v.key}</code>
          </DropdownMenuItem>
        ))}
        {!!vars.data?.custom.length && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Custom fields</DropdownMenuLabel>
            {vars.data.custom.map((v) => (
              <DropdownMenuItem key={v.key} onSelect={() => pick(v.key)}>
                <span className="flex-1">{v.label}</span>
                <code className="text-[11px] text-muted-foreground">{v.key}</code>
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => pick('unsubscribe_url')}>
          <span className="flex-1">Unsubscribe link</span>
          <Copy className="size-3.5" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Sandboxed preview: scripts never run, so authored HTML cannot affect the app. */
export function EmailFrame({ html, device = 'desktop', className, title = 'Email preview' }: { html: string; device?: 'desktop' | 'mobile'; className?: string; title?: string }) {
  return (
    <div className={cn('flex justify-center overflow-auto rounded-lg border bg-muted/40 p-4', className)}>
      <iframe
        title={title}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={html}
        className={cn('h-full min-h-[560px] rounded-md border bg-white shadow-card transition-all', device === 'mobile' ? 'w-[375px]' : 'w-full max-w-[720px]')}
      />
    </div>
  )
}

export function DeviceToggle({ value, onChange }: { value: 'desktop' | 'mobile'; onChange: (v: 'desktop' | 'mobile') => void }) {
  return (
    <div className="inline-flex rounded-md border bg-card p-0.5" role="radiogroup" aria-label="Preview size">
      {(['desktop', 'mobile'] as const).map((d) => (
        <button
          key={d}
          role="radio"
          aria-checked={value === d}
          aria-label={d === 'desktop' ? 'Desktop preview' : 'Mobile preview'}
          onClick={() => onChange(d)}
          className={cn('flex size-7 items-center justify-center rounded', value === d ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')}
        >
          {d === 'desktop' ? <Monitor className="size-4" /> : <Smartphone className="size-4" />}
        </button>
      ))}
    </div>
  )
}

/** HTML source editor with line numbers and a live preview. */
export function HtmlEditor({ value, onChange, appId }: { value: string; onChange: (v: string) => void; appId: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 400)
    return () => clearTimeout(t)
  }, [value])
  const lines = useMemo(() => value.split('\n').length, [value])
  const insert = (token: string) => {
    const el = ref.current
    if (!el) return onChange(value + token)
    const { selectionStart: s, selectionEnd: e } = el
    onChange(value.slice(0, s) + token + value.slice(e))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(s + token.length, s + token.length)
    })
  }
  return (
    <div className="grid h-full min-h-[600px] gap-4 xl:grid-cols-2">
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">HTML · {lines} lines</span>
          <VariablePicker appId={appId} onInsert={insert} />
        </div>
        <div className="flex min-h-0 flex-1 overflow-auto font-mono text-[12.5px] leading-5">
          <div aria-hidden className="select-none border-r bg-muted/40 px-2 py-3 text-right text-muted-foreground">
            {Array.from({ length: lines }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            aria-label="HTML source"
            className="min-h-full flex-1 resize-none bg-transparent px-3 py-3 outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
            style={{ tabSize: 2 }}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault()
                insert('  ')
              }
            }}
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Live preview (personalisation shown raw)</span>
          <DeviceToggle value={device} onChange={setDevice} />
        </div>
        <EmailFrame html={debounced} device={device} className="flex-1" />
      </div>
    </div>
  )
}
