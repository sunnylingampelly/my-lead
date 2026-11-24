import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { CalendarCheck, Clock3, Percent, Scale, Snowflake, Trophy, Wallet } from 'lucide-react'
import { cqk, crmApi, usePipelines } from '@/api/crm'
import { ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select } from '@/components/ui/form-controls'
import { Avatar, Skeleton } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { StatCard } from '@/components/audience'
import { useTheme } from '@/hooks/useTheme'
import { useWorkspace } from '@/hooks/useWorkspace'
import { channelColors } from '../billing/colors'
import { money, moneyCompact, num } from './format'

const tooltipStyle = { borderRadius: 8, fontSize: 12, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }

function monthLabel(key: string) {
  const [y, m] = key.split('-').map(Number)
  return new Date(y!, m! - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
}

export function ReportsPage() {
  const { app } = useWorkspace()
  const appId = app!.id
  const api = crmApi(appId)
  const { resolved } = useTheme()
  const palette = channelColors(resolved)
  // Same validated categorical palette as the analytics charts.
  const series = { weighted: palette.email!, best_case: palette.voice!, commit: palette.automation!, won: palette.sms! }
  const pipelines = usePipelines(appId)
  const [picked, setPicked] = useState('')
  const pipelineId = picked || pipelines.data?.find((p) => p.is_default)?.id || pipelines.data?.[0]?.id
  const enabled = !!pipelineId
  const k = (n: string) => cqk.report(appId, n, { pipelineId })
  const overview = useQuery({ queryKey: k('overview'), queryFn: () => api.overview(pipelineId), enabled })
  const forecast = useQuery({ queryKey: k('forecast'), queryFn: () => api.forecast(pipelineId, 6), enabled })
  const winLoss = useQuery({ queryKey: k('winloss'), queryFn: () => api.winLoss(pipelineId, 90), enabled })
  const conversion = useQuery({ queryKey: k('conversion'), queryFn: () => api.conversion(pipelineId, 90), enabled })
  const leaders = useQuery({ queryKey: k('leaders'), queryFn: () => api.leaderboard(pipelineId, 30), enabled })
  const cur = overview.data?.currency ?? forecast.data?.currency ?? 'INR'

  const chart = useMemo(
    () => (forecast.data?.months ?? []).map((m) => ({ month: monthLabel(m.month), weighted: num(m.weighted), best_case: num(m.best_case), commit: num(m.commit), won: num(m.won) })),
    [forecast.data],
  )
  const maxReason = Math.max(1, ...(winLoss.data?.lost_reasons.map((r) => r.count) ?? [1]))
  const o = overview.data

  return (
    <>
      <PageHeader
        title="CRM reports"
        description="Pipeline health, forecast and team performance."
        actions={
          <Select aria-label="Pipeline" value={pipelineId ?? ''} onChange={(e) => setPicked(e.target.value)} className="w-full sm:w-56">
            {pipelines.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        }
      />
      {overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
      ) : (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 [&>*]:min-w-0" data-testid="kpis">
          {!o ? (
            Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)
          ) : (
            <>
              <StatCard label="Open pipeline" value={<span title={money(o.open_amount, cur)}>{moneyCompact(o.open_amount, cur)}</span>} hint={`${o.open_deals} open deals`} icon={Wallet} />
              <StatCard label="Weighted" value={<span title={money(o.weighted_amount, cur)}>{moneyCompact(o.weighted_amount, cur)}</span>} hint="By stage probability" icon={Scale} />
              <StatCard label="Won this month" value={moneyCompact(o.won_amount_this_month, cur)} hint={`${o.won_this_month} deals`} icon={Trophy} tone="success" />
              <StatCard label="Win rate (90d)" value={o.win_rate_90d === null ? '—' : `${o.win_rate_90d}%`} icon={Percent} />
              <StatCard label="Avg. sales cycle" value={o.average_cycle_days === null ? '—' : `${o.average_cycle_days}d`} hint="Won deals, 90 days" icon={Clock3} />
              <StatCard label="Going cold" value={o.rotting_deals} hint="No recent activity" icon={Snowflake} tone={o.rotting_deals ? 'warning' : 'default'} />
            </>
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3 [&>*]:min-w-0">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Forecast by close month</CardTitle>
            <CardDescription>Open deals by expected close date. Commit = 75%+ probability; best case = everything open.</CardDescription>
          </CardHeader>
          <CardContent>
            {forecast.isLoading ? (
              <Skeleton className="h-72" />
            ) : forecast.isError ? (
              <ErrorState error={forecast.error} />
            ) : (
              <>
                <div className="h-72" data-testid="forecast-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chart} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="month" tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                      <YAxis tickFormatter={(v: number) => moneyCompact(v, cur)} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} width={72} />
                      <ChartTooltip formatter={(v: number) => money(v, cur)} contentStyle={tooltipStyle} cursor={{ fill: 'hsl(var(--muted))' }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="won" name="Won" fill={series.won} radius={[3, 3, 0, 0]} maxBarSize={16} />
                      <Bar dataKey="weighted" name="Weighted" fill={series.weighted} radius={[3, 3, 0, 0]} maxBarSize={16} />
                      <Bar dataKey="commit" name="Commit" fill={series.commit} radius={[3, 3, 0, 0]} maxBarSize={16} />
                      <Bar dataKey="best_case" name="Best case" fill={series.best_case} radius={[3, 3, 0, 0]} maxBarSize={16} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {forecast.data && (
                  <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      Past close date: {forecast.data.overdue.deals} deals · {money(forecast.data.overdue.total, cur)}
                    </span>
                    <span>
                      No close date: {forecast.data.no_close_date.deals} deals · {money(forecast.data.no_close_date.total, cur)}
                    </span>
                    {forecast.data.other_currency_deals > 0 && <span>{forecast.data.other_currency_deals} deals in another currency not included</span>}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Win / loss (90 days)</CardTitle>
            {winLoss.data && (
              <CardDescription>
                {winLoss.data.won} won · {winLoss.data.lost} lost{winLoss.data.win_rate !== null && ` · ${winLoss.data.win_rate}% win rate`}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {winLoss.isLoading ? (
              <LoadingRows rows={3} />
            ) : winLoss.data ? (
              <>
                <div className="mb-4 grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-lg border p-3">
                    <div className="text-xs text-muted-foreground">Won value</div>
                    <div className="font-semibold tabular-nums">{money(winLoss.data.won_amount, cur)}</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-xs text-muted-foreground">Avg. won deal</div>
                    <div className="font-semibold tabular-nums">{money(winLoss.data.average_won_amount, cur)}</div>
                  </div>
                </div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lost reasons</div>
                {winLoss.data.lost_reasons.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No lost deals in this period.</p>
                ) : (
                  <ul className="space-y-2.5" data-testid="lost-reasons">
                    {winLoss.data.lost_reasons.map((r) => (
                      <li key={r.reason}>
                        <div className="mb-1 flex flex-wrap justify-between gap-x-2 text-xs">
                          <span>{r.reason}</span>
                          <span className="tabular-nums text-muted-foreground">
                            {r.count} · {moneyCompact(r.amount, cur)}
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-muted">
                          <div className="h-2 rounded-full bg-destructive/70" style={{ width: `${(100 * r.count) / maxReason}%` }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Stage conversion (90 days)</CardTitle>
            <CardDescription>{conversion.data ? `${conversion.data.created} deals created. Share that reached each stage.` : ' '}</CardDescription>
          </CardHeader>
          <CardContent>
            {conversion.isLoading ? (
              <LoadingRows rows={4} />
            ) : (
              <ul className="space-y-2.5" data-testid="conversion">
                {conversion.data?.stages.map((s) => {
                  const pct = conversion.data!.created ? (100 * s.reached) / conversion.data!.created : 0
                  return (
                    <li key={s.stage_id}>
                      <div className="mb-1 flex flex-wrap justify-between gap-x-2 text-xs">
                        <span className="font-medium">{s.name}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {s.reached}
                          {s.conversion !== null && ` · ${s.conversion}% from previous`}
                          {s.average_days !== null && ` · ${s.average_days}d avg`}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-muted">
                        <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: s.kind === 'won' ? series.won : series.weighted }} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Leaderboard (30 days)</CardTitle>
            <CardDescription>Won value, deals and activity by owner.</CardDescription>
          </CardHeader>
          {leaders.isLoading ? (
            <LoadingRows rows={3} />
          ) : !leaders.data?.rows.length ? (
            <CardContent>
              <p className="text-sm text-muted-foreground">No owned deals yet.</p>
            </CardContent>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Owner</TH>
                  <TH className="text-right">Won</TH>
                  <TH className="text-right">Won value</TH>
                  <TH className="text-right">Lost</TH>
                  <TH className="text-right">Open</TH>
                  <TH className="text-right">Activities</TH>
                  <TH className="text-right">Tasks done</TH>
                </TR>
              </THead>
              <TBody>
                {leaders.data.rows.map((r) => (
                  <TR key={r.owner.id}>
                    <TD>
                      <span className="flex items-center gap-2">
                        <Avatar name={r.owner.full_name} className="size-6 text-[10px]" /> {r.owner.full_name}
                      </span>
                    </TD>
                    <TD className="text-right tabular-nums">{r.won}</TD>
                    <TD className="text-right font-medium tabular-nums">{moneyCompact(r.won_amount, cur)}</TD>
                    <TD className="text-right tabular-nums">{r.lost}</TD>
                    <TD className="text-right tabular-nums" title={money(r.open_amount, cur)}>
                      {r.open} · {moneyCompact(r.open_amount, cur)}
                    </TD>
                    <TD className="text-right tabular-nums">{r.activities}</TD>
                    <TD className="text-right tabular-nums">
                      <span className="inline-flex items-center gap-1">
                        <CalendarCheck className="size-3 text-muted-foreground" /> {r.tasks_done}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  )
}
