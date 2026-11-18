import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { Ban, CalendarClock, Copy, ExternalLink, FlaskConical, Info, MousePointerClick, Pause, Pencil, Play, Search, ShieldAlert, Trash2, UserMinus } from 'lucide-react'
import { emailApi, eqk, useCampaign, useReport } from '@/api/email'
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
import { formatCount } from '@/lib/regions'
import { cn, formatDateTime, timeAgo } from '@/lib/utils'
import { CampaignStatusBadge, pct } from './components'

const SERIES = { opens: 'hsl(var(--primary))', clicks: '#0d9488' }

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

const MSG_FILTERS = [
  ['', 'All'],
  ['delivered', 'Delivered'],
  ['opened', 'Opened'],
  ['clicked', 'Clicked'],
  ['bounced', 'Bounced'],
  ['complained', 'Complaints'],
  ['unsubscribed', 'Unsubscribed'],
  ['failed', 'Failed'],
  ['skipped', 'Skipped'],
  ['queued', 'Queued'],
] as const

const MSG_BADGE: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'default'> = {
  delivered: 'success',
  accepted: 'default',
  queued: 'secondary',
  sending: 'secondary',
  bounced: 'destructive',
  complained: 'destructive',
  failed: 'destructive',
  skipped: 'warning',
}

