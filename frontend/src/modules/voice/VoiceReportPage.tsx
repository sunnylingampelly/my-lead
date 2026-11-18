import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { Ban, CalendarClock, Clock, Copy, FlaskConical, Info, Pause, Pencil, Play, Search, ShieldAlert, Trash2 } from 'lucide-react'
import { useVoiceCampaign, useVoiceReport, voiceApi, vqk } from '@/api/voice'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, FullPageSpinner, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Tooltip } from '@/components/ui/tooltip'
import { Pagination } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount, formatPhone } from '@/lib/regions'
import { cn, formatDateTime, timeAgo } from '@/lib/utils'
import { CampaignStatusBadge, pct } from '../email/components'
import { formatMoney } from '../sms/format'
import { CALL_STATUS, CATEGORY_LABEL, formatDuration } from './format'

// Outcome colours: answered is the good state; the rest are neutral-to-warning, failures red.
const OUTCOMES = [
  ['answered', 'Answered', 'bg-success-strong'],
  ['voicemail', 'Voicemail', 'bg-primary'],
  ['no_answer', 'No answer', 'bg-warning'],
  ['busy', 'Busy', 'bg-amber-700'],
  ['failed', 'Failed', 'bg-destructive'],
] as const

function Kpi({ label, value, sub, help }: { label: string; value: string; sub?: string; help: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-card">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {label}
        <Tooltip content={help}>
          <button aria-label={`About ${label}`} className="text-muted-foreground/70 hover:text-foreground">
            <Info className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

const FILTERS = [
  ['', 'All'],
  ['completed', 'Answered'],
  ['voicemail', 'Voicemail'],
  ['no_answer', 'No answer'],
  ['busy', 'Busy'],
  ['failed', 'Failed'],
  ['opted_out', 'Opted out'],
  ['deferred', 'Waiting'],
  ['skipped', 'Skipped'],
] as const

function Calls({ campaignId, currency }: { campaignId: string; currency: string | null }) {
  const { app } = useWorkspace()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const q = useQuery({
    queryKey: ['voice', app!.id, 'calls', campaignId, status, search, page],
    queryFn: () => voiceApi(app!.id).calls(campaignId, { page, page_size: 25, status: status || undefined, search: search || undefined }),
    placeholderData: (p) => p,
    refetchInterval: 5000,
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Calls</CardTitle>
        <CardDescription>Every person, their latest attempt and how it ended.</CardDescription>
      </CardHeader>
      <div className="flex flex-wrap items-center gap-2 border-y p-3">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => {
                setStatus(k)
                setPage(1)
              }}
              className={cn('rounded-full px-3 py-1.5 text-xs font-medium transition', status === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full sm:w-56">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search number" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} aria-label="Search calls" />
        </div>
      </div>
      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data?.items.length ? (
        <p className="p-6 text-center text-sm text-muted-foreground">No calls match.</p>
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Number</TH>
                <TH>Outcome</TH>
                <TH className="text-right">Attempts</TH>
                <TH className="text-right">Duration</TH>
                <TH className="text-right">Cost</TH>
                <TH>Detail</TH>
                <TH>Updated</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((c) => {
                const meta = c.status === 'queued' && c.attempts > 0 ? { label: 'Retrying', variant: 'warning' as const } : (CALL_STATUS[c.status] ?? { label: c.status, variant: 'secondary' as const })
                return (
                  <TR key={c.id}>
                    <TD>
                      {c.contact_id ? (
                        <Link className="font-mono text-sm hover:text-primary" to={`/apps/${app!.id}/audience/contacts/${c.contact_id}`}>
                          {formatPhone(c.to_phone)}
                        </Link>
                      ) : (
                        <span className="font-mono text-sm">{formatPhone(c.to_phone)}</span>
                      )}
                    </TD>
                    <TD>
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                        {c.opted_out && <Badge variant="destructive">Pressed 9</Badge>}
                      </span>
                    </TD>
                    <TD className="text-right tabular-nums">{c.attempts}</TD>
                    <TD className="text-right tabular-nums">{c.duration_seconds ? formatDuration(c.duration_seconds) : '—'}</TD>
                    <TD className="text-right tabular-nums">{c.cost && Number(c.cost) > 0 ? formatMoney(c.cost, currency) : '—'}</TD>
                    <TD className="max-w-xs truncate text-xs text-muted-foreground">
                      {c.next_attempt_at && ['queued', 'deferred'].includes(c.status)
                        ? `${c.deferred_reason === 'calling_window' ? 'Outside calling hours' : 'Retry'} · ${formatDateTime(c.next_attempt_at)}`
                        : c.error_message ?? (c.answered_by === 'machine' ? 'Answering machine' : c.answered_at ? `Answered ${formatDateTime(c.answered_at)}` : '')}
                    </TD>
                    <TD className="text-xs text-muted-foreground">{timeAgo(c.updated_at)}</TD>
                  </TR>
                )
              })}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={25} total={q.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  )
}

export function VoiceReportPage() {
  const { campaignId } = useParams()
  const { app, org, can } = useWorkspace()
  const appId = app!.id
  const api = voiceApi(appId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const c = useVoiceCampaign(appId, campaignId!)
  const live = !!c.data && ['queued', 'sending'].includes(c.data.status)
  const rep = useVoiceReport(appId, campaignId!, live)
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)
  const f = (n: number) => formatCount(n, app!.default_country)
  const base = `/apps/${appId}/voice`

  if (c.isLoading) return <FullPageSpinner />
  if (c.isError) return <ErrorState error={c.error} onRetry={() => c.refetch()} />
  const camp = c.data!
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: vqk.all(appId) })
      toast.success(msg)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }
  const st = rep.data?.stats ?? camp.stats
  const out = rep.data?.outcomes
  const outTotal = out ? Object.values(out).reduce((a, b) => a + b, 0) : 0
  const done = st ? st.answered + st.voicemail + st.no_answer + st.busy + st.failed + st.skipped : 0
  const progress = camp.recipient_count ? Math.round((100 * done) / camp.recipient_count) : 0
  const launchable = can('campaigns.launch')
  const waiting = rep.data?.waiting ?? []
  const snap = camp.snapshot as { caller_number?: string; audio_name?: string }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${appId}` }, { label: 'Voice', to: base }, { label: 'Campaigns', to: `${base}/campaigns` }, { label: camp.name }]}
        title={camp.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <CampaignStatusBadge status={camp.status} />
            <span>{CATEGORY_LABEL[camp.category]}</span>
            {snap.caller_number && (
              <span>
                · from <span className="font-mono">{snap.caller_number}</span>
              </span>
            )}
            {snap.audio_name && <span>· “{snap.audio_name}”</span>}
            {camp.launched_at && <span>· started {formatDateTime(camp.launched_at)}</span>}
            {camp.status === 'scheduled' && camp.scheduled_at && (
              <span className="flex items-center gap-1">
                <CalendarClock className="size-3.5" /> {formatDateTime(camp.scheduled_at)} ({camp.schedule_timezone})
              </span>
            )}
          </span>
        }
        actions={
          <>
            {camp.status === 'draft' && can('campaigns.write') && (
              <Button asChild>
                <Link to={`${base}/campaigns/${camp.id}/edit`}>
                  <Pencil /> Continue editing
                </Link>
              </Button>
            )}
            {camp.status === 'scheduled' && launchable && (
              <Button variant="outline" loading={busy} onClick={() => act(() => api.unschedule(camp.id), 'Campaign unscheduled')}>
                Unschedule
              </Button>
            )}
            {['queued', 'sending'].includes(camp.status) && launchable && (
              <Button variant="outline" loading={busy} onClick={() => act(() => api.pause(camp.id), 'Calling paused')}>
                <Pause /> Pause
              </Button>
            )}
            {camp.status === 'paused' && launchable && (
              <Button loading={busy} onClick={() => act(() => api.resume(camp.id), 'Calling resumed')}>
                <Play /> Resume
              </Button>
            )}
            {['queued', 'sending', 'paused'].includes(camp.status) && launchable && (
              <Button variant="outline" className="text-destructive" onClick={() => setConfirm('cancel')}>
                <Ban /> Cancel
              </Button>
            )}
            {can('campaigns.write') && (
              <Button variant="outline" onClick={() => act(async () => { const d = await api.duplicateCampaign(camp.id); navigate(`${base}/campaigns/${d.id}/edit`) }, 'Campaign duplicated')}>
                <Copy /> Duplicate
              </Button>
            )}
            {camp.status === 'draft' && can('campaigns.write') && (
              <Button variant="ghost" size="icon" aria-label="Delete draft" onClick={() => setConfirm('delete')}>
                <Trash2 />
              </Button>
            )}
          </>
        }
      />

      {rep.data?.simulated && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-warning-border bg-warning-soft px-4 py-3 text-sm text-warning-strong">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          <div>
            <strong>Simulation mode.</strong> Nobody was called and nothing was charged. Numbers ending 0000 don’t answer, 2222 are busy, 3333 go to voicemail, 9999 press 9 and 1111 are rejected. See the{' '}
            <a className="font-semibold underline" href="/dev/calls" target="_blank" rel="noreferrer">
              development call log
            </a>
            .
          </div>
        </div>
      )}
      {camp.status === 'failed' && camp.error && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-danger-border bg-danger-soft px-4 py-3 text-sm text-danger-strong">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" /> {camp.error}
        </div>
      )}

      {camp.status === 'draft' || camp.status === 'scheduled' ? (
        <Card>
          <EmptyState
            icon={camp.status === 'draft' ? Pencil : CalendarClock}
            title={camp.status === 'draft' ? 'No calls yet' : 'Scheduled'}
            description={camp.status === 'draft' ? 'Finish the message and audience, then start or schedule calling from the review step.' : `Calling starts at ${formatDateTime(camp.scheduled_at!)}.`}
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {(live || camp.status === 'paused') && (
            <Card>
              <CardContent className="pt-5">
                <div className="mb-2 flex justify-between text-sm">
                  <span className="font-medium">{camp.status === 'paused' ? 'Paused' : 'Calling…'}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {f(done)} of {f(camp.recipient_count)} finished · {progress}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={progress}>
                  <div className={cn('h-full rounded-full transition-all', camp.status === 'paused' ? 'bg-warning' : 'bg-primary')} style={{ width: `${progress}%` }} />
                </div>
              </CardContent>
            </Card>
          )}
          {waiting.length > 0 && (
            <div className="flex items-start gap-3 rounded-lg border bg-accent/40 px-4 py-3 text-sm" data-testid="waiting-banner">
              <Clock className="mt-0.5 size-4 shrink-0 text-primary" />
              <div>
                {waiting.map((w) => (
                  <div key={w.reason}>
                    <strong>{f(w.count)}</strong> {w.count === 1 ? 'call' : 'calls'} {w.reason === 'calling_window' ? `${w.count === 1 ? 'is' : 'are'} waiting for calling hours` : 'will be retried'}
                    {w.next_attempt_at && `, next at ${formatDateTime(w.next_attempt_at)}`}.
                  </div>
                ))}
              </div>
            </div>
          )}
          {st && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6" data-testid="report-kpis">
              <Kpi label="Recipients" value={f(st.recipients)} sub={`${f(st.attempts)} call attempts`} help="People with consent who were in the audience when calling started." />
              <Kpi label="Answered" value={pct(rep.data?.rates.answer_rate)} sub={`${f(st.answered)} people`} help="Answered by a person ÷ calls that finished. Voicemail is counted separately." />
              <Kpi label="Voicemail" value={f(st.voicemail)} sub="Answering machine" help="The call connected to an answering machine and the message was played." />
              <Kpi label="Not reached" value={f(st.no_answer + st.busy)} sub={`${f(st.no_answer)} no answer · ${f(st.busy)} busy`} help="After all attempts. Busy and unanswered calls are retried first." />
              <Kpi label="Opted out" value={f(st.opted_out)} sub={rep.data?.rates.opt_out_rate != null ? `${pct(rep.data.rates.opt_out_rate)} of answered` : 'Pressed 9'} help="Pressed 9 during the call. Their consent is removed and the number suppressed." />
              <Kpi label="Cost" value={formatMoney(st.cost, camp.currency)} sub={`${f(st.billable_minutes)} billable min · avg ${formatDuration(rep.data?.rates.average_seconds)}`} help="Started minutes of connected calls × the per-minute price. Simulated campaigns are not charged." />
            </div>
          )}
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Calls finished</CardTitle>
                <CardDescription>Per {rep.data?.timeline.granularity ?? 'hour'}, in your local time.</CardDescription>
              </CardHeader>
              <CardContent className="h-64">
                {rep.data?.timeline.points.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={rep.data.timeline.points.map((p) => ({ ...p, label: new Date(p.at).toLocaleString(undefined, rep.data!.timeline.granularity === 'hour' ? { hour: 'numeric', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' }) }))}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={32} />
                      <ChartTooltip contentStyle={{ borderRadius: 8, fontSize: 12, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line type="monotone" dataKey="answered" name="Answered or voicemail" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 4 }} />
                      <Line type="monotone" dataKey="unanswered" name="Not reached" stroke="#b45309" strokeWidth={2} dot={{ r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No calls have finished yet.</div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Outcomes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {out && outTotal > 0 ? (
                  <>
                    <div className="flex h-3 gap-0.5 overflow-hidden rounded-full" aria-hidden>
                      {OUTCOMES.map(([k, , cls]) => (out[k] ? <div key={k} className={cls} style={{ width: `${(100 * out[k]) / outTotal}%` }} /> : null))}
                    </div>
                    <ul className="space-y-2 text-sm" data-testid="outcomes">
                      {OUTCOMES.map(([k, label, cls]) => (
                        <li key={k} className="flex items-center gap-2">
                          <span className={cn('size-2.5 rounded-full', cls)} />
                          <span className="flex-1">{label}</span>
                          <span className="tabular-nums font-medium">{f(out[k])}</span>
                          <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{Math.round((100 * out[k]) / outTotal)}%</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No calls have finished yet.</p>
                )}
                {!!rep.data?.failure_reasons.length && (
                  <div className="border-t pt-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Failed or skipped</div>
                    {rep.data.failure_reasons.map((r, i) => (
                      <div key={i} className="flex justify-between gap-2 text-xs">
                        <span className="text-muted-foreground">{r.message ?? r.code}</span>
                        <span className="tabular-nums">{f(r.count)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          <Calls campaignId={camp.id} currency={camp.currency} />
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Cancel this campaign?"
        description="Calls not yet placed, including retries and calls waiting for calling hours, will be skipped. Calls in progress finish normally."
        confirmLabel="Cancel campaign"
        destructive
        loading={busy}
        onConfirm={() => act(() => api.cancel(camp.id), 'Campaign cancelled')}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this draft?"
        description="The draft is removed permanently."
        confirmLabel="Delete"
        destructive
        loading={busy}
        onConfirm={() => act(async () => { await api.deleteCampaign(camp.id); navigate(`${base}/campaigns`) }, 'Draft deleted')}
      />
    </>
  )
}
