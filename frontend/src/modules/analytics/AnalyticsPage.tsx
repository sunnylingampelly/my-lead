import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { CircleDollarSign, Download, Mail, MessageSquare, PhoneCall, Table2, Workflow } from 'lucide-react'
import { analyticsApi, useAnalytics } from '@/api/billing'
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

function Funnel({ steps, color }: { steps: [string, number][]; color: string }) {
  const max = Math.max(steps[0]?.[1] ?? 0, 1)
  return (
    <div className="space-y-2">
      {steps.map(([label, n], i) => (
        <div key={label}>
          <div className="mb-1 flex justify-between text-xs">
            <span className="text-muted-foreground">{label}</span>
            <span className="tabular-nums font-medium">
              {n.toLocaleString()}
              {i > 0 && steps[0]![1] > 0 && <span className="ml-1 text-muted-foreground">({Math.round((100 * n) / steps[0]![1])}%)</span>}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div
              className="h-2 rounded-full"
              style={{
                width: `${(100 * n) / max}%`,
                background: color,
                opacity: 1 - i * 0.18,
              }}
            />
          </div>
        </div>
      ))}
    </div>
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
  const range = useMemo(() => {
    if (preset === 'custom') return custom
    const end = new Date()
    return {
      start: iso(new Date(end.getTime() - (Number(preset) - 1) * 864e5)),
      end: iso(end),
    }
  }, [preset, custom])
  const q = useAnalytics(app!.id, range.start, range.end)
  const d = q.data
  const f = (n: number) => formatCount(n, app!.default_country)
  const points = useMemo(
    () =>
      d?.points.map((p) => ({
        ...p,
        label: new Date(p.date).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
        }),
      })) ?? [],
    [d],
  )
  const t = d?.totals ?? {}
  const base = `/apps/${app!.id}`

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: base }, { label: 'Analytics' }]}
        title="Analytics"
        description={`Every channel in one place, from delivery and engagement records. Days are in ${app!.timezone}.`}
        actions={
          <Button variant="outline" onClick={() => downloadFile(analyticsApi.exportUrl(app!.id, range.start, range.end), 'analytics.csv').catch((e) => toast.error(errorMessage(e)))}>
            <Download /> Export CSV
          </Button>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border bg-card p-0.5" role="radiogroup" aria-label="Date range">
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
          <div className="flex items-center gap-2">
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
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5" data-testid="analytics-kpis">
            <StatCard label="Emails sent" value={f(t.email_sent ?? 0)} icon={Mail} hint={`${pct(d.rates.email_open)} opened · ${pct(d.rates.email_click)} clicked`} />
            <StatCard label="Texts sent" value={f(t.sms_sent ?? 0)} icon={MessageSquare} hint={`${pct(d.rates.sms_delivery)} delivered`} />
            <StatCard label="Calls finished" value={f(t.voice_calls ?? 0)} icon={PhoneCall} hint={`${pct(d.rates.voice_answer)} answered · ${f(t.voice_minutes ?? 0)} min`} />
            <StatCard label="Entered journeys" value={f(t.automation_entered ?? 0)} icon={Workflow} hint={`${f(t.automation_completed ?? 0)} completed`} />
            <StatCard label="Spend" value={formatMoney(t.spend ?? 0, d.currency)} icon={CircleDollarSign} hint="Charged to the wallet" />
          </div>

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
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
                        <TH className="text-right">Texts</TH>
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
                          <TD className="text-right tabular-nums">{p.sms_sent}</TD>
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
                      <Line type="monotone" dataKey="sms_sent" name="Texts" stroke={colors.sms} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                      <Line type="monotone" dataKey="voice_calls" name="Calls" stroke={colors.voice} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mail className="size-4" style={{ color: colors.email }} /> Email
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Funnel
                  color={colors.email}
                  steps={[
                    ['Sent', t.email_sent ?? 0],
                    ['Delivered', t.email_delivered ?? 0],
                    ['Opened', t.email_opened ?? 0],
                    ['Clicked', t.email_clicked ?? 0],
                  ]}
                />
                <p className="mt-3 text-xs text-muted-foreground">
                  {f(t.email_bounced ?? 0)} bounced · {f(t.email_unsubscribed ?? 0)} unsubscribed. Opens are approximate.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="size-4" style={{ color: colors.sms }} /> SMS
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Funnel
                  color={colors.sms}
                  steps={[
                    ['Sent', t.sms_sent ?? 0],
                    ['Delivered', t.sms_delivered ?? 0],
                  ]}
                />
                <p className="mt-3 text-xs text-muted-foreground">{f(t.sms_failed ?? 0)} not delivered.</p>
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
                  color={colors.voice}
                  steps={[
                    ['Finished', t.voice_calls ?? 0],
                    ['Answered', t.voice_answered ?? 0],
                  ]}
                />
                <p className="mt-3 text-xs text-muted-foreground">
                  {f(t.voice_minutes ?? 0)} billable minutes · {f(t.voice_opt_outs ?? 0)} pressed 9.
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
                {!(t.spend > 0) ? (
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
                      <li key={w.id} className="flex items-center gap-3">
                        <Link className="min-w-0 flex-1 truncate font-medium hover:text-primary" to={`${base}/automation/${w.id}`}>
                          {w.name}
                        </Link>
                        <span className="tabular-nums text-muted-foreground">
                          {f(w.entered)} entered · {f(w.completed)} completed
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Top campaigns and steps</CardTitle>
              <CardDescription>By volume in this period. Automation steps are marked.</CardDescription>
            </CardHeader>
            {d.top_campaigns.length === 0 ? (
              <CardContent>
                <p className="text-sm text-muted-foreground">Nothing was sent in this period.</p>
              </CardContent>
            ) : (
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
                    return (
                      <TR key={c.id}>
                        <TD>
                          {c.automation ? (
                            <span className="font-medium">{c.name}</span>
                          ) : (
                            <Link className="font-medium hover:text-primary" to={`${base}/${CHANNEL_BASE[c.channel]}/campaigns/${c.id}`}>
                              {c.name}
                            </Link>
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
            )}
          </Card>
        </div>
      )}
    </>
  )
}
