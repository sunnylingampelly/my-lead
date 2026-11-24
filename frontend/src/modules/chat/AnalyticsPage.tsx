/** Chat overview: volume, leads, bot-resolved vs handed-off, human first response, CSAT, AI spend, top questions
 *  and the unanswered-questions training list ("Answer this" saves a FAQ). */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { Bot, Inbox, MessageSquareText, Wand2 } from 'lucide-react'
import { chatApi, cqk, useBots } from '@/api/chat'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select } from '@/components/ui/form-controls'
import { useWorkspace } from '@/hooks/useWorkspace'
import { timeAgo } from '@/lib/utils'
import { ImproveDialog } from './BotsPages'
import type { UnansweredQuestion } from '@/types/chat'

function secs(s: number | null) {
  if (s === null) return '—'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}

export function ChatAnalyticsPage() {
  const { app, org, can } = useWorkspace()
  const appId = app!.id
  const qc = useQueryClient()
  const [days, setDays] = useState(30)
  const [botId, setBotId] = useState('')
  const [answer, setAnswer] = useState<UnansweredQuestion | null>(null)
  const bots = useBots(appId)
  const q = useQuery({ queryKey: cqk.analytics(appId, days, botId), queryFn: () => chatApi(appId).analytics(days, botId || undefined) })
  const a = q.data
  return (
    <div>
      <PageHeader
        title="Chat"
        description="How your chatbots and live chat are doing."
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${appId}` }, { label: 'Chat' }]}
        actions={
          <>
            <Select aria-label="Chatbot" value={botId} onChange={(e) => setBotId(e.target.value)} className="w-44">
              <option value="">All chatbots</option>
              {bots.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-32">
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </Select>
          </>
        }
      />
      {bots.data && !bots.data.length ? (
        <Card>
          <EmptyState
            icon={Bot}
            title="Add a chatbot to your website"
            description="Answer visitors instantly, capture leads and hand over to your team when needed."
            action={can('chat.write') && <Button asChild><Link to={`/apps/${appId}/chat/bots`}>Create a chatbot</Link></Button>}
          />
        </Card>
      ) : q.isLoading ? (
        <LoadingRows rows={6} />
      ) : q.isError || !a ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild><Link to={`/apps/${appId}/chat/inbox`}><Inbox /> Open inbox</Link></Button>
            <Button variant="outline" asChild><Link to={`/apps/${appId}/chat/bots`}><MessageSquareText /> Chatbots</Link></Button>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Conversations" value={a.conversations} hint={`${a.offline_messages} offline messages`} />
            <Stat label="Leads captured" value={a.leads} hint={`${a.lead_rate}% of conversations`} />
            <Stat label="Resolved by the bot" value={`${a.bot_resolved_pct}%`} hint={`${a.handed_off_pct}% handed to a person`} />
            <Stat label="First human response" value={secs(a.avg_first_response_seconds)} hint="Average after a hand-off" />
            <Stat label="CSAT" value={a.csat === null ? '—' : `${a.csat}%`} hint={`${a.ratings} ratings`} />
            <Stat label="AI replies" value={a.ai_replies} hint={`Spend ${a.ai_spend.toFixed(2)}`} />
          </div>
          <Card>
            <CardHeader><CardTitle>Conversations per day</CardTitle></CardHeader>
            <CardContent className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={a.series}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} fontSize={11} />
                  <YAxis allowDecimals={false} fontSize={11} width={28} />
                  <ChartTooltip />
                  <Bar dataKey="conversations" name="Conversations" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="leads" name="Leads" fill="hsl(var(--primary) / 0.45)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Top questions</CardTitle><CardDescription>What visitors ask first.</CardDescription></CardHeader>
              <CardContent>
                {a.top_questions.length ? (
                  <ol className="space-y-1.5 text-sm">
                    {a.top_questions.map((t, i) => (
                      <li key={i} className="flex gap-2"><span className="min-w-0 flex-1 break-words">{t.question}</span><span className="tabular-nums text-muted-foreground">{t.count}</span></li>
                    ))}
                  </ol>
                ) : <p className="text-sm text-muted-foreground">No conversations yet.</p>}
              </CardContent>
            </Card>
            <Card data-testid="unanswered">
              <CardHeader>
                <CardTitle>Unanswered questions</CardTitle>
                <CardDescription>Your training to-do list: questions the bot couldn't answer.</CardDescription>
              </CardHeader>
              <CardContent>
                {a.unanswered.length ? (
                  <ul className="divide-y text-sm">
                    {a.unanswered.map((u) => (
                      <li key={u.message_id} className="flex flex-wrap items-center gap-2 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="break-words">{u.question}</p>
                          <p className="text-xs text-muted-foreground">{u.count}× · {u.bot_name} · {timeAgo(u.last_at)}</p>
                        </div>
                        {can('chat.write') && <Button size="sm" variant="outline" onClick={() => setAnswer(u)}><Wand2 /> Answer this</Button>}
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">Nothing to teach. 🎉</p>}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
      {answer && (
        <ImproveDialog
          botId={answer.bot_id}
          initial={{ question: answer.question, answer: '' }}
          messageId={answer.message_id}
          onClose={() => setAnswer(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: cqk.all(appId) })}
        />
      )}
    </div>
  )
}