function Recipients({ campaignId }: { campaignId: string }) {
  const { app } = useWorkspace()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const params = { page, page_size: 25, status: status || undefined, search: search || undefined }
  const q = useQuery({ queryKey: [...eqk.campaign(app!.id, campaignId), 'messages', params], queryFn: () => emailApi(app!.id).messages(campaignId, params), placeholderData: (p) => p })
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>Recipients</CardTitle>
        <div className="relative sm:w-64">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Find an email address" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} aria-label="Search recipients" />
        </div>
      </CardHeader>
      <div className="flex flex-wrap gap-1 border-y px-4 py-2">
        {MSG_FILTERS.map(([k, label]) => (
          <button
            key={k}
            onClick={() => { setStatus(k); setPage(1) }}
            className={cn('rounded-full px-3 py-1 text-xs font-medium transition', status === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
          >
            {label}
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data?.items.length ? (
        <EmptyState title="No recipients in this view" className="py-10" />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Recipient</TH>
                <TH>Status</TH>
                <TH>Opened</TH>
                <TH>Clicked</TH>
                <TH>Detail</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((m) => (
                <TR key={m.id}>
                  <TD className="font-medium">
                    {m.contact_id ? (
                      <Link className="hover:text-primary" to={`/apps/${app!.id}/audience/contacts/${m.contact_id}`}>
                        {m.to_email}
                      </Link>
                    ) : (
                      m.to_email
                    )}
                  </TD>
                  <TD>
                    <Badge variant={MSG_BADGE[m.status] ?? 'secondary'} className="capitalize">
                      {m.status === 'accepted' ? 'Sent' : m.status}
                    </Badge>
                    {m.unsubscribed_at && (
                      <Badge variant="warning" className="ml-1">
                        Unsubscribed
                      </Badge>
                    )}
                  </TD>
                  <TD className="text-muted-foreground">{m.first_opened_at ? `${timeAgo(m.first_opened_at)}${m.open_count > 1 ? ` · ${m.open_count}×` : ''}` : '—'}</TD>
                  <TD className="text-muted-foreground">{m.first_clicked_at ? `${timeAgo(m.first_clicked_at)}${m.click_count > 1 ? ` · ${m.click_count}×` : ''}` : '—'}</TD>
                  <TD className="max-w-xs truncate text-xs text-muted-foreground">{m.error_message ?? (m.bounce_type ? `${m.bounce_type} bounce` : '')}</TD>
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

export function CampaignReportPage() {
  const { campaignId } = useParams()
  const { app, org, can } = useWorkspace()
  const appId = app!.id
  const api = emailApi(appId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const c = useCampaign(appId, campaignId!)
  const live = !!c.data && ['queued', 'sending'].includes(c.data.status)
  const rep = useReport(appId, campaignId!, live)
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)
  const f = (n: number) => formatCount(n, app!.default_country)
  const base = `/apps/${appId}/email`

  if (c.isLoading) return <FullPageSpinner />
  if (c.isError) return <ErrorState error={c.error} onRetry={() => c.refetch()} />
  const camp = c.data!
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: eqk.all(appId) })
      toast.success(msg)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }
  const st = rep.data?.stats ?? camp.stats
  const rates = rep.data?.rates
  const done = st ? st.sent + st.failed + st.skipped : 0
  const progress = camp.recipient_count ? Math.round((100 * done) / camp.recipient_count) : 0
  const launchable = can('campaigns.launch')

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${appId}` }, { label: 'Email', to: base }, { label: 'Campaigns', to: `${base}/campaigns` }, { label: camp.name }]}
        title={camp.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <CampaignStatusBadge status={camp.status} />
            {camp.subject && <span className="truncate">“{camp.subject}”</span>}
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
            <strong>Simulation mode.</strong> No real email was sent. Delivery receipts are simulated; opens and clicks are real when you open the messages in the{' '}
            <a className="font-semibold underline" href="/dev/mailbox" target="_blank" rel="noreferrer">
              development mailbox
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
            description={camp.status === 'draft' ? 'Finish the content and audience, then send or schedule it from the review step.' : `It will start sending at ${formatDateTime(camp.scheduled_at!)}.`}
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
          {st && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4" data-testid="report-kpis">
              <Kpi label="Recipients" value={f(st.recipients)} sub={`${f(Object.values(camp.excluded ?? {}).reduce((a, b) => a + b, 0))} excluded at launch`} help="Contacts who were eligible when the campaign launched." />
              <Kpi label="Sent" value={f(st.sent)} sub="Accepted by the provider" help="Accepted for delivery by the email provider. Acceptance is not the same as delivery to the inbox." />
              <Kpi label="Delivered" value={pct(rates?.delivery_rate)} sub={`${f(st.delivered)} of ${f(st.sent)} sent`} help="Confirmed by the receiving mail server ÷ sent." />
              <Kpi label="Bounced" value={pct(rates?.bounce_rate)} sub={`${f(st.bounced)} (${f(st.hard_bounced)} hard)`} help="Bounces ÷ sent. Hard-bounced addresses are suppressed automatically." />
              <Kpi label="Opened" value={pct(rates?.open_rate)} sub={`${f(st.unique_opens)} unique · ${f(st.total_opens)} total`} help="Unique opens ÷ delivered. Approximate: Apple Mail Privacy Protection and image proxies can inflate or hide opens." />
              <Kpi label="Clicked" value={pct(rates?.click_rate)} sub={`${f(st.unique_clicks)} unique · ${f(st.total_clicks)} total`} help="Unique clickers ÷ delivered. The most reliable engagement signal." />
              <Kpi label="Click-to-open" value={pct(rates?.click_to_open_rate)} sub="Unique clicks ÷ unique opens" help="How compelling the content was for people who opened it." />
              <Kpi label="Unsubscribed" value={pct(rates?.unsubscribe_rate)} sub={`${f(st.unsubscribed)} · ${f(st.complained)} complaints`} help="Unsubscribes ÷ delivered. Complaints are spam reports; keep them under 0.1%." />
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Engagement over time</CardTitle>
                <CardDescription>First opens and first clicks per {rep.data?.timeline.granularity ?? 'hour'}.</CardDescription>
              </CardHeader>
              <CardContent>
                {!rep.data?.timeline.points.length ? (
                  <p className="py-16 text-center text-sm text-muted-foreground">No opens or clicks yet.</p>
                ) : (
                  <div className="h-64" role="img" aria-label="Opens and clicks over time">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={rep.data.timeline.points} margin={{ top: 4, right: 12, left: -12, bottom: 0 }}>
                        <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                        <XAxis
                          dataKey="at"
                          tickFormatter={(v: string) => new Date(v).toLocaleString(undefined, rep.data!.timeline.granularity === 'hour' ? { hour: 'numeric', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' })}
                          tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                          tickLine={false}
                          axisLine={false}
                          minTickGap={24}
                        />
                        <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
                        <ChartTooltip
                          contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
                          labelFormatter={(v: string) => formatDateTime(v)}
                        />
                        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                        <Line type="monotone" name="Opens" dataKey="opens" stroke={SERIES.opens} strokeWidth={2} dot={rep.data.timeline.points.length < 4 ? { r: 4, fill: SERIES.opens } : false} activeDot={{ r: 5 }} />
                        <Line type="monotone" name="Clicks" dataKey="clicks" stroke={SERIES.clicks} strokeWidth={2} dot={rep.data.timeline.points.length < 4 ? { r: 4, fill: SERIES.clicks } : false} activeDot={{ r: 5 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Funnel</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {st &&
                  [
                    ['Sent', st.sent],
                    ['Delivered', st.delivered],
                    ['Opened', st.unique_opens],
                    ['Clicked', st.unique_clicks],
                  ].map(([label, n]) => {
                    const w = st.sent ? Math.max(2, (100 * (n as number)) / st.sent) : 0
                    return (
                      <div key={label as string}>
                        <div className="flex justify-between text-sm">
                          <span>{label}</span>
                          <span className="tabular-nums text-muted-foreground">{f(n as number)}</span>
                        </div>
                        <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${w}%` }} />
                        </div>
                      </div>
                    )
                  })}
                <p className="pt-2 text-xs text-muted-foreground">Percentages use explicit denominators; hover the info icons above for definitions.</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MousePointerClick className="size-4" /> Top links
                </CardTitle>
              </CardHeader>
              {!rep.data?.top_links.length ? (
                <CardContent>
                  <p className="py-6 text-center text-sm text-muted-foreground">No clicks yet.</p>
                </CardContent>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Link</TH>
                      <TH className="text-right">Clicks</TH>
                      <TH className="text-right">Unique</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rep.data.top_links.map((l) => (
                      <TR key={l.url}>
                        <TD className="max-w-md">
                          <a href={l.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1 truncate text-primary hover:underline">
                            <span className="truncate">{l.url}</span> <ExternalLink className="size-3 shrink-0" />
                          </a>
                        </TD>
                        <TD className="text-right tabular-nums">{f(l.clicks)}</TD>
                        <TD className="text-right tabular-nums">{f(l.unique_clicks)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UserMinus className="size-4" /> Excluded at launch
                </CardTitle>
                <CardDescription>Not sent, to protect consent and deliverability.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {Object.entries(camp.excluded ?? {}).map(([k, n]) => (
                  <div key={k} className="flex justify-between">
                    <span className="capitalize text-muted-foreground">{k.replace(/_/g, ' ')}</span>
                    <span className="tabular-nums">{f(n)}</span>
                  </div>
                ))}
                {st && st.skipped > 0 && (
                  <div className="flex justify-between border-t pt-2">
                    <span className="text-muted-foreground">Skipped at send time</span>
                    <span className="tabular-nums">{f(st.skipped)}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <Recipients campaignId={camp.id} />
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Cancel this campaign?"
        description="Emails not yet sent will be skipped. Emails already sent cannot be recalled."
        confirmLabel="Cancel campaign"
        destructive
        loading={busy}
        onConfirm={() => act(() => api.cancel(camp.id), 'Campaign cancelled')}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this draft?"
        description="The draft and its content will be removed."
        confirmLabel="Delete draft"
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
