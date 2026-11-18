import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { Ban, CalendarClock, Copy, FlaskConical, Info, MoonStar, Pause, Pencil, Play, Search, ShieldAlert, Trash2 } from 'lucide-react'
import { smsApi, sqk, useSmsCampaign, useSmsReport } from '@/api/sms'
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
import { CATEGORY_LABEL, COUNTRY_FLAG, formatMoney } from './format'

const SERIES = { sent: 'hsl(var(--primary))', delivered: '#0d9488' }

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
  ['delivered', 'Delivered'],
  ['undelivered', 'Undelivered'],
  ['failed', 'Failed'],
  ['deferred', 'Deferred'],
  ['skipped', 'Skipped'],
  ['queued', 'Queued'],
] as const

const BADGE: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'default'> = {
  delivered: 'success',
  accepted: 'default',
  queued: 'secondary',
  sending: 'secondary',
  deferred: 'warning',
  undelivered: 'destructive',
  failed: 'destructive',
  skipped: 'warning',
}

function Recipients({ campaignId, currency }: { campaignId: string; currency: string | null }) {
  const { app } = useWorkspace()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const q = useQuery({
    queryKey: ['sms', app!.id, 'messages', campaignId, status, search, page],
    queryFn: () => smsApi(app!.id).messages(campaignId, { page, page_size: 25, status: status || undefined, search: search || undefined }),
    placeholderData: (p) => p,
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recipients</CardTitle>
        <CardDescription>Every text and its latest delivery receipt.</CardDescription>
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
          <Input
            className="pl-8"
            placeholder="Search number"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            aria-label="Search recipients"
          />
        </div>
      </div>
      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data?.items.length ? (
        <p className="p-6 text-center text-sm text-muted-foreground">No messages match.</p>
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Number</TH>
                <TH>Status</TH>
                <TH className="text-right">Parts</TH>
                <TH className="text-right">Cost</TH>
                <TH>Detail</TH>
                <TH>Updated</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((m) => (
                <TR key={m.id}>
                  <TD>
                    {m.contact_id ? (
                      <Link className="font-mono text-sm hover:text-primary" to={`/apps/${app!.id}/audience/contacts/${m.contact_id}`}>
                        {formatPhone(m.to_phone)}
                      </Link>
                    ) : (
                      <span className="font-mono text-sm">{formatPhone(m.to_phone)}</span>
                    )}
                  </TD>
                  <TD>
                    <Badge variant={BADGE[m.status] ?? 'secondary'}>{m.status}</Badge>
                  </TD>
                  <TD className="text-right tabular-nums">{m.segments || '—'}</TD>
                  <TD className="text-right tabular-nums">{m.cost ? formatMoney(m.cost, currency) : '—'}</TD>
                  <TD className="max-w-xs truncate text-xs text-muted-foreground">
                    {m.status === 'deferred' && m.next_attempt_at
                      ? `Quiet hours · sends ${formatDateTime(m.next_attempt_at)}`
                      : m.error_message
                        ? `${m.error_code ? `${m.error_code}: ` : ''}${m.error_message}`
                        : m.delivered_at
                          ? `Delivered ${formatDateTime(m.delivered_at)}`
                          : ''}
                  </TD>
                  <TD className="text-xs text-muted-foreground">{timeAgo(m.delivered_at ?? m.failed_at ?? m.accepted_at ?? m.created_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={25} total={q.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  )
}

export function SmsReportPage() {
  const { campaignId } = useParams()
  const { app, org, can } = useWorkspace()
  const appId = app!.id
  const api = smsApi(appId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const c = useSmsCampaign(appId, campaignId!)
  const live = !!c.data && ['queued', 'sending'].includes(c.data.status)
  const rep = useSmsReport(appId, campaignId!, live)
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)
  const f = (n: number) => formatCount(n, app!.default_country)
  const base = `/apps/${appId}/sms`

  if (c.isLoading) return <FullPageSpinner />
  if (c.isError) return <ErrorState error={c.error} onRetry={() => c.refetch()} />
  const camp = c.data!
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: sqk.all(appId) })
      toast.success(msg)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }
  const st = rep.data?.stats ?? camp.stats
  const done = st ? st.sent + st.failed + st.skipped : 0
  const progress = camp.recipient_count ? Math.round((100 * done) / camp.recipient_count) : 0
  const launchable = can('campaigns.launch')
  const snap = camp.sender_snapshot ?? {}
  const deferred = rep.data?.deferred ?? []

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${appId}` }, { label: 'SMS', to: base }, { label: 'Campaigns', to: `${base}/campaigns` }, { label: camp.name }]}
        title={camp.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <CampaignStatusBadge status={camp.status} />
            <span>{CATEGORY_LABEL[camp.category]}</span>
            {snap.sender_id && (
              <span>
                · from {COUNTRY_FLAG[snap.country ?? ''] ?? ''} <span className="font-mono">{snap.sender_id}</span>
              </span>
            )}
            {camp.launched_at && <span>· sent {formatDateTime(camp.launched_at)}</span>}
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
              <Button variant="outline" loading={busy} onClick={() => act(() => api.pause(camp.id), 'Campaign paused')}>
                <Pause /> Pause
              </Button>
            )}
            {camp.status === 'paused' && launchable && (
              <Button loading={busy} onClick={() => act(() => api.resume(camp.id), 'Campaign resumed')}>
                <Play /> Resume
              </Button>
            )}
            {['queued', 'sending', 'paused'].includes(camp.status) && launchable && (
              <Button variant="outline" className="text-destructive" onClick={() => setConfirm('cancel')}>
                <Ban /> Cancel
              </Button>
            )}
            {can('campaigns.write') && (
              <Button
                variant="outline"
                onClick={() =>
                  act(async () => {
                    const d = await api.duplicateCampaign(camp.id)
                    navigate(`${base}/campaigns/${d.id}/edit`)
                  }, 'Campaign duplicated')
                }
              >
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
            <strong>Simulation mode.</strong> No real text was sent and nothing was charged. Numbers ending 0000 simulate an undelivered text and 1111 a provider rejection. See the{' '}
            <a className="font-semibold underline" href="/dev/sms" target="_blank" rel="noreferrer">
              development SMS outbox
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
            title={camp.status === 'draft' ? 'This campaign has not been sent yet' : 'Scheduled'}
            description={camp.status === 'draft' ? 'Finish the message and audience, then send or schedule it from the review step.' : `It will start sending at ${formatDateTime(camp.scheduled_at!)}.`}
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {(live || camp.status === 'paused') && (
            <Card>
              <CardContent className="pt-5">
                <div className="mb-2 flex justify-between text-sm">
                  <span className="font-medium">{camp.status === 'paused' ? 'Paused' : 'Sending…'}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {f(done)} of {f(camp.recipient_count)} · {progress}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={progress}>
                  <div className={cn('h-full rounded-full transition-all', camp.status === 'paused' ? 'bg-warning' : 'bg-primary')} style={{ width: `${progress}%` }} />
                </div>
              </CardContent>
            </Card>
          )}
          {deferred.length > 0 && (
            <div className="flex items-start gap-3 rounded-lg border bg-accent/40 px-4 py-3 text-sm" data-testid="deferred-banner">
              <MoonStar className="mt-0.5 size-4 shrink-0 text-primary" />
              <div>
                <strong>{f(deferred.reduce((a, d) => a + d.count, 0))} texts are waiting for quiet hours to end</strong> in the recipients’ time zones.
                {deferred[0]?.next_attempt_at && ` The next batch goes out ${formatDateTime(deferred[0].next_attempt_at)}.`}
              </div>
            </div>
          )}
          {st && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6" data-testid="report-kpis">
              <Kpi label="Recipients" value={f(st.recipients)} sub={`${f(Object.values(camp.excluded ?? {}).reduce((a, b) => a + b, 0))} excluded at launch`} help="Contacts who were eligible when the campaign launched." />
              <Kpi label="Sent" value={f(st.sent)} sub="Accepted by the provider" help="Accepted for delivery by the SMS provider. Acceptance is not delivery." />
              <Kpi label="Delivered" value={pct(rep.data?.rates.delivery_rate)} sub={`${f(st.delivered)} of ${f(st.sent)} sent`} help="Delivery receipts from the carrier ÷ texts sent." />
              <Kpi label="Undelivered" value={f(st.undelivered)} sub={`${f(st.failed)} failed at send`} help="Undelivered: the carrier could not reach the handset (switched off, DND, invalid). Failed: the provider rejected the text." />
              <Kpi label="SMS parts" value={f(st.segments)} sub={rep.data?.rates.segments_per_message ? `${rep.data.rates.segments_per_message} per text` : undefined} help="Long or Unicode texts are split into parts. Each part is billed." />
              <Kpi label="Cost" value={formatMoney(st.cost, camp.currency)} sub={camp.estimated_cost ? `Estimated ${formatMoney(camp.estimated_cost, camp.currency)}` : undefined} help="Parts accepted by the provider × the per-part price. Simulated campaigns are not charged." />
            </div>
          )}
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Sent and delivered</CardTitle>
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
                      <Line type="monotone" dataKey="sent" name="Sent" stroke={SERIES.sent} strokeWidth={2} dot={{ r: 4 }} />
                      <Line type="monotone" dataKey="delivered" name="Delivered" stroke={SERIES.delivered} strokeWidth={2} dot={{ r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No texts sent yet.</div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Why texts didn’t arrive</CardTitle>
              </CardHeader>
              <CardContent>
                {rep.data?.failure_reasons.length ? (
                  <ul className="space-y-3">
                    {rep.data.failure_reasons.map((r, i) => (
                      <li key={i} className="flex items-start justify-between gap-3 text-sm">
                        <div className="min-w-0">
                          <Badge variant={BADGE[r.status] ?? 'secondary'}>{r.status}</Badge>
                          <div className="mt-1 text-xs text-muted-foreground">{r.message ?? r.code ?? 'Unknown'}</div>
                        </div>
                        <span className="tabular-nums font-medium">{f(r.count)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No failures. 🎉</p>
                )}
              </CardContent>
            </Card>
          </div>
          <Recipients campaignId={camp.id} currency={camp.currency} />
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Cancel this campaign?"
        description="Texts not yet sent, including those waiting for quiet hours to end, will be skipped. This cannot be undone."
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
        onConfirm={() =>
          act(async () => {
            await api.deleteCampaign(camp.id)
            navigate(`${base}/campaigns`)
          }, 'Draft deleted')
        }
      />
    </>
  )
}
