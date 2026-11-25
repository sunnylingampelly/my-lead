import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, CheckCircle2, CircleSlash, Clock, Loader2, Pencil, ShieldCheck, X, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import type { ActionCard as Card } from '@/types/ai'
import { safeHref } from './lib'
import { Markdown } from './Markdown'

const STATUS: Record<Card['status'], { label: string; tone: 'secondary' | 'success' | 'destructive' | 'warning' | 'default'; icon: typeof Clock }> = {
  pending: { label: 'Waiting for you', tone: 'warning', icon: Clock },
  executing: { label: 'Working…', tone: 'default', icon: Loader2 },
  executed: { label: 'Done', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'destructive', icon: XCircle },
  cancelled: { label: 'Cancelled', tone: 'secondary', icon: CircleSlash },
  rejected: { label: 'Rejected', tone: 'secondary', icon: CircleSlash },
  expired: { label: 'Expired', tone: 'secondary', icon: Clock },
}

export function LinkButtons({ links, onNavigate, className }: { links: { label: string; href: string }[]; onNavigate?: () => void; className?: string }) {
  const safe = links.map((l) => ({ ...l, t: safeHref(l.href) })).filter((l) => l.t)
  if (!safe.length) return null
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {safe.map((l) =>
        l.t!.internal ? (
          <Button key={l.href} asChild size="sm" variant="outline" className="h-7 rounded-full px-3 text-xs">
            <Link to={l.t!.href} onClick={onNavigate} data-testid="ai-link">
              {l.label}
            </Link>
          </Button>
        ) : (
          <Button key={l.href} asChild size="sm" variant="outline" className="h-7 rounded-full px-3 text-xs">
            <a href={l.t!.href} target="_blank" rel="noopener noreferrer">
              {l.label}
            </a>
          </Button>
        ),
      )}
    </div>
  )
}

/**
 * A proposed write: what will happen and the key fields, with Confirm / Edit / Cancel (assistant) or
 * Approve / Edit / Reject (agent approvals). Nothing runs until the person confirms; the server makes
 * deciding idempotent, so double clicks are harmless.
 */
export function ActionCard({
  card,
  mode = 'confirm',
  onDecide,
  onNavigate,
  compact,
}: {
  card: Card
  mode?: 'confirm' | 'approve'
  onDecide: (approve: boolean, args?: Record<string, unknown>) => Promise<Card>
  onNavigate?: () => void
  compact?: boolean
}) {
  const [state, setState] = useState<Card>(card)
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(card.editable.map((e) => [e.key, e.value == null ? '' : String(e.value)])),
  )
  const st = STATUS[state.status] ?? STATUS.pending
  const pending = state.status === 'pending'

  const decide = async (approve: boolean) => {
    setBusy(approve ? 'yes' : 'no')
    try {
      const numeric = new Set(card.editable.filter((e) => typeof e.value === 'number').map((e) => e.key))
      const changed = Object.entries(draft).filter(([k, v]) => v !== String(card.editable.find((e) => e.key === k)?.value ?? ''))
      const edits = approve && changed.length ? Object.fromEntries(changed.map(([k, v]) => [k, numeric.has(k) ? Number(v) : v])) : undefined
      const next = await onDecide(approve, edits)
      setState(next)
      setEditing(false)
      if (next.status === 'failed') toast.error(next.error ?? 'That didn’t work')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className={cn('rounded-xl border bg-card shadow-sm', pending ? 'border-primary/40 ring-1 ring-primary/10' : '', compact ? 'text-sm' : '')}
      data-testid="action-card"
      data-status={state.status}
      aria-live="polite"
    >
      <div className="flex items-start gap-2 border-b px-3 py-2.5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {mode === 'approve' && state.agent_name ? `${state.agent_name} wants to` : 'Proposed action'}
          </div>
          <div className="font-medium leading-snug">{state.title}</div>
        </div>
        <Badge variant={st.tone} className="shrink-0">
          <st.icon className={cn('size-3', state.status === 'executing' && 'animate-spin')} /> {st.label}
        </Badge>
      </div>
      {editing ? (
        <div className="space-y-2 px-3 py-3">
          {card.editable.map((e) => (
            <label key={e.key} className="block space-y-1 text-xs font-medium">
              <span>{e.label}</span>
              {e.multiline ? (
                <Textarea value={draft[e.key] ?? ''} onChange={(ev) => setDraft({ ...draft, [e.key]: ev.target.value })} className="min-h-[90px] text-sm" />
              ) : (
                <Input value={draft[e.key] ?? ''} onChange={(ev) => setDraft({ ...draft, [e.key]: ev.target.value })} className="text-sm" />
              )}
            </label>
          ))}
        </div>
      ) : (
        <dl className="grid gap-x-3 gap-y-1.5 px-3 py-3 text-sm sm:grid-cols-[110px_1fr]">
          {state.fields.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-xs text-muted-foreground sm:pt-0.5">{f.label}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words">{f.value || '—'}</dd>
            </div>
          ))}
        </dl>
      )}
      {pending ? (
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-3 py-2">
          <Button size="sm" onClick={() => decide(true)} loading={busy === 'yes'} disabled={!!busy} data-testid="action-confirm">
            <Check /> {mode === 'approve' ? 'Approve' : 'Confirm'}
          </Button>
          {card.editable.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setEditing((v) => !v)} disabled={!!busy} aria-pressed={editing}>
              <Pencil /> {editing ? 'Done editing' : 'Edit'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => decide(false)} loading={busy === 'no'} disabled={!!busy} data-testid="action-cancel">
            <X /> {mode === 'approve' ? 'Reject' : 'Cancel'}
          </Button>
        </div>
      ) : state.result?.summary || state.error ? (
        <div className="space-y-2 border-t bg-muted/30 px-3 py-2">
          {state.error ? <p className="text-xs text-destructive">{state.error}</p> : <Markdown text={state.result!.summary!} className="text-xs" onNavigate={onNavigate} />}
          {state.result?.links && <LinkButtons links={state.result.links} onNavigate={onNavigate} />}
        </div>
      ) : null}
    </div>
  )
}
