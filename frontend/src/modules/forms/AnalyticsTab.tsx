/** Analytics tab: KPIs, funnel, daily chart and top sources. */
import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Eye, MousePointerClick, Percent, Send } from 'lucide-react'
import { useFormAnalytics } from '@/api/forms'
import { ErrorState, LoadingRows } from '@/components/page'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select } from '@/components/ui/form-controls'
import { StatCard } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import type { CountRow, DailyRow, FormOut } from '@/types/forms'

const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const pct = (n: number) => `${n.toFixed(n >= 10 || n === 0 ? 1 : 2)}%`

function Tip({ active, payload }: { active?: boolean; payload?: { payload: DailyRow }[] }) {
  if (!active || !payload?.length) return null
  const p = payload[0]!.payload
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-pop">
      <div className="font-medium text-foreground">{shortDate(p.date)}</div>
      <div className="mt-1 text-muted-foreground">
        Views <span className="font-semibold tabular-nums text-foreground">{p.views}</span>
      </div>
      <div className="text-muted-foreground">
        Starts <span className="font-semibold tabular-nums text-foreground">{p.starts}</span>
      </div>
      <div className="text-muted-foreground">
        Submissions <span className="font-semibold tabular-nums text-foreground">{p.submissions}</span>
      </div>
    </div>
  )
}

export function AnalyticsTab({ appId, form }: { appId: string; form: FormOut }) {
  const { app } = useWorkspace()
  const [days, setDays] = useState(30)
  const q = useFormAnalytics(appId, form.id, days)
  const f = (n: number) => formatCount(n, app?.default_country)
  const a = q.data

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">A view is counted when the form is shown; a start when someone types into it.</p>
        <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-36">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </Select>
      </div>
      {q.isLoading ? (
        <Card>
          <LoadingRows />
        </Card>
      ) : q.isError || !a ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="form-kpis">
            <StatCard label="Views" value={f(a.views)} icon={Eye} />
            <StatCard label="Starts" value={f(a.starts)} hint={`${pct(a.start_rate)} of views`} icon={MousePointerClick} />
            <StatCard label="Submissions" value={f(a.submissions)} hint={`${pct(a.completion_rate)} of starts`} icon={Send} tone="success" />
            <StatCard label="Conversion" value={pct(a.conversion)} hint="Submissions ÷ views" icon={Percent} />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Daily activity</CardTitle>
              </CardHeader>
              <CardContent>
                {a.views + a.submissions === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">No activity in this period yet.</p>
                ) : (
                  <div style={{ height: 240 }} role="img" aria-label={`${a.views} views and ${a.submissions} submissions over ${days} days`}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={a.daily} margin={{ top: 4, right: 8, bottom: 0, left: -16 }} barGap={1}>
                        <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} minTickGap={24} />
                        <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                        <Tooltip content={<Tip />} cursor={{ fill: 'hsl(var(--muted))', opacity: 0.6 }} />
                        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="views" name="Views" fill="hsl(var(--primary) / 0.3)" radius={[3, 3, 0, 0]} />
                        <Bar dataKey="submissions" name="Submissions" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Funnel</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4" data-testid="form-funnel">
                {(
                  [
                    ['Views', a.views, 100],
                    ['Started', a.starts, a.views ? (100 * a.starts) / a.views : 0],
                    ['Submitted', a.submissions, a.views ? (100 * a.submissions) / a.views : 0],
                  ] as const
                ).map(([label, n, share]) => (
                  <div key={label}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span className="font-medium">{label}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {f(n)} · {pct(share)}
                      </span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.max(share, n ? 1 : 0)}%` }} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <TopList title="Top pages" rows={a.top_pages} empty="No page data yet." />
            <TopList title="Top referrers" rows={a.top_referrers} empty="No referrers yet. Direct visits have none." />
            <TopList title="UTM sources" rows={a.top_utm_sources} empty="No UTM-tagged visits yet." />
          </div>
        </>
      )}
    </div>
  )
}

function TopList({ title, rows, empty }: { title: string; rows: CountRow[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.value} className="relative overflow-hidden rounded-md px-2 py-1.5 text-sm">
                <span className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${(100 * r.count) / max}%` }} aria-hidden />
                <span className="relative flex justify-between gap-3">
                  <span className="min-w-0 truncate" title={r.value}>
                    {r.value || '(none)'}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{r.count}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
