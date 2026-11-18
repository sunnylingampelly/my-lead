import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  Cloud,
  CloudOff,
  Filter,
  ListChecks,
  Loader2,
  Phone,
  PhoneCall,
  Plus,
  Settings2,
  Upload,
  Users,
  XCircle,
} from 'lucide-react'
import { useAudio, useCallers, useVoiceCampaign, useVoiceOptions, voiceApi, vqk } from '@/api/voice'
import { useLists, useSegments } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { ErrorState, FullPageSpinner } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { Checkbox } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import { TIMEZONES } from '@/lib/timezones'
import { cn } from '@/lib/utils'
import type { CampaignAudience } from '@/types/email'
import type { VoiceCampaign, VoiceCategory, VoiceLanguage } from '@/types/voice'
import { CampaignStatusBadge } from '../email/components'
import { formatMoney } from '../sms/format'
import { ScriptPreview, TtsForm } from './components'
import { CALLER_KIND_LABEL, CATEGORY_LABEL, formatDuration } from './format'

const STEPS = [
  { key: 'setup', label: 'Setup', icon: Settings2 },
  { key: 'message', label: 'Message', icon: AudioLines },
  { key: 'audience', label: 'Audience', icon: Users },
  { key: 'review', label: 'Review & call', icon: PhoneCall },
] as const
type StepKey = (typeof STEPS)[number]['key']
type Draft = Partial<VoiceCampaign>
type Update = (p: Draft, immediate?: boolean) => void

