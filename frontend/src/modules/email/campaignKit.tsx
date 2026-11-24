/**
 * Building blocks shared by the email, SMS and voice campaign editors:
 * a stepper that fits phones, an autosave that saves settings/audience and the design separately,
 * a self-describing readiness checklist, plain-language "What is this?" help, a "Back to campaign"
 * banner for pages opened from an editor, the audience picker, and the C3 "new campaign" route.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock,
  Cloud,
  CloudOff,
  ExternalLink,
  Filter,
  HelpCircle,
  ListChecks,
  Loader2,
  Moon,
  Plus,
  RefreshCw,
  Users,
  Wallet,
  X,
  XCircle,
} from 'lucide-react'
import { aqk, audienceApi, useLists, useSegments } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { emailApi } from '@/api/email'
import { smsApi } from '@/api/sms'
import { voiceApi } from '@/api/voice'
import { ErrorState, FullPageSpinner } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/form-controls'
import { Checkbox } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import { cn } from '@/lib/utils'
import type { CampaignAudience, ReadinessCheck, WalletInfo } from '@/types/email'
import type { QuietWait } from '@/types/sms'

export type Channel = 'email' | 'sms' | 'voice'

// ------------------------------------------------------------------ money

// eslint-disable-next-line react-refresh/only-export-components
export function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: amount < 1 ? 4 : 2 }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

// ------------------------------------------------------------------ stepper

export function StepNav<K extends string>({
  steps,
  step,
  done,
  onGo,
}: {
  steps: readonly { key: K; label: string }[]
  step: K
  done: Set<K>
  onGo: (k: K) => void
}) {
  const idx = steps.findIndex((s) => s.key === step)
  return (
    <div className="flex w-full min-w-0 flex-col gap-1 sm:ml-auto sm:w-auto sm:items-end">
      <nav className="flex min-w-0 max-w-full items-center gap-1 overflow-x-auto rounded-xl border bg-card p-1 shadow-card" aria-label="Campaign steps">
        {steps.map((s, i) => (
          <button
            key={s.key}
            onClick={() => onGo(s.key)}
            aria-current={step === s.key ? 'step' : undefined}
            aria-label={`Step ${i + 1}: ${s.label}`}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium transition sm:px-3',
              step === s.key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <span className={cn('flex size-5 items-center justify-center rounded-full text-[11px]', step === s.key ? 'bg-white/20' : done.has(s.key) ? 'bg-success-soft text-success-strong' : 'bg-muted')}>
              {done.has(s.key) && step !== s.key ? <Check className="size-3" /> : i + 1}
            </span>
            {/* The current step is always named; the others are named from md up. */}
            <span className={cn(step === s.key ? 'inline' : 'hidden md:inline')}>{s.label}</span>
          </button>
        ))}
      </nav>
      <span className="text-xs text-muted-foreground sm:hidden" data-testid="step-caption">
        Step {idx + 1} of {steps.length}: {steps[idx]?.label}
      </span>
    </div>
  )
}

// ------------------------------------------------------------------ autosave

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export interface SaveGroup {
  /** Shown in the error toast, e.g. "the email design". */
  name: string
  keys: string[]
}

