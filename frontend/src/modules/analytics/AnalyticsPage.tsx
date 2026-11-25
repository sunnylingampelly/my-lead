import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { ArrowDownRight, ArrowRight, ArrowUpRight, BadgeCheck, CircleDollarSign, Download, Handshake, Mail, MessageSquare, PhoneCall, Send, Table2, Workflow } from 'lucide-react'
import { analyticsApi } from '@/api/billing'
import { type AnalyticsOverview, type CampaignRank, type CrmBlock, useAnalyticsOverview } from '@/api/analytics'
import { errorMessage } from '@/api/client'
import { ErrorState, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { StatCard } from '@/components/audience'
import { useTheme } from '@/hooks/useTheme'
import { useWorkspace } from '@/hooks/useWorkspace'
import { downloadFile } from '@/lib/download'
import { formatCount } from '@/lib/regions'
import { cn } from '@/lib/utils'
import { pct } from '../email/components'
import { channelColors } from '../billing/colors'
import { formatMoney } from '../sms/format'
import { FormsChatCard } from './FormsChatCard'

const PRESETS = [
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
  ['custom', 'Custom'],
] as const

const iso = (d: Date) => d.toISOString().slice(0, 10)
const tooltipStyle = {
  borderRadius: 8,
  fontSize: 12,
  background: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
}
const CHANNEL_ICON = { email: Mail, sms: MessageSquare, voice: PhoneCall }
const CHANNEL_BASE = { email: 'email', sms: 'sms', voice: 'voice' }

/** % change against the previous period. `inverse` when lower is better (spend). */
function Delta({ value, inverse, testId }: { value: number | null | undefined; inverse?: boolean; testId?: string }) {
  if (value === null || value === undefined)
    return (
      <span className="text-muted-foreground" data-testid={testId}>
        no previous data
      </span>
    )
  const up = value > 0
  const good = value === 0 ? null : inverse ? !up : up
  const Icon = value === 0 ? ArrowRight : up ? ArrowUpRight : ArrowDownRight
  return (
    <span className={cn('inline-flex items-center gap-0.5 font-medium', good === null ? 'text-muted-foreground' : good ? 'text-success-strong' : 'text-destructive')} data-testid={testId}>
      <Icon className="size-3" />
      {up ? '+' : ''}
      {value}% vs previous
    </span>
  )
}

function Funnel({ steps, color, to }: { steps: [string, number][]; color: string; to?: string }) {
  const max = Math.max(steps[0]?.[1] ?? 0, 1)
  return (
    <div className="space-y-2">
      {steps.map(([label, n], i) => {
        const row = (
          <>
            <div className="mb-1 flex justify-between text-xs">
              <span className="text-muted-foreground">{label}</span>
              <span className="tabular-nums font-medium">
                {n.toLocaleString()}
                {i > 0 && steps[0]![1] > 0 && <span className="ml-1 text-muted-foreground">({Math.round((100 * n) / steps[0]![1])}%)</span>}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted">
              <div className="h-2 rounded-full" style={{ width: `${(100 * n) / max}%`, background: color, opacity: 1 - i * 0.18 }} />
            </div>
          </>
        )
        return to ? (
          <Link key={label} to={to} title="Open the campaign reports" className="-m-1 block rounded-md p-1 transition hover:bg-muted/60">
            {row}
          </Link>
        ) : (
          <div key={label}>{row}</div>
        )
      })}
    </div>
  )
}

function CrmCard({ crm, base, f }: { crm: CrmBlock; base: string; f: (n: number) => string }) {
  const tiles: { label: string; value: string; delta?: number | null; to: string }[] = [
    { label: 'Deals created', value: f(crm.deals_created), delta: crm.changes.deals_created, to: `${base}/crm/deals` },
    { label: 'Deals won', value: f(crm.won), delta: crm.changes.won, to: `${base}/crm/deals` },
    { label: 'Won revenue', value: formatMoney(crm.won_amount, crm.currency), delta: crm.changes.won_amount, to: `${base}/crm/reports` },
    { label: 'Win rate', value: crm.win_rate === null ? '—' : `${crm.win_rate}%`, delta: crm.changes.win_rate, to: `${base}/crm/reports` },
    { label: 'Open pipeline', value: formatMoney(crm.pipeline_value, crm.currency), to: `${base}/crm/deals` },
  ]
  return (
    <Card data-testid="analytics-crm">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Handshake className="size-4" /> Sales (CRM)
          </CardTitle>
          <CardDescription>
            Deals created and closed in this period. Open pipeline is the current value of {f(crm.open_deals)} open deal{crm.open_deals === 1 ? '' : 's'}, in {crm.currency}.
          </CardDescription>
        </div>
        <div className="flex gap-3 text-sm">
          <Link className="font-medium text-primary hover:underline" to={`${base}/crm/reports`}>
            CRM reports
          </Link>
          <Link className="font-medium text-primary hover:underline" to={`${base}/crm/deals`}>
            Deals
          </Link>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => (
          <Link key={t.label} to={t.to} className="rounded-lg border p-3 transition hover:border-primary/50 hover:bg-accent/30">
            <div className="text-xs text-muted-foreground">{t.label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{t.value}</div>
            {t.delta !== undefined && (
              <div className="mt-0.5 text-[11px]">
                <Delta value={t.delta} />
              </div>
            )}
          </Link>
        ))}
      </CardContent>
    </Card>
  )
}

