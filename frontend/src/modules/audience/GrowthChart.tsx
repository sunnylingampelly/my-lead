import { useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatCount } from '@/lib/regions'

interface Point {
  date: string
  new: number
  total: number
}

const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

function Tip({ active, payload, country }: { active?: boolean; payload?: { payload: Point }[]; country?: string | null }) {
  if (!active || !payload?.length) return null
  const p = payload[0]!.payload
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-pop">
      <div className="font-medium text-foreground">{shortDate(p.date)}</div>
      <div className="mt-1 text-muted-foreground">
        Total <span className="font-semibold tabular-nums text-foreground">{formatCount(p.total, country)}</span>
      </div>
      <div className="text-muted-foreground">
        New <span className="font-semibold tabular-nums text-foreground">+{formatCount(p.new, country)}</span>
      </div>
    </div>
  )
}

/** Audience size over the last 30 days. Single series: the card title names it, so no legend. */
export function GrowthChart({ data, country, height = 220 }: { data: Point[]; country?: string | null; height?: number }) {
  const [table, setTable] = useState(false)
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setTable((t) => !t)}>
          {table ? 'View chart' : 'View as table'}
        </button>
      </div>
      {table ? (
        <div className="max-h-[220px] overflow-y-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Date</th>
                <th className="px-3 py-1.5 text-right font-medium">New</th>
                <th className="px-3 py-1.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((p) => (
                <tr key={p.date} className="border-t">
                  <td className="px-3 py-1">{shortDate(p.date)}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{formatCount(p.new, country)}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{formatCount(p.total, country)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ height }} role="img" aria-label={`Audience grew to ${data[data.length - 1]?.total ?? 0} contacts over 30 days`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
              <defs>
                <linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="0" />
              <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} minTickGap={28} />
              <YAxis
                tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                tickLine={false}
                axisLine={false}
                width={48}
                allowDecimals={false}
                tickFormatter={(v: number) => formatCount(v, country)}
              />
              <Tooltip content={<Tip country={country} />} cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '3 3' }} />
              <Area type="monotone" dataKey="total" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#growthFill)" activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
