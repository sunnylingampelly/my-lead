import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FlaskConical, Hash, MessagesSquare as Slack } from 'lucide-react'
import { errorMessage, http } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows } from '@/components/page'
import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/form-controls'
import { formatDateTime } from '@/lib/utils'

interface SlackBlock {
  type: string
  text?: { type: string; text: string }
  fields?: { type: string; text: string }[]
  elements?: { type: string; text?: { text: string } | string; action_id?: string; value?: string; url?: string; style?: string }[]
}

interface LogItem {
  id: string
  kind: 'message' | 'update' | 'ephemeral'
  channel?: string
  channel_name?: string
  ts?: string
  text: string
  blocks?: SlackBlock[]
  action_id?: string
  created_at: string
}

/** Slack mrkdwn → plain text with *bold* kept readable. Rendered as text only. */
const plain = (s: string) =>
  s
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

/** Development-only viewer for messages the simulated Slack connection "posted", with working approval buttons. */
export function DevSlackLogPage() {
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const q = useQuery({
    queryKey: ['dev', 'slack'],
    queryFn: () => http.get<{ items: LogItem[] }>('/dev/slack', { params: { limit: 200 } }).then((r) => r.data),
    refetchInterval: 3000,
  })
  const click = async (actionId: string, approve: boolean) => {
    if (!email.trim()) return toast.error('Enter the email of the Signalcraft user clicking the button')
    try {
      const r = await http.post<{ ok: boolean; message: string }>('/dev/slack/click', { action_id: actionId, approve, email })
      if (r.data.ok) toast.success(r.data.message)
      else toast.error(r.data.message)
      qc.invalidateQueries({ queryKey: ['dev', 'slack'] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const decided = new Set((q.data?.items ?? []).filter((m) => m.kind === 'update').map((m) => m.ts))
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 items-center gap-4 border-b bg-card px-5">
        <Logo />
        <span className="flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning-strong ring-1 ring-warning-border">
          <FlaskConical className="size-3.5" /> Development Slack log · simulated workspace
        </span>
        <a className="ml-auto text-sm text-primary hover:underline" href="/dev/mailbox">
          Email mailbox
        </a>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-4 sm:p-6">
        <label className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Click buttons as (Signalcraft user email):</span>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="max-w-xs" data-testid="slack-click-email" />
        </label>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState icon={Slack} title="No Slack messages yet" description="Connect the simulated Slack under AI Team → Integrations and run an agent with a Slack destination." />
        ) : (
          <ul className="space-y-3" data-testid="slack-log">
            {q.data.items.map((m) => (
              <li key={m.id} className="rounded-xl border bg-card p-4 shadow-card" data-testid="slack-log-item" data-kind={m.kind}>
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {m.kind === 'ephemeral' ? (
                    <span className="font-medium">Only visible to the clicker</span>
                  ) : (
                    <span className="inline-flex items-center gap-0.5 font-semibold text-foreground">
                      <Hash className="size-3" />
                      {m.channel_name ?? m.channel}
                    </span>
                  )}
                  {m.kind === 'update' && <span>Message updated</span>}
                  <span className="ml-auto">{formatDateTime(m.created_at)}</span>
                </div>
                {m.blocks?.length ? (
                  <div className="space-y-2 text-sm">
                    {m.blocks.map((b, i) =>
                      b.type === 'section' ? (
                        <div key={i} className="space-y-1">
                          {b.text && <p className="whitespace-pre-wrap break-words">{plain(b.text.text)}</p>}
                          {b.fields && (
                            <dl className="grid gap-2 sm:grid-cols-2">
                              {b.fields.map((f, j) => (
                                <div key={j} className="whitespace-pre-wrap text-xs">
                                  {plain(f.text)}
                                </div>
                              ))}
                            </dl>
                          )}
                        </div>
                      ) : b.type === 'actions' ? (
                        <div key={i} className="flex flex-wrap gap-2">
                          {b.elements?.map((el, j) => {
                            const label = typeof el.text === 'string' ? el.text : el.text?.text ?? 'Button'
                            if (el.url)
                              return (
                                <Button key={j} asChild size="sm" variant="outline">
                                  <a href={el.url} target="_blank" rel="noreferrer">
                                    {label}
                                  </a>
                                </Button>
                              )
                            const done = decided.has(m.id)
                            return (
                              <Button key={j} size="sm" variant={el.style === 'primary' ? 'default' : el.style === 'danger' ? 'destructive' : 'outline'} disabled={done} onClick={() => void click(el.value ?? '', el.action_id === 'ai_approve')} data-testid={`slack-${el.action_id}`}>
                                {label}
                              </Button>
                            )
                          })}
                        </div>
                      ) : b.type === 'context' ? (
                        <p key={i} className="text-xs text-muted-foreground">
                          {plain(b.elements?.map((e) => (typeof e.text === 'string' ? e.text : e.text?.text)).join(' ') ?? '')}
                        </p>
                      ) : null,
                    )}
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words text-sm">{plain(m.text)}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
