import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Cloud,
  CloudOff,
  FileCheck2,
  Filter,
  ListChecks,
  Loader2,
  MessageSquare,
  Plus,
  Send,
  Settings2,
  Users,
  XCircle,
} from 'lucide-react'
import { smsApi, sqk, useSmsCampaign, useSmsSenders, useSmsTemplates } from '@/api/sms'
import { useLists, useSegments } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { ErrorState, FullPageSpinner } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { Skeleton } from '@/components/ui/misc'
import { Checkbox } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import { analyseSms, finalBody, OPT_OUT_TEXT, personaliseSample, toDltPattern } from '@/lib/smsEncoding'
import { TIMEZONES } from '@/lib/timezones'
import { cn } from '@/lib/utils'
import type { CampaignAudience } from '@/types/email'
import type { SmsCampaign, SmsCategory } from '@/types/sms'
import { CampaignStatusBadge } from '../email/components'
import { PhonePreview, SmsComposer } from './components'
import { CATEGORY_LABEL, COUNTRY_FLAG, formatMoney, KIND_LABEL } from './format'

const STEPS = [
  { key: 'setup', label: 'Setup', icon: Settings2 },
  { key: 'message', label: 'Message', icon: MessageSquare },
  { key: 'audience', label: 'Audience', icon: Users },
  { key: 'review', label: 'Review & send', icon: Send },
] as const
type StepKey = (typeof STEPS)[number]['key']
type Draft = Partial<SmsCampaign>

function useAutosave(appId: string, campaign: SmsCampaign | undefined) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Draft>({})
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const pending = useRef<Draft>({})
  const timer = useRef<number | undefined>(undefined)
  const loaded = useRef(false)
  useEffect(() => {
    if (campaign && !loaded.current) {
      loaded.current = true
      setDraft(campaign)
    }
  }, [campaign])
  const flush = useCallback(async () => {
    window.clearTimeout(timer.current)
    const body = pending.current
    if (!campaign || !Object.keys(body).length) return true
    pending.current = {}
    setState('saving')
    try {
      const saved = await smsApi(appId).updateCampaign(campaign.id, body)
      qc.setQueryData(sqk.campaign(appId, campaign.id), saved)
      // A template choice fills body, category and sender on the server; reflect it.
      if ('template_id' in body) setDraft((d) => ({ ...d, body: saved.body, category: saved.category, sender_ref: saved.sender_ref }))
      setState('saved')
      return true
    } catch (e) {
      pending.current = { ...body, ...pending.current }
      setState('error')
      toast.error(errorMessage(e))
      return false
    }
  }, [appId, campaign, qc])
  const update = useCallback(
    (patch: Draft, immediate = false) => {
      setDraft((d) => ({ ...d, ...patch }))
      pending.current = { ...pending.current, ...patch }
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(flush, immediate ? 0 : 800)
    },
    [flush],
  )
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return { draft, update, flush, state }
}

function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (state === 'saving')
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Saving…
      </span>
    )
  if (state === 'error')
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <CloudOff className="size-3.5" /> Not saved
      </span>
    )
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="save-state">
      <Cloud className="size-3.5" /> {state === 'saved' ? 'All changes saved' : 'Draft'}
    </span>
  )
}

type Update = (p: Draft, immediate?: boolean) => void

function useSender(draft: Draft) {
  const { app } = useWorkspace()
  const senders = useSmsSenders(app!.id)
  return { senders, sender: senders.data?.find((s) => s.id === draft.sender_ref) ?? null }
}

// ------------------------------------------------------------------ steps