function useAutosave(appId: string, campaign: VoiceCampaign | undefined) {
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
      const saved = await voiceApi(appId).updateCampaign(campaign.id, body)
      qc.setQueryData(vqk.campaign(appId, campaign.id), saved)
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

function useCaller(draft: Draft) {
  const { app } = useWorkspace()
  const callers = useCallers(app!.id)
  return { callers, caller: callers.data?.find((c) => c.id === draft.caller_ref) ?? null }
}

// ------------------------------------------------------------------ steps

function SetupStep({ draft, update }: { draft: Draft; update: Update }) {
  const { app, can } = useWorkspace()
  const { callers, caller } = useCaller(draft)
  const wrongSeries = caller?.country === 'IN' && (caller.kind === 'series_140') !== (draft.category === 'promotional')
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Campaign</CardTitle>
          <CardDescription>The name is internal. People you call never see it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Campaign name" htmlFor="c-name">
            <Input id="c-name" value={draft.name ?? ''} onChange={(e) => update({ name: e.target.value })} maxLength={160} />
          </Field>
          <Field label="Call type" htmlFor="c-cat" hint="Promotional calls only go out inside the legal calling window: 09:00–21:00 in India, 08:00–21:00 in the US.">
            <div id="c-cat" className="grid grid-cols-3 gap-2" role="radiogroup">
              {(['promotional', 'transactional', 'service'] as VoiceCategory[]).map((k) => (
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
          <CardTitle>Caller ID</CardTitle>
          <CardDescription>The number people see. It also decides which country you can call.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {callers.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !callers.data?.length ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No caller IDs yet.{' '}
              {can('settings.write') ? (
                <Link className="font-medium text-primary hover:underline" to={`/apps/${app!.id}/voice/callers`}>
                  Add one
                </Link>
              ) : (
                'Ask an admin to add one.'
              )}
            </div>
          ) : (
            <div className="space-y-2" role="radiogroup" aria-label="Caller ID">
              {callers.data.map((c) => (
                <label key={c.id} className={cn('flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition', draft.caller_ref === c.id && 'border-primary bg-accent/40')}>
                  <input type="radio" className="accent-[hsl(var(--primary))]" checked={draft.caller_ref === c.id} onChange={() => update({ caller_ref: c.id })} />
                  <Phone className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-sm font-semibold">{c.number}</span>
                    <span className="block text-xs text-muted-foreground">
                      {c.country} · {CALLER_KIND_LABEL[c.kind]}
                      {c.label && ` · ${c.label}`}
                    </span>
                  </span>
                  {c.status === 'active' ? <span className="text-xs font-medium text-success-strong">Approved</span> : <span className="text-xs font-medium text-warning-strong">Not confirmed</span>}
                </label>
              ))}
            </div>
          )}
          {wrongSeries && (
            <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong">
              In India, promotional calls must come from a 140-series number and service or transactional calls from a 160-series number.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

const blankTts = (lang: VoiceLanguage): { name: string; tts_text: string; tts_language: VoiceLanguage; tts_voice: 'female' | 'male' } => ({ name: '', tts_text: '', tts_language: lang, tts_voice: 'female' })

function MessageStep({ draft, update, flush }: { draft: Draft; update: Update; flush: () => Promise<boolean> }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const audio = useAudio(app!.id)
  const options = useVoiceOptions(app!.id)
  const { caller } = useCaller(draft)
  const [tts, setTts] = useState<ReturnType<typeof blankTts> | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const defaultLang: VoiceLanguage = (caller?.country ?? app!.default_country) === 'US' ? 'en-US' : 'en-IN'
  const previewKey = [draft.audio_id, draft.intro_text, draft.opt_out_keypress]
  const [debounced, setDebounced] = useState(JSON.stringify(previewKey))
  useEffect(() => {
    const t = setTimeout(() => setDebounced(JSON.stringify(previewKey)), 900)
    return () => clearTimeout(t)
  }, [JSON.stringify(previewKey)]) // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useQuery({
    queryKey: [...vqk.preview(app!.id, draft.id!), debounced],
    queryFn: async () => {
      await flush()
      return voiceApi(app!.id).preview(draft.id!)
    },
    placeholderData: (p) => p,
  })
  const created = async (id: string) => {
    await qc.invalidateQueries({ queryKey: vqk.audio(app!.id) })
    update({ audio_id: id }, true)
  }
  const usStrict = caller?.country === 'US' && draft.category === 'promotional'
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>Message</CardTitle>
              <CardDescription>A recording you upload, or text spoken by the phone network’s voice. Text can be personalised.</CardDescription>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" loading={busy} onClick={() => fileRef.current?.click()}>
                <Upload /> Upload
              </Button>
              <Button size="sm" onClick={() => setTts(blankTts(defaultLang))}>
                <Plus /> Text to speech
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="audio/mpeg,audio/wav,.mp3,.wav"
                className="hidden"
                data-testid="audio-file"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (!f) return
                  setBusy(true)
                  try {
                    const a = await voiceApi(app!.id).uploadAudio(f, f.name.replace(/\.[^.]+$/, ''))
                    await created(a.id)
                    toast.success('Recording uploaded')
                  } catch (err) {
                    toast.error(errorMessage(err))
                  } finally {
                    setBusy(false)
                  }
                }}
              />
            </div>
          </CardHeader>
          <CardContent>
            {audio.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : !audio.data?.length ? (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Your audio library is empty. Upload an MP3 or WAV, or write a text-to-speech message.</p>
            ) : (
              <div className="grid max-h-80 gap-2 overflow-y-auto sm:grid-cols-2" role="radiogroup" aria-label="Message">
                {audio.data.map((a) => (
                  <label key={a.id} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition', draft.audio_id === a.id && 'border-primary bg-accent/40')}>
                    <input type="radio" className="mt-1 accent-[hsl(var(--primary))]" checked={draft.audio_id === a.id} onChange={() => update({ audio_id: a.id }, true)} aria-label={a.name} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{a.name}</span>
                        <Badge variant="secondary">{a.kind === 'tts' ? `TTS · ${a.tts_language}` : 'Recording'}</Badge>
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{a.kind === 'tts' ? a.tts_text : `${formatDuration(a.duration_seconds)} · ${a.content_type === 'audio/wav' ? 'WAV' : 'MP3'}`}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Call settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Introduction" htmlFor="c-intro" hint={usStrict ? 'Required for US marketing calls: say who is calling at the very start (TCPA).' : 'Spoken first. Saying who is calling builds trust and is required in the US.'}>
              <Input id="c-intro" value={draft.intro_text ?? ''} maxLength={300} onChange={(e) => update({ intro_text: e.target.value })} />
            </Field>
            <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
              <Checkbox checked={!!draft.opt_out_keypress} onChange={(e) => update({ opt_out_keypress: e.target.checked })} aria-label="Press 9 to opt out" />
              <span>
                <span className="font-medium">Offer “press 9 to stop these calls”</span>
                <span className="block text-xs text-muted-foreground">Pressing 9 removes consent and suppresses the number straight away. Required for US prerecorded marketing calls.</span>
              </span>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Attempts per person" htmlFor="c-att" hint="Busy and unanswered calls are retried.">
                <Select id="c-att" value={draft.max_attempts ?? 2} onChange={(e) => update({ max_attempts: Number(e.target.value) })}>
                  {[1, 2, 3].map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? '1 (no retries)' : `${n} attempts`}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Wait between attempts" htmlFor="c-delay">
                <Select id="c-delay" value={draft.retry_delay_minutes ?? 60} disabled={(draft.max_attempts ?? 2) < 2} onChange={(e) => update({ retry_delay_minutes: Number(e.target.value) })}>
                  {[15, 30, 60, 120, 240, 1440].map((n) => (
                    <option key={n} value={n}>
                      {n < 60 ? `${n} minutes` : n === 1440 ? 'Next day' : `${n / 60} hour${n > 60 ? 's' : ''}`}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </CardContent>
        </Card>
      </div>
      <div className="lg:sticky lg:top-20 lg:h-fit">
        <ScriptPreview steps={preview.data?.steps ?? []} language={preview.data?.language} seconds={preview.data?.seconds} label={preview.data?.contact_label} />
      </div>
      <Dialog open={!!tts} onOpenChange={(o) => !o && setTts(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>New text-to-speech message</DialogTitle>
            <DialogDescription>Saved to your audio library so you can reuse it.</DialogDescription>
          </DialogHeader>
          {tts && <TtsForm appId={app!.id} languages={options.data?.languages} value={tts} onChange={setTts} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTts(null)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!tts?.name.trim() || !tts?.tts_text.trim()}
              onClick={async () => {
                setBusy(true)
                try {
                  const a = await voiceApi(app!.id).createTts(tts!)
                  await created(a.id)
                  setTts(null)
                  toast.success('Message saved')
                } catch (e) {
                  toast.error(errorMessage(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Save message
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const EXCLUDE_LABEL: Record<string, string> = {
  no_phone: 'No phone number',
  unsubscribed: 'Opted out of calls',
  blocked: 'Blocked',
  suppressed: 'On the suppression list',
  no_consent: 'No consent to calls',
  other_country: 'Outside the caller ID’s country',
}

function AudienceStep({ draft, update }: { draft: Draft; update: Update }) {
  const { app } = useWorkspace()
  const { caller } = useCaller(draft)
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
  const est = useQuery({ queryKey: ['voice-estimate', app!.id, debounced, caller?.country], queryFn: () => voiceApi(app!.id).estimate(debounced, caller?.country), placeholderData: (p) => p })
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
          <CardTitle>Who should we call?</CardTitle>
          <CardDescription>People in more than one segment or list are called once. Only contacts with consent to calls are included.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition', aud.all && 'border-primary bg-accent/40')}>
            <input type="radio" className="mt-1 accent-[hsl(var(--primary))]" checked={!!aud.all} onChange={() => set({ all: true })} />
            <span>
              <span className="text-sm font-medium">All reachable contacts</span>
              <span className="block text-xs text-muted-foreground">Everyone with consent to calls and a number in the caller ID’s country.</span>
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
            <div className="text-xs text-muted-foreground">will be called{est.data ? ` · ${f(est.data.matched)} matched` : ''}</div>
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
              <p className="pt-1 text-xs text-muted-foreground">Consent, suppression and calling hours are checked again before every call.</p>
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
  const api = voiceApi(app!.id)
  const { caller } = useCaller(draft)
  const ready = useQuery({ queryKey: vqk.readiness(app!.id, draft.id!), queryFn: () => api.readiness(draft.id!), refetchOnMount: 'always' })
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
  const stepFor: Record<string, StepKey> = { caller: 'setup', category: 'setup', message: 'message', personalisation: 'message', identification: 'message', opt_out: 'message', audience: 'audience' }
  const linkFix: Record<string, string> = { registration: `/apps/${app!.id}/sms/registration`, provider: `/apps/${app!.id}/settings` }
  if (caller && caller.status !== 'active') linkFix.caller = `/apps/${app!.id}/voice/callers`
  const cost = ready.data?.cost

  const launch = async () => {
    setBusy(true)
    try {
      await flush()
      if (mode === 'now') {
        await api.send(draft.id!)
        toast.success('Calling has started')
      } else {
        await api.schedule(draft.id!, when, tz)
        toast.success('Campaign scheduled')
      }
      await qc.invalidateQueries({ queryKey: vqk.all(app!.id) })
      navigate(`/apps/${app!.id}/voice/campaigns/${draft.id}`)
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
            <CardDescription>Everything here must pass before calls can start.</CardDescription>
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
                      (linkFix[c.key] ? (
                        <Button size="sm" variant="outline" asChild>
                          <Link to={linkFix[c.key]!}>Fix</Link>
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
                ['Caller ID', caller ? `${caller.number} (${caller.country})` : '—', 'setup'],
                ['Type', CATEGORY_LABEL[draft.category ?? 'promotional'], 'setup'],
                ['Call length', ready.data ? `About ${formatDuration(ready.data.seconds)}` : '—', 'message'],
                ['Attempts', `${draft.max_attempts ?? 2} per person`, 'message'],
                ['Recipients', ready.data?.estimate ? `${f(eligible)} reachable contacts` : '—', 'audience'],
                ['Maximum cost', cost ? `${formatMoney(cost.total, cost.currency)} if everyone answers (${formatMoney(cost.per_minute, cost.currency)} per minute)` : '—', 'audience'],
              ].map(([k, v, step]) => (
                <div key={k} className="flex items-center gap-4 py-2.5">
                  <dt className="w-32 shrink-0 text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 flex-1 truncate" data-testid={k === 'Maximum cost' ? 'cost-estimate' : undefined}>
                    {v}
                  </dd>
                  <button className="text-xs font-medium text-primary hover:underline" onClick={() => goTo(step as StepKey)}>
                    Edit
                  </button>
                </div>
              ))}
            </dl>
            {ready.data && (
              <p className="mt-3 flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <Clock className="mt-0.5 size-3.5 shrink-0" />
                {draft.category === 'promotional'
                  ? `Calls are placed only between ${ready.data.window[0]} and ${ready.data.window[1]} in each person’s time zone, and outside your quiet hours. Others wait.`
                  : 'Calls respect your quiet hours in each person’s time zone.'}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Place a test call</CardTitle>
            <CardDescription>Up to three numbers, comma separated, in the caller ID’s country.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={caller?.country === 'US' ? '+1 415 555 2671' : '+91 98765 43210'} aria-label="Test phone numbers" />
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
                  else toast.success(`Test call placed${r.provider === 'simulation' ? ' in the development call log' : ''}`)
                } catch (e) {
                  toast.error(errorMessage(e))
                } finally {
                  setTesting(false)
                }
              }}
            >
              Call
            </Button>
          </CardContent>
        </Card>
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle>Start</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(['now', 'schedule'] as const).map((m) => (
              <label key={m} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3', mode === m && 'border-primary bg-accent/40')}>
                <input type="radio" className="mt-1 accent-[hsl(var(--primary))]" checked={mode === m} onChange={() => setMode(m)} />
                <span className="text-sm font-medium">{m === 'now' ? 'Start calling now' : 'Schedule for later'}</span>
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
              {mode === 'now' ? <PhoneCall /> : <CalendarClock />}
              {mode === 'now' ? `Call ${f(eligible)} contacts` : 'Schedule campaign'}
            </Button>
            {!ready.data?.ready && <p className="text-center text-xs text-muted-foreground">Complete the checklist to enable calling.</p>}
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={mode === 'now' ? `Call ${f(eligible)} contacts now?` : 'Schedule this campaign?'}
        description={
          mode === 'now'
            ? `At most ${cost ? formatMoney(cost.total, cost.currency) : '—'}. You can pause or cancel at any time; calls already connected cannot be undone.`
            : `Calling starts at ${when.replace('T', ' ')} (${tz}). You can unschedule it until then.`
        }
        confirmLabel={mode === 'now' ? 'Start calling' : 'Schedule'}
        loading={busy}
        onConfirm={launch}
      />
    </div>
  )
}

// ------------------------------------------------------------------ page

export function VoiceCampaignEditorPage() {
  const { campaignId } = useParams()
  const { app, can } = useWorkspace()
  const appId = app!.id
  const q = useVoiceCampaign(appId, campaignId!)
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
    if (draft.caller_ref && draft.name) d.add('setup')
    if (draft.audio_id) d.add('message')
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
            It is {c.status}. {c.status === 'scheduled' ? 'Unschedule it to make changes.' : 'Duplicate it to call again.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          {c.status === 'scheduled' && can('campaigns.launch') && (
            <Button
              onClick={async () => {
                await voiceApi(appId).unschedule(c.id)
                await qc.invalidateQueries({ queryKey: vqk.all(appId) })
              }}
            >
              Unschedule and edit
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link to={`/apps/${appId}/voice/campaigns/${c.id}`}>View campaign</Link>
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
            navigate(`/apps/${appId}/voice/campaigns`)
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
      {step === 'message' && <MessageStep draft={draft} update={update} flush={flush} />}
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

export function NewVoiceCampaignButton({ variant = 'default', label = 'New voice campaign', audioId, name }: { variant?: 'default' | 'outline'; label?: string; audioId?: string; name?: string }) {
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
          const c = await voiceApi(app!.id).createCampaign({ name: name ?? `Calls ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`, audio_id: audioId })
          navigate(`/apps/${app!.id}/voice/campaigns/${c.id}/edit`)
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