/**
 * Debounced autosave. Fields listed in `isolate` groups are sent in their own request, so a failure to
 * save (say) a large design never loses the audience or settings saved alongside it. A failed group
 * stays pending, the toast names what was not saved and offers Retry.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useCampaignAutosave<D extends { id: string }>({
  campaign,
  save,
  onSaved,
  isolate = [],
  rest = 'your changes',
}: {
  campaign: D | undefined
  save: (id: string, body: Partial<D>) => Promise<D>
  onSaved?: (saved: D, body: Partial<D>) => void
  isolate?: SaveGroup[]
  rest?: string
}) {
  const [draft, setDraft] = useState<Partial<D>>({})
  const [state, setState] = useState<SaveState>('idle')
  const pending = useRef<Partial<D>>({})
  const timer = useRef<number | undefined>(undefined)
  const loaded = useRef(false)
  const saveRef = useRef(save)
  const onSavedRef = useRef(onSaved)
  saveRef.current = save
  onSavedRef.current = onSaved

  useEffect(() => {
    if (campaign && !loaded.current) {
      loaded.current = true
      setDraft(campaign)
    }
  }, [campaign])

  const id = campaign?.id
  const groupsKey = JSON.stringify(isolate)
  const flush = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current)
    const body = pending.current
    if (!id || !Object.keys(body).length) return true
    pending.current = {}
    setState('saving')
    const groups: SaveGroup[] = JSON.parse(groupsKey)
    const isolated = new Set(groups.flatMap((g) => g.keys))
    const parts: { name: string; body: Partial<D> }[] = []
    const main = Object.fromEntries(Object.entries(body).filter(([k]) => !isolated.has(k))) as Partial<D>
    if (Object.keys(main).length) parts.push({ name: rest, body: main })
    for (const g of groups) {
      const sub = Object.fromEntries(Object.entries(body).filter(([k]) => g.keys.includes(k))) as Partial<D>
      if (Object.keys(sub).length) parts.push({ name: g.name, body: sub })
    }
    let ok = true
    for (const part of parts) {
      try {
        const saved = await saveRef.current(id, part.body)
        onSavedRef.current?.(saved, part.body)
        toast.dismiss(`autosave-${part.name}`)
      } catch (e) {
        ok = false
        // Keep what failed (newer edits made meanwhile win).
        pending.current = { ...part.body, ...pending.current }
        toast.error(`Couldn't save ${part.name}`, {
          id: `autosave-${part.name}`,
          description: errorMessage(e, 'The server did not respond. Check your connection.'),
          duration: 15_000,
          action: { label: 'Retry', onClick: () => void flushRef.current() },
        })
      }
    }
    setState(ok ? 'saved' : 'error')
    return ok
  }, [id, groupsKey, rest])
  const flushRef = useRef(flush)
  flushRef.current = flush

  const update = useCallback(
    (patch: Partial<D>, immediate = false) => {
      setDraft((d) => ({ ...d, ...patch }))
      pending.current = { ...pending.current, ...patch }
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flushRef.current(), immediate ? 0 : 800)
    },
    [],
  )
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return { draft, setDraft, update, flush, state }
}

export function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry?: () => void }) {
  if (state === 'saving')
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Saving…
      </span>
    )
  if (state === 'error')
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive" data-testid="save-state">
        <CloudOff className="size-3.5" /> Not saved
        {onRetry && (
          <button className="font-medium underline" onClick={onRetry}>
            Retry
          </button>
        )}
      </span>
    )
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="save-state">
      <Cloud className="size-3.5" /> {state === 'saved' ? 'All changes saved' : 'Draft'}
    </span>
  )
}

// ------------------------------------------------------------------ plain-language help

type Term = { title: string; text: string; links?: { label: string; href: string }[] }

// eslint-disable-next-line react-refresh/only-export-components
export const GLOSSARY: Record<string, Term> = {
  pe_id: {
    title: 'Principal Entity (PE) ID',
    text: 'The ID your business gets when it registers on an operator’s DLT portal; Indian operators block texts and calls from businesses without one.',
    links: [
      { label: 'Jio', href: 'https://trueconnect.jio.com' },
      { label: 'Airtel', href: 'https://dltconnect.airtel.in' },
      { label: 'Vi', href: 'https://www.vilpower.in' },
      { label: 'BSNL', href: 'https://www.ucc-bsnl.co.in' },
    ],
  },
  dlt_header: {
    title: 'DLT header (sender ID)',
    text: 'The 6-character name shown as the sender in India: 6 digits for promotional texts, 6 capital letters for service and transactional texts, registered on your DLT portal.',
  },
  dlt_var: {
    title: '{#var#}',
    text: 'Marks a spot in a registered DLT template where personalised text (up to 30 characters) may go; everything else must match the registered text exactly.',
  },
  dlt_template: {
    title: 'DLT content template ID',
    text: 'The ID DLT gives each approved message text. Every Indian SMS must quote one, and the text sent must match it.',
  },
  tendlc: {
    title: '10DLC brand and campaign',
    text: 'US carriers require businesses texting from ordinary 10-digit numbers to register their brand and the kind of messages they send (the campaign) with The Campaign Registry.',
    links: [{ label: 'The Campaign Registry', href: 'https://www.campaignregistry.com/' }],
  },
  tcpa: {
    title: 'TCPA',
    text: 'A US law: marketing texts and prerecorded calls need the person’s prior written consent, must identify you, offer an easy opt-out, and stay within 8 am–9 pm their time.',
    links: [{ label: 'FCC guide', href: 'https://www.fcc.gov/general/telemarketing-and-robocalls' }],
  },
  series: {
    title: '140-series and 160-series numbers',
    text: 'In India, promotional calls must come from numbers starting with 140 and service or transactional calls from numbers starting with 160, so people can tell them apart.',
    links: [{ label: 'TRAI', href: 'https://www.trai.gov.in' }],
  },
  can_spam: {
    title: 'CAN-SPAM postal address',
    text: 'US law requires every marketing email to show your valid physical postal address and a working unsubscribe link.',
    links: [{ label: 'FTC guide', href: 'https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business' }],
  },
  quiet_hours: {
    title: 'Quiet hours',
    text: 'Hours (in each recipient’s time zone) when marketing messages are held and sent once the window opens. Set them in Application settings → Delivery.',
  },
  consent: {
    title: 'Consent',
    text: 'Marketing messages may only go to people who agreed to receive them on this channel. Record consent when importing or on each contact.',
  },
}

/** Which glossary entry explains a readiness check. */
// eslint-disable-next-line react-refresh/only-export-components
export function termFor(c: ReadinessCheck, channel: Channel): string | undefined {
  if (c.key === 'registration') return c.label.includes('10DLC') ? 'tendlc' : 'pe_id'
  if (c.key === 'category') return channel === 'voice' ? 'series' : 'dlt_header'
  if (c.key === 'dlt_template') return 'dlt_template'
  if (c.key === 'postal_address') return 'can_spam'
  if (c.key === 'opt_out' || c.key === 'identification') return channel === 'email' ? undefined : 'tcpa'
  if (c.key === 'consent') return c.label.includes('TCPA') ? 'tcpa' : 'consent'
  return undefined
}