function SetupStep({ draft, update }: { draft: Draft; update: Update }) {
  const { app, can } = useWorkspace()
  const { senders, sender } = useSender(draft)
  const templates = useSmsTemplates(app!.id)
  const base = `/apps/${app!.id}/sms`
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Campaign</CardTitle>
          <CardDescription>The name is internal. Recipients never see it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Campaign name" htmlFor="c-name">
            <Input id="c-name" value={draft.name ?? ''} onChange={(e) => update({ name: e.target.value })} maxLength={160} />
          </Field>
          <Field label="Message type" htmlFor="c-cat" hint="Promotional texts respect quiet hours and need marketing consent. Transactional and service texts are for things the contact asked for.">
            <div id="c-cat" className="grid grid-cols-3 gap-2" role="radiogroup">
              {(['promotional', 'transactional', 'service'] as SmsCategory[]).map((k) => (
                <button
                  key={k}
                  role="radio"
                  aria-checked={draft.category === k}
                  onClick={() => update({ category: k })}
                  className={cn('rounded-lg border px-3 py-2 text-sm font-medium transition', draft.category === k ? 'border-primary bg-accent/50 text-foreground' : 'text-muted-foreground hover:bg-muted')}
                >
                  {CATEGORY_LABEL[k]}
                </button>
              ))}
            </div>
          </Field>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sender ID</CardTitle>
          <CardDescription>The header or number recipients see. It also decides the country you can text.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {senders.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !senders.data?.length ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No sender IDs yet.{' '}
              {can('settings.write') ? (
                <Link className="font-medium text-primary hover:underline" to={`${base}/senders`}>
                  Add one
                </Link>
              ) : (
                'Ask an admin to add one.'
              )}
            </div>
          ) : (
            <div className="space-y-2" role="radiogroup" aria-label="Sender ID">
              {senders.data.map((s) => (
                <label key={s.id} className={cn('flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition', draft.sender_ref === s.id && 'border-primary bg-accent/40')}>
                  <input type="radio" className="accent-[hsl(var(--primary))]" checked={draft.sender_ref === s.id} onChange={() => update({ sender_ref: s.id })} />
                  <span className="text-lg" aria-hidden>
                    {COUNTRY_FLAG[s.country]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-sm font-semibold">{s.sender_id}</span>
                    <span className="block text-xs text-muted-foreground">{KIND_LABEL[s.kind]}</span>
                  </span>
                  {s.status === 'active' ? (
                    <span className="text-xs font-medium text-success-strong">Approved</span>
                  ) : (
                    <span className="text-xs font-medium text-warning-strong">Not confirmed</span>
                  )}
                </label>
              ))}
            </div>
          )}
          {sender?.country === 'IN' && (
            <Field label="DLT content template" htmlFor="c-tpl" hint="Indian operators only deliver text that matches a registered DLT template.">
              <Select id="c-tpl" value={draft.template_id ?? ''} onChange={(e) => update({ template_id: e.target.value || null }, true)}>
                <option value="">Choose a template…</option>
                {templates.data?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.dlt_template_id ? ` · DLT ${t.dlt_template_id}` : ' · no DLT ID'}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {sender?.country !== 'IN' && !!templates.data?.length && (
            <Field label="Start from a template (optional)" htmlFor="c-tpl2">
              <Select id="c-tpl2" value={draft.template_id ?? ''} onChange={(e) => update({ template_id: e.target.value || null }, true)}>
                <option value="">Write from scratch</option>
                {templates.data.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function MessageStep({ draft, update }: { draft: Draft; update: Update }) {
  const { app } = useWorkspace()
  const { sender } = useSender(draft)
  const templates = useSmsTemplates(app!.id)
  const tpl = templates.data?.find((t) => t.id === draft.template_id)
  const country = sender?.country
  const body = draft.body ?? ''
  const showOptOut = country === 'US' && draft.category === 'promotional'
  const suffix = showOptOut && draft.append_opt_out && !body.toLowerCase().includes('stop') ? OPT_OUT_TEXT : undefined
  const preview = finalBody(personaliseSample(body), country, draft.category ?? 'promotional', !!draft.append_opt_out)
  const dltOk = tpl?.dlt_template_text ? toDltPattern(body) === toDltPattern(tpl.dlt_template_text.replace(/\{#\s*var\s*#\}/gi, '{#var#}')) : null
  const info = analyseSms(finalBody(body, country, draft.category ?? 'promotional', !!draft.append_opt_out))
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Message</CardTitle>
            <CardDescription>Keep it short. Long texts are split into parts, and each part is billed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <SmsComposer appId={app!.id} value={body} onChange={(v) => update({ body: v })} suffix={suffix} />
            {showOptOut && (
              <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
                <Checkbox checked={!!draft.append_opt_out} onChange={(e) => update({ append_opt_out: e.target.checked })} aria-label="Add opt-out text" />
                <span>
                  <span className="font-medium">Add “{OPT_OUT_TEXT}”</span>
                  <span className="block text-xs text-muted-foreground">US carriers and the TCPA expect opt-out instructions in marketing texts. Skipped if your message already mentions STOP.</span>
                </span>
              </label>
            )}
            {country === 'IN' && (
              <div className={cn('rounded-lg border p-3 text-sm', dltOk === false ? 'border-danger-border bg-danger-soft' : dltOk ? 'border-success-border bg-success-soft' : 'bg-muted/40')} data-testid="dlt-match">
                <div className="flex items-center gap-2 font-medium">
                  <FileCheck2 className="size-4" />
                  {dltOk === null ? 'Choose a DLT template in Setup' : dltOk ? 'Matches the registered DLT template' : 'Does not match the registered DLT template'}
                </div>
                {tpl?.dlt_template_text && (
                  <div className="mt-2 space-y-1 font-mono text-xs">
                    <div>
                      <span className="text-muted-foreground">Registered: </span>
                      {tpl.dlt_template_text}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Your text: </span>
                      {toDltPattern(body) || '—'}
                    </div>
                  </div>
                )}
                {dltOk === false && <p className="mt-2 text-xs">Edit the text so only the {'{#var#}'} positions differ, or register a new template on your DLT portal.</p>}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <div className="space-y-3 lg:sticky lg:top-20 lg:h-fit">
        <PhonePreview sender={sender?.sender_id} text={preview} label="Preview with sample data (Asha Rao)" />
        <p className="text-center text-xs text-muted-foreground">
          {info.segments} {info.segments === 1 ? 'part' : 'parts'} per recipient · {info.encoding}
        </p>
      </div>
    </div>
  )
}

const EXCLUDE_LABEL: Record<string, string> = {
  no_phone: 'No phone number',
  landline: 'Landline numbers',
  unsubscribed: 'Unsubscribed from SMS',
  blocked: 'Blocked',
  suppressed: 'On the suppression list',
  no_consent: 'No SMS marketing consent',
  other_country: 'Outside the sender’s country',
}

function AudienceStep({ draft, update }: { draft: Draft; update: Update }) {
  const { app } = useWorkspace()
  const { sender } = useSender(draft)
  const segments = useSegments(app!.id)
  const lists = useLists(app!.id)
  const aud: CampaignAudience = draft.audience ?? {}
  const set = (a: CampaignAudience) => update({ audience: { all: false, list_ids: [], segment_ids: [], ...a } })
  const key = JSON.stringify(aud)
  const [debounced, setDebounced] = useState(aud)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(JSON.parse(key) as CampaignAudience), 300)
    return () => clearTimeout(t)
  }, [key])
  const est = useQuery({ queryKey: ['sms-estimate', app!.id, debounced, sender?.country], queryFn: () => smsApi(app!.id).estimate(debounced, sender?.country), placeholderData: (p) => p })
  const f = (n: number) => formatCount(n, app!.default_country)
  const toggle = (k: 'list_ids' | 'segment_ids', id: string, on: boolean) => {
    const cur = new Set(aud[k] ?? [])
    if (on) cur.add(id)
    else cur.delete(id)
    set({ ...aud, all: false, [k]: [...cur] })
  }
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Card>
        <CardHeader>
          <CardTitle>Who should receive this?</CardTitle>
          <CardDescription>
            People in more than one segment or list get one text. {sender && `Only numbers in ${sender.country === 'IN' ? 'India' : 'the United States'} can be reached from ${sender.sender_id}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition', aud.all && 'border-primary bg-accent/40')}>
            <input type="radio" className="mt-1 accent-[hsl(var(--primary))]" checked={!!aud.all} onChange={() => set({ all: true })} />
            <span>
              <span className="text-sm font-medium">All reachable contacts</span>
              <span className="block text-xs text-muted-foreground">Everyone with SMS consent and a mobile number.</span>
            </span>
          </label>
          <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition', !aud.all && 'border-primary bg-accent/40')}>
            <input type="radio" className="mt-1 accent-[hsl(var(--primary))]" checked={!aud.all} onChange={() => set({ ...aud, all: false })} />
            <span className="text-sm font-medium">Specific segments and lists</span>
          </label>
          {!aud.all && (
            <div className="grid gap-4 md:grid-cols-2">
              {(
                [
                  ['segment_ids', 'Segments', Filter, segments.data?.map((s) => ({ id: s.id, name: s.name, n: s.last_count }))],
                  ['list_ids', 'Lists', ListChecks, lists.data?.map((l) => ({ id: l.id, name: l.name, n: l.contact_count }))],
                ] as const
              ).map(([k, label, Icon, items]) => (
                <div key={k}>
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Icon className="size-3.5" /> {label}
                  </div>
                  <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2">
                    {items?.length === 0 && <p className="p-2 text-sm text-muted-foreground">None yet.</p>}
                    {items?.map((it) => (
                      <label key={it.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                        <Checkbox checked={aud[k]?.includes(it.id) ?? false} onChange={(e) => toggle(k, it.id, e.target.checked)} aria-label={it.name} />
                        <span className="flex-1 truncate">{it.name}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">{it.n === null ? '—' : f(it.n)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card className="h-fit lg:sticky lg:top-20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Estimated recipients {est.isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="text-4xl font-semibold tabular-nums tracking-tight" data-testid="eligible-count">
              {est.data ? f(est.data.eligible) : '—'}
            </div>
            <div className="text-xs text-muted-foreground">will receive this text{est.data ? ` · ${f(est.data.matched)} matched` : ''}</div>
          </div>
          {est.data && est.data.matched > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Excluded automatically</div>
              {Object.entries(est.data.excluded).map(([k, n]) => (
                <div key={k} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{EXCLUDE_LABEL[k] ?? k}</span>
                  <span className={cn('tabular-nums', n > 0 ? 'font-medium' : 'text-muted-foreground')}>{f(n)}</span>
                </div>
              ))}
              <p className="pt-1 text-xs text-muted-foreground">Consent, suppression and quiet hours are checked again for each person at the moment of sending.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ReviewStep({ draft, goTo, flush }: { draft: Draft; goTo: (s: StepKey) => void; flush: () => Promise<boolean> }) {
  const { app } = useWorkspace()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const api = smsApi(app!.id)
  const { sender } = useSender(draft)
  const ready = useQuery({ queryKey: sqk.readiness(app!.id, draft.id!), queryFn: () => api.readiness(draft.id!), refetchOnMount: 'always' })
  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 60 * 60 * 1000)
    d.setMinutes(0, 0, 0)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
  const [tz, setTz] = useState(app!.timezone)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const eligible = ready.data?.estimate?.eligible ?? 0
  const f = (n: number) => formatCount(n, app!.default_country)
  const stepFor: Record<string, StepKey> = { sender: 'setup', category: 'setup', dlt_template: 'setup', content: 'message', personalisation: 'message', opt_out: 'message', audience: 'audience' }
  const settingsFix: Record<string, string> = { registration: `/apps/${app!.id}/sms/registration`, provider: `/apps/${app!.id}/settings` }
  if (ready.data?.checks.some((c) => c.key === 'sender' && !c.ok && sender)) settingsFix.sender = `/apps/${app!.id}/sms/senders`
  const cost = ready.data?.cost

  const launch = async () => {
    setBusy(true)
    try {
      await flush()
      if (mode === 'now') {
        await api.send(draft.id!)
        toast.success('Campaign is sending')
      } else {
        await api.schedule(draft.id!, when, tz)
        toast.success('Campaign scheduled')
      }
      await qc.invalidateQueries({ queryKey: sqk.all(app!.id) })
      navigate(`/apps/${app!.id}/sms/campaigns/${draft.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
      ready.refetch()
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Compliance checklist</CardTitle>
            <CardDescription>Everything here must pass before the campaign can be sent.</CardDescription>
          </CardHeader>
          <CardContent>
            {ready.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <ul className="divide-y" data-testid="readiness">
                {ready.data?.checks.map((c) => (
                  <li key={c.key} className="flex items-start gap-3 py-3">
                    {c.ok ? <CheckCircle2 className="mt-0.5 size-5 text-success-strong" /> : <XCircle className="mt-0.5 size-5 text-destructive" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{c.label}</div>
                      {c.detail && <div className="text-xs text-muted-foreground">{c.detail}</div>}
                    </div>
                    {!c.ok &&
                      (settingsFix[c.key] ? (
                        <Button size="sm" variant="outline" asChild>
                          <Link to={settingsFix[c.key]!}>Fix</Link>
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => goTo(stepFor[c.key] ?? 'setup')}>
                          Fix
                        </Button>
                      ))}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y text-sm">
              {[
                ['From', sender ? `${COUNTRY_FLAG[sender.country]} ${sender.sender_id}` : '—', 'setup'],
                ['Type', CATEGORY_LABEL[draft.category ?? 'promotional'], 'setup'],
                ['Message', ready.data ? `${ready.data.message.segments} part(s) · ${ready.data.message.encoding}` : '—', 'message'],
                ['Recipients', ready.data?.estimate ? `${f(eligible)} reachable contacts` : '—', 'audience'],
                ['Estimated cost', cost ? `${formatMoney(cost.total, cost.currency)} (${formatMoney(cost.unit_price, cost.currency)} per part)` : '—', 'audience'],
              ].map(([k, v, step]) => (
                <div key={k} className="flex items-center gap-4 py-2.5">
                  <dt className="w-32 shrink-0 text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 flex-1 truncate" data-testid={k === 'Estimated cost' ? 'cost-estimate' : undefined}>
                    {v}
                  </dd>
                  <button className="text-xs font-medium text-primary hover:underline" onClick={() => goTo(step as StepKey)}>
                    Edit
                  </button>
                </div>
              ))}
            </dl>
            {draft.category === 'promotional' && (
              <p className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                Promotional texts are held during quiet hours in each recipient’s time zone and sent when the window ends.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        {ready.data && <PhonePreview sender={sender?.sender_id} text={ready.data.message.text} label="Sample personalisation" />}
        <Card>
          <CardHeader>
            <CardTitle>Send a test</CardTitle>
            <CardDescription>Up to five numbers, comma separated, in the sender’s country.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={sender?.country === 'US' ? '+1 415 555 2671' : '+91 98765 43210'} aria-label="Test phone numbers" />
            <Button
              variant="outline"
              loading={testing}
              disabled={!testTo.trim()}
              onClick={async () => {
                setTesting(true)
                try {
                  await flush()
                  const r = await api.test(draft.id!, testTo.split(',').map((s) => s.trim()).filter(Boolean))
                  const failed = r.results.filter((x) => !x.accepted)
                  if (failed.length) toast.error(failed.map((x) => `${x.phone}: ${x.error}`).join('\n'))
                  else toast.success(`Test sent${r.provider === 'simulation' ? ' to the development SMS outbox' : ''}`)
                } catch (e) {
                  toast.error(errorMessage(e))
                } finally {
                  setTesting(false)
                }
              }}
            >
              Send test
            </Button>
          </CardContent>
        </Card>
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle>Delivery</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(['now', 'schedule'] as const).map((m) => (
              <label key={m} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3', mode === m && 'border-primary bg-accent/40')}>
                <input type="radio" className="mt-1 accent-[hsl(var(--primary))]" checked={mode === m} onChange={() => setMode(m)} />
                <span className="text-sm font-medium">{m === 'now' ? 'Send now' : 'Schedule for later'}</span>
              </label>
            ))}
            {mode === 'schedule' && (
              <div className="grid gap-3">
                <Field label="Date and time" htmlFor="s-when">
                  <Input id="s-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                </Field>
                <Field label="Time zone" htmlFor="s-tz">
                  <Select id="s-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
                    {TIMEZONES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            <Button className="w-full" size="lg" disabled={!ready.data?.ready} onClick={() => setConfirm(true)} data-testid="launch">
              {mode === 'now' ? <Send /> : <CalendarClock />}
              {mode === 'now' ? `Send to ${f(eligible)} contacts` : 'Schedule campaign'}
            </Button>
            {!ready.data?.ready && <p className="text-center text-xs text-muted-foreground">Complete the checklist to enable sending.</p>}
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={mode === 'now' ? `Text ${f(eligible)} contacts now?` : 'Schedule this campaign?'}
        description={
          mode === 'now'
            ? `Estimated cost ${cost ? formatMoney(cost.total, cost.currency) : '—'}. You can pause or cancel while it is sending, but texts already sent cannot be recalled.`
            : `It will be sent at ${when.replace('T', ' ')} (${tz}). You can unschedule it until then.`
        }
        confirmLabel={mode === 'now' ? 'Send now' : 'Schedule'}
        loading={busy}
        onConfirm={launch}
      />
    </div>
  )
}

// ------------------------------------------------------------------ page

export function SmsCampaignEditorPage() {
  const { campaignId } = useParams()
  const { app, can } = useWorkspace()
  const appId = app!.id
  const q = useSmsCampaign(appId, campaignId!)
  const { draft, update, flush, state } = useAutosave(appId, q.data)
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const step = (params.get('step') as StepKey) || 'setup'
  const idx = STEPS.findIndex((s) => s.key === step)
  const goTo = useCallback(
    async (s: StepKey) => {
      await flush()
      setParams({ step: s }, { replace: true })
      window.scrollTo({ top: 0 })
    },
    [flush, setParams],
  )
  const doneSteps = useMemo(() => {
    const d = new Set<StepKey>()
    if (draft.sender_ref && draft.name) d.add('setup')
    if (draft.body?.trim()) d.add('message')
    if (draft.audience?.all || draft.audience?.segment_ids?.length || draft.audience?.list_ids?.length) d.add('audience')
    return d
  }, [draft])

  if (q.isLoading) return <FullPageSpinner />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const c = q.data!

  if (c.status !== 'draft')
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>This campaign can't be edited</CardTitle>
          <CardDescription>
            It is {c.status}. {c.status === 'scheduled' ? 'Unschedule it to make changes.' : 'Duplicate it to send a new version.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          {c.status === 'scheduled' && can('campaigns.launch') && (
            <Button
              onClick={async () => {
                await smsApi(appId).unschedule(c.id)
                await qc.invalidateQueries({ queryKey: sqk.all(appId) })
              }}
            >
              Unschedule and edit
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link to={`/apps/${appId}/sms/campaigns/${c.id}`}>View campaign</Link>
          </Button>
        </CardContent>
      </Card>
    )

  return (
    <div className="-mt-2">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back to campaigns"
          onClick={async () => {
            await flush()
            navigate(`/apps/${appId}/sms/campaigns`)
          }}
        >
          <ArrowLeft />
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{draft.name || 'Untitled campaign'}</h1>
            <CampaignStatusBadge status={c.status} />
          </div>
          <SaveIndicator state={state} />
        </div>
        <nav className="ml-auto flex items-center gap-1 rounded-xl border bg-card p-1 shadow-card" aria-label="Campaign steps">
          {STEPS.map((s, i) => (
            <button
              key={s.key}
              onClick={() => goTo(s.key)}
              aria-current={step === s.key ? 'step' : undefined}
              className={cn('flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition', step === s.key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
            >
              <span className={cn('flex size-5 items-center justify-center rounded-full text-[11px]', step === s.key ? 'bg-white/20' : doneSteps.has(s.key) ? 'bg-success-soft text-success-strong' : 'bg-muted')}>
                {doneSteps.has(s.key) && step !== s.key ? <Check className="size-3" /> : i + 1}
              </span>
              <span className="hidden md:inline">{s.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {step === 'setup' && <SetupStep draft={draft} update={update} />}
      {step === 'message' && <MessageStep draft={draft} update={update} />}
      {step === 'audience' && <AudienceStep draft={draft} update={update} />}
      {step === 'review' && <ReviewStep draft={draft} goTo={goTo} flush={flush} />}

      {step !== 'review' && (
        <div className="mt-6 flex justify-between">
          <Button variant="outline" disabled={idx === 0} onClick={() => goTo(STEPS[idx - 1]!.key)}>
            <ArrowLeft /> Back
          </Button>
          <Button onClick={() => goTo(STEPS[idx + 1]!.key)}>
            Next: {STEPS[idx + 1]!.label} <ArrowRight />
          </Button>
        </div>
      )}
    </div>
  )
}

export function NewSmsCampaignButton({ variant = 'default', label = 'New SMS campaign' }: { variant?: 'default' | 'outline'; label?: string }) {
  const { app } = useWorkspace()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant={variant}
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const c = await smsApi(app!.id).createCampaign({ name: `SMS ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` })
          navigate(`/apps/${app!.id}/sms/campaigns/${c.id}/edit`)
        } catch (e) {
          toast.error(errorMessage(e))
        } finally {
          setBusy(false)
        }
      }}
    >
      <Plus /> {label}
    </Button>
  )
}