function GetStarted({ base, setup }: { base: string; setup: AnalyticsOverview['setup'] }) {
  const steps = [
    { done: setup.sender_verified, icon: BadgeCheck, title: 'Verify a sender', text: 'Confirm the address your emails come from.', to: `${base}/email/senders` },
    { done: setup.campaign_sent, icon: Send, title: 'Send your first campaign', text: 'An email or a voice call to a list or segment.', to: `${base}/email/campaigns` },
    { done: setup.workflow_created, icon: Workflow, title: 'Build a workflow', text: 'Welcome new contacts or follow up automatically.', to: `${base}/automation` },
  ]
  return (
    <Card data-testid="analytics-empty">
      <CardHeader>
        <CardTitle>Nothing to measure in this period yet</CardTitle>
        <CardDescription>Results appear here once messages go out. These steps get you there:</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-3 md:grid-cols-3">
          {steps.map((s, i) => {
            const Icon = s.icon
            return (
              <li key={s.title}>
                <Link to={s.to} className={cn('flex h-full gap-3 rounded-lg border p-4 transition hover:border-primary/50 hover:bg-accent/30', s.done && 'opacity-70')}>
                  <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold', s.done ? 'bg-success-soft text-success-strong' : 'bg-primary/10 text-primary')}>
                    {s.done ? <BadgeCheck className="size-4" /> : i + 1}
                  </span>
                  <span>
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      <Icon className="size-3.5" /> {s.title}
                      {s.done && <Badge variant="success">Done</Badge>}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{s.text}</span>
                  </span>
                </Link>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}

export function AnalyticsPage() {
  const { app, org } = useWorkspace()
  const { resolved } = useTheme()
  const colors = channelColors(resolved)
  const [preset, setPreset] = useState<string>('30')
  const [custom, setCustom] = useState(() => ({
    start: iso(new Date(Date.now() - 29 * 864e5)),
    end: iso(new Date()),
  }))
  const [asTable, setAsTable] = useState(false)
  const [rank, setRank] = useState<CampaignRank>('volume')
  const range = useMemo(() => {
    if (preset === 'custom') return custom
    const end = new Date()
    return {
      start: iso(new Date(end.getTime() - (Number(preset) - 1) * 864e5)),
      end: iso(end),
    }
  }, [preset, custom])
  const q = useAnalyticsOverview(app!.id, range.start, range.end, rank)
  const d = q.data
  const f = (n: number) => formatCount(n, app!.default_country)
  const points = useMemo(
    () =>
      d?.points.map((p) => ({
        ...p,
        label: new Date(p.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      })) ?? [],
    [d],
  )
  const t = d?.totals ?? {}
  const base = `/apps/${app!.id}`
  const empty =
    !!d &&
    ['email_sent', 'sms_sent', 'voice_calls', 'automation_entered', 'spend', 'form_views', 'form_submissions', 'chat_conversations'].every((k) => !((t[k] ?? 0) > 0)) &&
    d.top_campaigns.length === 0
  const crmActive = !!d?.crm && (d.crm.deals_created > 0 || d.crm.open_deals > 0 || d.crm.won > 0 || d.crm.lost > 0)

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: base }, { label: 'Analytics' }]}
        title="Analytics"
        description={`What’s working across every channel and your pipeline. Days are in ${app!.timezone}.`}
        actions={
          <Button variant="outline" onClick={() => downloadFile(analyticsApi.exportUrl(app!.id, range.start, range.end), 'analytics.csv').catch((e) => toast.error(errorMessage(e)))}>
            <Download /> Export CSV
          </Button>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap rounded-lg border bg-card p-0.5" role="radiogroup" aria-label="Date range">
          {PRESETS.map(([k, label]) => (
            <button
              key={k}
              role="radio"
              aria-checked={preset === k}
              onClick={() => setPreset(k)}
              className={cn('rounded-md px-3 py-1.5 text-sm font-medium transition', preset === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
            >
              {label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            <Input type="date" aria-label="Start date" value={custom.start} max={custom.end} onChange={(e) => setCustom({ ...custom, start: e.target.value })} className="w-40" />
            <span className="text-sm text-muted-foreground">to</span>
            <Input type="date" aria-label="End date" value={custom.end} min={custom.start} onChange={(e) => setCustom({ ...custom, end: e.target.value })} className="w-40" />
          </div>
        )}
        {q.isFetching && <span className="text-xs text-muted-foreground">Updating…</span>}
      </div>

      {q.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : q.isError || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : empty ? (
        <div className="space-y-6">
          <GetStarted base={base} setup={d.setup} />
          {d.crm && crmActive && <CrmCard crm={d.crm} base={base} f={f} />}
        </div>
      ) : (
        <div className="space-y-6">
          <div>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5" data-testid="analytics-kpis">
              <StatCard
                label="Emails sent"
                value={f(t.email_sent ?? 0)}
                icon={Mail}
                hint={
                  <>
                    {pct(d.rates.email_open)} opened · {pct(d.rates.email_click)} clicked
                    <br />
                    <Delta value={d.changes.email_sent} testId="delta-email_sent" />
                  </>
                }
              />
              <StatCard label="Texts" value="Coming soon" icon={MessageSquare} hint="SMS is coming soon" />
              <StatCard
                label="Calls finished"
                value={f(t.voice_calls ?? 0)}
                icon={PhoneCall}
                hint={
                  <>
                    {pct(d.rates.voice_answer)} answered · {f(t.voice_minutes ?? 0)} min
                    <br />
                    <Delta value={d.changes.voice_calls} />
                  </>
                }
              />
              <StatCard
                label="Entered journeys"
                value={f(t.automation_entered ?? 0)}
                icon={Workflow}
                hint={
                  <>
                    {f(t.automation_completed ?? 0)} completed
                    <br />
                    <Delta value={d.changes.automation_entered} />
                  </>
                }
              />
              <StatCard
                label="Spend"
                value={formatMoney(t.spend ?? 0, d.currency)}
                icon={CircleDollarSign}
                hint={
                  <>
                    Charged to the wallet
                    <br />
                    <Delta value={d.changes.spend} inverse />
                  </>
                }
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Compared with the previous {Math.round((new Date(d.end).getTime() - new Date(d.start).getTime()) / 864e5) + 1} days ({d.previous.start} to {d.previous.end}).
            </p>
          </div>

          {d.crm && <CrmCard crm={d.crm} base={base} f={f} />}

          <FormsChatCard d={d} base={base} f={f} />

          <Card>
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Messages by channel</CardTitle>
                <CardDescription>Emails and texts accepted by the provider, and calls that finished, per day.</CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
                <Table2 /> {asTable ? 'Show chart' : 'Show table'}
              </Button>
            </CardHeader>
            <CardContent>
              {asTable ? (
                <div className="max-h-80 overflow-auto rounded-md border">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Date</TH>
                        <TH className="text-right">Emails</TH>
                        <TH className="text-right">Opens</TH>
                        <TH className="text-right">Calls</TH>
                        <TH className="text-right">Journeys</TH>
                        <TH className="text-right">Spend</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {d.points.map((p) => (
                        <TR key={p.date}>
                          <TD>{p.date}</TD>
                          <TD className="text-right tabular-nums">{p.email_sent}</TD>
                          <TD className="text-right tabular-nums">{p.email_opened}</TD>
                          <TD className="text-right tabular-nums">{p.voice_calls}</TD>
                          <TD className="text-right tabular-nums">{p.automation_entered}</TD>
                          <TD className="text-right tabular-nums">{formatMoney(Number(p.spend), d.currency)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              ) : (
                <div className="h-72" data-testid="channel-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={points}>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
                      <ChartTooltip contentStyle={tooltipStyle} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line type="monotone" dataKey="email_sent" name="Emails" stroke={colors.email} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      <Line type="monotone" dataKey="voice_calls" name="Calls" stroke={colors.voice} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mail className="size-4" style={{ color: colors.email }} /> Email
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Funnel
                  to={`${base}/email/campaigns`}
                  color={colors.email}
                  steps={[
                    ['Sent', t.email_sent ?? 0],
                    ['Delivered', t.email_delivered ?? 0],
                    ['Opened', t.email_opened ?? 0],
                    ['Clicked', t.email_clicked ?? 0],
                  ]}
                />
                <p className="mt-3 text-xs text-muted-foreground">
                  {f(t.email_bounced ?? 0)} bounced · {f(t.email_unsubscribed ?? 0)} unsubscribed. Opens are approximate.{' '}
                  <Link className="text-primary hover:underline" to={`${base}/email/campaigns`}>
                    Campaign reports
                  </Link>
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="size-4" style={{ color: colors.sms }} /> SMS <Badge variant="secondary">Coming soon</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground" data-testid="analytics-sms-soon">
                  SMS is coming soon. Delivery funnels for texts appear here once it is available.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <PhoneCall className="size-4" style={{ color: colors.voice }} /> Voice
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Funnel
                  to={`${base}/voice/campaigns`}
                  color={colors.voice}
                  steps={[
                    ['Finished', t.voice_calls ?? 0],
                    ['Answered', t.voice_answered ?? 0],
                  ]}
                />
                <p className="mt-3 text-xs text-muted-foreground">
                  {f(t.voice_minutes ?? 0)} billable minutes · {f(t.voice_opt_outs ?? 0)} pressed 9.{' '}
                  <Link className="text-primary hover:underline" to={`${base}/voice/campaigns`}>
                    Campaign reports
                  </Link>
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Spend per day</CardTitle>
                <CardDescription>Usage charged to the wallet, in {d.currency}.</CardDescription>
              </CardHeader>
              <CardContent className="h-56">
                {!((t.spend ?? 0) > 0) ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Nothing was charged in this period.</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={points}>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
                      <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
                      <ChartTooltip formatter={(v: number) => formatMoney(v, d.currency)} contentStyle={tooltipStyle} cursor={{ fill: 'hsl(var(--muted))' }} />
                      <Bar dataKey="spend" name="Spend" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={18} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Journeys</CardTitle>
                <CardDescription>People who entered each workflow in this period.</CardDescription>
              </CardHeader>
              <CardContent>
                {d.workflows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No one entered a workflow in this period.{' '}
                    <Link className="text-primary hover:underline" to={`${base}/automation`}>
                      Open Automation
                    </Link>
                  </p>
                ) : (
                  <ul className="space-y-3 text-sm">
                    {d.workflows.map((w) => (
                      <li key={w.id} className="flex flex-wrap items-center gap-x-3">
                        <Link className="min-w-0 flex-1 truncate font-medium hover:text-primary" to={`${base}/automation/${w.id}`}>
                          {w.name}
                        </Link>
                        <Link className="tabular-nums text-muted-foreground hover:text-primary" to={`${base}/automation/${w.id}?tab=enrollments`}>
                          {f(w.entered)} entered · {f(w.completed)} completed
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Top campaigns and steps</CardTitle>
                <CardDescription>{rank === 'rate' ? 'By engagement rate (10 or more sent)' : 'By volume'} in this period. Automation steps open in the builder.</CardDescription>
              </div>
              <div className="flex rounded-lg border p-0.5 text-xs" role="radiogroup" aria-label="Rank campaigns by">
                {(
                  [
                    ['volume', 'Most sent'],
                    ['rate', 'Best engagement'],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} role="radio" aria-checked={rank === k} onClick={() => setRank(k)} className={cn('rounded-md px-2.5 py-1 font-medium', rank === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                    {label}
                  </button>
                ))}
              </div>
            </CardHeader>
            {d.top_campaigns.length === 0 ? (
              <CardContent>
                <p className="text-sm text-muted-foreground">Nothing was sent in this period.</p>
              </CardContent>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR>
                      <TH>Campaign</TH>
                      <TH>Channel</TH>
                      <TH className="text-right">Sent</TH>
                      <TH className="text-right">Result</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {d.top_campaigns.map((c) => {
                      const Icon = CHANNEL_ICON[c.channel]
                      const to = c.automation
                        ? c.workflow_id
                          ? `${base}/automation/${c.workflow_id}${c.node_id ? `?node=${encodeURIComponent(c.node_id)}` : ''}`
                          : null
                        : `${base}/${CHANNEL_BASE[c.channel]}/campaigns/${c.id}`
                      return (
                        <TR key={c.id}>
                          <TD>
                            {to ? (
                              <Link className="font-medium hover:text-primary" to={to} data-testid={c.automation ? 'top-automation-link' : undefined}>
                                {c.name}
                              </Link>
                            ) : (
                              <span className="font-medium">{c.name}</span>
                            )}
                            {c.automation && (
                              <Badge variant="secondary" className="ml-2">
                                Automation
                              </Badge>
                            )}
                          </TD>
                          <TD>
                            <span className="flex items-center gap-1.5 text-sm">
                              <Icon className="size-3.5" style={{ color: colors[c.channel] }} />
                              {c.channel === 'sms' ? 'SMS' : c.channel === 'email' ? 'Email' : 'Voice'}
                            </span>
                          </TD>
                          <TD className="text-right tabular-nums">{f(c.sent)}</TD>
                          <TD className="text-right tabular-nums">
                            {pct(c.rate)} <span className="text-xs text-muted-foreground">{c.engaged_label}</span>
                          </TD>
                        </TR>
                      )
                    })}
                  </TBody>
                </Table>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