export function WhatIsThis({ term, className }: { term: string; className?: string }) {
  const [open, setOpen] = useState(false)
  const t = GLOSSARY[term]
  if (!t) return null
  return (
    <span className={cn('inline', className)}>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          setOpen((o) => !o)
        }}
        className="ml-1 inline-flex items-center gap-0.5 align-middle text-xs font-normal text-primary hover:underline"
        aria-expanded={open}
        data-testid={`what-${term}`}
      >
        <HelpCircle className="size-3.5" /> What is this?
      </button>
      {open && (
        <span className="mt-1 block rounded-md border bg-muted/50 px-2.5 py-2 text-xs font-normal text-foreground" role="note">
          <span className="font-medium">{t.title}: </span>
          {t.text}
          {t.links && (
            <span className="mt-1 flex flex-wrap gap-x-3">
              {t.links.map((l) => (
                <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                  {l.label} <ExternalLink className="size-3" />
                </a>
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  )
}

// ------------------------------------------------------------------ returnTo

/** Append ?returnTo=<editor url> so the target page can offer "Back to campaign". */
// eslint-disable-next-line react-refresh/only-export-components
export function withReturnTo(url: string, returnTo?: string | null) {
  if (!returnTo || /^https?:/.test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(returnTo)}`
}

/** The current location, for links that should come back here. */
// eslint-disable-next-line react-refresh/only-export-components
export function useHere() {
  const loc = useLocation()
  return loc.pathname + loc.search
}

/** Only same-app paths are accepted (no open redirect). */
// eslint-disable-next-line react-refresh/only-export-components
export function safeReturnTo(v: string | null): string | null {
  return v && v.startsWith('/apps/') && !v.startsWith('//') ? v : null
}

export function BackToCampaignBanner({ label = 'Back to campaign' }: { label?: string }) {
  const [params] = useSearchParams()
  const to = safeReturnTo(params.get('returnTo'))
  if (!to) return null
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-accent/40 px-3 py-2 text-sm" data-testid="return-banner">
      <span className="min-w-0 flex-1 text-muted-foreground">You came here from a campaign. Your draft is saved.</span>
      <Button size="sm" asChild>
        <Link to={to}>
          <ArrowLeft /> {label}
        </Link>
      </Button>
    </div>
  )
}

// ------------------------------------------------------------------ readiness checklist

function WalletRow({ meta }: { meta: Record<string, unknown> }) {
  const cur = String(meta.currency ?? '')
  const avail = Number(meta.available ?? 0)
  const need = Number(meta.need ?? 0)
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 text-xs" data-testid="wallet-meta">
      <span>
        Balance <strong className="tabular-nums">{money(avail, cur)}</strong>
      </span>
      <span>
        Estimated cost <strong className="tabular-nums">{money(need, cur)}</strong>
      </span>
    </div>
  )
}

export function ReadinessList({
  checks,
  channel,
  onStep,
  rowExtra,
}: {
  checks: ReadinessCheck[]
  channel: Channel
  onStep: (step: string) => void
  /** Extra controls for a row (e.g. "Resend confirmation" for an unverified email sender). */
  rowExtra?: (c: ReadinessCheck) => ReactNode
}) {
  const here = useHere()
  return (
    <ul className="divide-y" data-testid="readiness">
      {checks.map((c) => {
        const term = termFor(c, channel)
        const external = c.action_url ? withReturnTo(c.action_url, here) : null
        return (
          <li key={c.key} className="flex flex-wrap items-start gap-3 py-3 sm:flex-nowrap" data-check={c.key} data-ok={c.ok}>
            {c.ok ? (
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success-strong" />
            ) : c.pending ? (
              <Clock className="mt-0.5 size-5 shrink-0 text-warning-strong" aria-label="Needed" />
            ) : (
              <XCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {c.label}
                {c.pending && <span className="ml-2 rounded bg-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-warning-strong">Needed</span>}
                {term && <WhatIsThis term={term} />}
              </div>
              {c.detail && <div className="text-xs text-muted-foreground">{c.detail}</div>}
              {c.key === 'wallet' && c.meta && <WalletRow meta={c.meta} />}
              {rowExtra?.(c)}
            </div>
            {!c.ok && (
              <div className="flex shrink-0 flex-wrap gap-2 pl-8 sm:pl-0">
                {c.step && (
                  <Button size="sm" variant="outline" onClick={() => onStep(c.step!)} data-testid={`fix-${c.key}`}>
                    Fix
                  </Button>
                )}
                {external && (!c.step || c.key === 'wallet') && (
                  <Button size="sm" variant={c.key === 'wallet' ? 'default' : 'outline'} asChild>
                    <Link to={external} data-testid={`action-${c.key}`}>
                      {c.key === 'wallet' && <Wallet />}
                      {c.action_label || 'Fix'}
                    </Link>
                  </Button>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** "Balance ₹x" next to a cost estimate. */
export function WalletLine({ wallet, cost }: { wallet?: WalletInfo; cost?: { total: number; currency: string } | null }) {
  const { org, app, canOrg } = useWorkspace()
  const here = useHere()
  if (!wallet) return null
  const short = cost && cost.currency === wallet.currency && wallet.available < cost.total
  const billing = canOrg('billing.manage') && org ? `/orgs/${org.id}/billing` : `/apps/${app!.id}/billing`
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-2 text-xs', short ? 'text-destructive' : 'text-muted-foreground')} data-testid="wallet-balance">
      <Wallet className="size-3.5" /> Wallet balance {money(wallet.available, wallet.currency)}
      {short && (
        <Link className="font-medium text-primary hover:underline" to={withReturnTo(billing, here)}>
          Top up
        </Link>
      )}
    </span>
  )
}

/** "N texts will wait until 09:00 IST" above the Send button. */
export function QuietWaitNotice({ q, noun, app }: { q?: QuietWait; noun: [string, string]; app: { default_country: string | null } }) {
  if (!q || !q.waiting || !q.next_window_at) return null
  const at = new Date(q.next_window_at)
  let when = at.toLocaleString()
  try {
    when = at.toLocaleString(undefined, { timeZone: q.timezone ?? undefined, hour: '2-digit', minute: '2-digit', weekday: 'short', timeZoneName: 'short' })
  } catch {
    /* unknown zone: local time */
  }
  return (
    <p className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong" data-testid="quiet-wait">
      <Moon className="mt-0.5 size-4 shrink-0" />
      <span>
        If you send now, {formatCount(q.waiting, app.default_country)} {q.waiting === 1 ? noun[0] : noun[1]} will wait until {when} ({q.window.reason.toLowerCase()}).
      </span>
    </p>
  )
}

// ------------------------------------------------------------------ overview setup checklist

export interface SetupItem {
  key: string
  label: string
  done: boolean
  to: string
  term?: string
}

/** Setup checklist on channel overviews. Everyone sees it; only admins get links, others are told whom to ask. */
export function SetupChecklist({ title, items, extra, testId }: { title: string; items: SetupItem[]; extra?: ReactNode; testId?: string }) {
  const { can } = useWorkspace()
  const admin = can('settings.write')
  if (items.every((i) => i.done)) return null
  return (
    <div className="mb-6 rounded-lg border border-warning-border bg-warning-soft p-4 text-sm text-warning-strong" data-testid={testId}>
      <div className="mb-3 flex flex-wrap items-center gap-2 font-semibold">
        {title}
        {!admin && <span className="text-xs font-normal">Ask an admin of this application to complete these steps.</span>}
      </div>
      <ol className="grid gap-2 md:grid-cols-2">
        {items.map((i) => (
          <li key={i.key} className="flex min-w-0 items-start gap-2" data-setup={i.key} data-done={i.done}>
            {i.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-strong" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
            <span className="min-w-0">
              {admin && !i.done ? (
                <Link className="underline" to={i.to}>
                  {i.label}
                </Link>
              ) : (
                <span className={cn(i.done && 'text-foreground/70')}>{i.label}</span>
              )}
              {i.term && <WhatIsThis term={i.term} />}
            </span>
          </li>
        ))}
      </ol>
      {extra}
    </div>
  )
}

// ------------------------------------------------------------------ audience picker

export function AudiencePicker({
  audience,
  onChange,
  allHint,
}: {
  audience: CampaignAudience
  onChange: (a: CampaignAudience) => void
  allHint: string
}) {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const qc = useQueryClient()
  const segments = useSegments(appId)
  const lists = useLists(appId)
  const [newList, setNewList] = useState('')
  const [creating, setCreating] = useState(false)
  const f = (n: number) => formatCount(n, app!.default_country)
  const set = (a: CampaignAudience) => onChange({ all: false, list_ids: [], segment_ids: [], contact_ids: [], ...a })
  const picked = audience.contact_ids ?? []
  const toggle = (k: 'list_ids' | 'segment_ids', id: string, on: boolean) => {
    const cur = new Set(audience[k] ?? [])
    if (on) cur.add(id)
    else cur.delete(id)
    set({ ...audience, all: false, [k]: [...cur] })
  }
  const refresh = () => {
    qc.invalidateQueries({ queryKey: aqk.segments(appId) })
    qc.invalidateQueries({ queryKey: aqk.lists(appId) })
  }
  const createList = async () => {
    if (!newList.trim()) return
    setCreating(true)
    try {
      const l = await audienceApi(appId).createList({ name: newList.trim() })
      await qc.invalidateQueries({ queryKey: aqk.lists(appId) })
      set({ ...audience, all: false, list_ids: [...(audience.list_ids ?? []), l.id] })
      setNewList('')
      toast.success(`List “${l.name}” created. Add people to it from Contacts.`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setCreating(false)
    }
  }
  return (
    <div className="space-y-4">
      <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition', audience.all && 'border-primary bg-accent/40')}>
        <input type="radio" className="mt-1 accent-[hsl(var(--primary))]" checked={!!audience.all} onChange={() => set({ all: true })} />
        <span>
          <span className="text-sm font-medium">All reachable contacts</span>
          <span className="block text-xs text-muted-foreground">{allHint}</span>
        </span>
      </label>
      <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition', !audience.all && 'border-primary bg-accent/40')}>
        <input type="radio" className="mt-1 accent-[hsl(var(--primary))]" checked={!audience.all} onChange={() => set({ ...audience, all: false })} />
        <span className="text-sm font-medium">Specific segments, lists or people</span>
      </label>
      {!audience.all && (
        <>
          {picked.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm" data-testid="picked-contacts">
              <Users className="size-4 text-muted-foreground" />
              <span className="flex-1">
                <strong>{f(picked.length)}</strong> selected {picked.length === 1 ? 'person' : 'people'}
              </span>
              <button className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => set({ ...audience, contact_ids: [] })}>
                <X className="size-3.5" /> Remove
              </button>
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Filter className="size-3.5" /> Segments
                <span className="ml-auto flex items-center gap-2 normal-case tracking-normal">
                  {can('audience.write') && (
                    <a className="inline-flex items-center gap-1 font-medium text-primary hover:underline" href={`/apps/${appId}/audience/segments/new`} target="_blank" rel="noreferrer" data-testid="new-segment">
                      <Plus className="size-3" /> New segment <ExternalLink className="size-3" />
                    </a>
                  )}
                  <button className="inline-flex items-center gap-1 font-medium text-primary hover:underline" onClick={refresh} data-testid="refresh-audience">
                    <RefreshCw className={cn('size-3', (segments.isFetching || lists.isFetching) && 'animate-spin')} /> Refresh
                  </button>
                </span>
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2">
                {segments.data?.length === 0 && (
                  <p className="p-2 text-sm text-muted-foreground">No segments yet. Create one in the new tab, then press Refresh.</p>
                )}
                {segments.data?.map((s) => (
                  <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                    <Checkbox checked={audience.segment_ids?.includes(s.id) ?? false} onChange={(e) => toggle('segment_ids', s.id, e.target.checked)} aria-label={s.name} />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{s.last_count === null ? '—' : f(s.last_count)}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <ListChecks className="size-3.5" /> Lists
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2">
                {lists.data?.length === 0 && (
                  <p className="p-2 text-sm text-muted-foreground">
                    No lists yet. Create one below, or{' '}
                    <a className="text-primary hover:underline" href={`/apps/${appId}/audience/contacts`} target="_blank" rel="noreferrer">
                      pick people on the Contacts page
                    </a>
                    .
                  </p>
                )}
                {lists.data?.map((l) => (
                  <label key={l.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                    <Checkbox checked={audience.list_ids?.includes(l.id) ?? false} onChange={(e) => toggle('list_ids', l.id, e.target.checked)} aria-label={l.name} />
                    <span className="min-w-0 flex-1 truncate">{l.name}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{f(l.contact_count)}</span>
                  </label>
                ))}
              </div>
              {can('audience.write') && (
                <div className="mt-2 flex gap-2">
                  <Input value={newList} onChange={(e) => setNewList(e.target.value)} placeholder="New list name" aria-label="New list name" className="h-8 min-w-0 text-sm" onKeyDown={(e) => e.key === 'Enter' && createList()} />
                  <Button size="sm" variant="outline" onClick={createList} loading={creating} disabled={!newList.trim()} data-testid="create-list">
                    <Plus /> Create list
                  </Button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ C3: /apps/:appId/{channel}/campaigns/new

const LABEL: Record<Channel, string> = { email: 'Campaign', sms: 'SMS', voice: 'Calls' }

/** Parse ?segment_id=, ?list_id= or ?contact_ids=a,b,c into an audience (nothing → blank). */
// eslint-disable-next-line react-refresh/only-export-components
export function audienceFromParams(params: URLSearchParams): CampaignAudience | undefined {
  const seg = params.get('segment_id')
  const list = params.get('list_id')
  const ids = (params.get('contact_ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!seg && !list && !ids.length) return undefined
  return { all: false, segment_ids: seg ? [seg] : [], list_ids: list ? [list] : [], contact_ids: ids.slice(0, 1000) }
}

/**
 * Contract C3: creates a draft campaign with the audience from the query string preselected and opens
 * its editor. Used by Audience (segments, lists, contacts), CRM and campaign reports.
 */
export function NewCampaignRoute({ channel }: { channel: Channel }) {
  const { appId } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [error, setError] = useState<unknown>(null)
  const started = useRef(false)
  const run = useCallback(async () => {
    setError(null)
    const audience = audienceFromParams(params)
    const name = params.get('name') || `${LABEL[channel]} ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
    try {
      const api = channel === 'email' ? emailApi(appId!) : channel === 'sms' ? smsApi(appId!) : voiceApi(appId!)
      const c = await api.createCampaign({ name, ...(audience ? { audience } : {}) })
      const step = audience ? '?step=setup' : ''
      navigate(`/apps/${appId}/${channel}/campaigns/${c.id}/edit${step}`, { replace: true })
    } catch (e) {
      setError(e)
    }
  }, [appId, channel, navigate, params])
  useEffect(() => {
    if (started.current) return
    started.current = true
    void run()
  }, [run])
  if (error) return <ErrorState error={error} onRetry={() => void run()} />
  return <FullPageSpinner />
}
