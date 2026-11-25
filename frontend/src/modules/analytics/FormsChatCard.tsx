import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDownRight, ArrowUpRight, Bot, ClipboardList } from 'lucide-react'
import type { AnalyticsOverview } from '@/api/analytics'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

function Change({ value, points }: { value: number | null | undefined; points?: boolean }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">no earlier data</span>
  const up = value >= 0
  const Icon = up ? ArrowUpRight : ArrowDownRight
  return (
    <span className={cn('inline-flex items-center gap-0.5', up ? 'text-success-strong' : 'text-danger-strong')}>
      <Icon className="size-3" />
      {up ? '+' : ''}
      {value}
      {points ? ' pts' : '%'}
    </span>
  )
}

const pctText = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`)
const diff = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined ? null : Math.round((a - b) * 10) / 10)

/** Lead forms (views, submissions, conversion) and chat (conversations, leads, AI replies, bot-resolved %). */
export function FormsChatCard({ d, base, f }: { d: AnalyticsOverview; base: string; f: (n: number) => string }) {
  const t = d.totals
  const pr = d.previous_rates ?? {}
  const tiles: { group: 'forms' | 'chat'; label: string; value: string; change: ReactNode; to: string; testId: string }[] = [
    { group: 'forms', label: 'Form views', value: f(t.form_views ?? 0), change: <Change value={d.changes.form_views} />, to: `${base}/forms`, testId: 'kpi-form_views' },
    { group: 'forms', label: 'Submissions', value: f(t.form_submissions ?? 0), change: <Change value={d.changes.form_submissions} />, to: `${base}/forms`, testId: 'kpi-form_submissions' },
    { group: 'forms', label: 'Conversion', value: pctText(d.rates.form_conversion), change: <Change value={diff(d.rates.form_conversion, pr.form_conversion)} points />, to: `${base}/forms`, testId: 'kpi-form_conversion' },
    { group: 'chat', label: 'Conversations', value: f(t.chat_conversations ?? 0), change: <Change value={d.changes.chat_conversations} />, to: `${base}/chat`, testId: 'kpi-chat_conversations' },
    { group: 'chat', label: 'Leads captured', value: f(t.chat_leads ?? 0), change: <Change value={d.changes.chat_leads} />, to: `${base}/chat`, testId: 'kpi-chat_leads' },
    { group: 'chat', label: 'AI replies', value: f(t.chat_ai_replies ?? 0), change: <Change value={d.changes.chat_ai_replies} />, to: `${base}/chat`, testId: 'kpi-chat_ai_replies' },
    { group: 'chat', label: 'Resolved by the bot', value: pctText(d.rates.chat_bot_resolved), change: <Change value={diff(d.rates.chat_bot_resolved, pr.chat_bot_resolved)} points />, to: `${base}/chat`, testId: 'kpi-chat_bot_resolved' },
  ]
  return (
    <Card data-testid="analytics-forms-chat">
      <CardHeader>
        <CardTitle>Lead forms and chat</CardTitle>
        <CardDescription>Leads that came to you: form views and submissions, and website chat conversations. Changes compare with the previous period.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(['forms', 'chat'] as const).map((g) => (
          <div key={g}>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {g === 'forms' ? <ClipboardList className="size-3.5" /> : <Bot className="size-3.5" />}
              {g === 'forms' ? 'Lead forms' : 'Chat'}
            </div>
            <div className={cn('grid grid-cols-2 gap-3', g === 'forms' ? 'sm:grid-cols-3' : 'sm:grid-cols-4')}>
              {tiles
                .filter((x) => x.group === g)
                .map((x) => (
                  <Link key={x.label} to={x.to} className="min-w-0 rounded-lg border p-3 transition hover:bg-muted/50" data-testid={x.testId}>
                    <div className="truncate text-xs text-muted-foreground">{x.label}</div>
                    <div className="mt-0.5 text-lg font-semibold tabular-nums">{x.value}</div>
                    <div className="text-xs">{x.change}</div>
                  </Link>
                ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
