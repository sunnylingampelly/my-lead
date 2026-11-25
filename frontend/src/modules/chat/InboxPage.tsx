/** The live-chat inbox: conversation list (filters, search), the transcript with reply / internal note / canned
 *  responses, and the visitor & contact panel. Real time by short polling (every ~2.5 s). */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowLeft, Bot, CheckCircle2, ExternalLink, Lock, MessageSquareText, RotateCcw, Search, Send, Settings2, Trash2, UserPlus, Wand2 } from 'lucide-react'
import { chatApi, cqk } from '@/api/chat'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn, timeAgo } from '@/lib/utils'
import { ImproveDialog } from './BotsPages'
import type { CannedResponse, ConversationDetail, InboxItem, InboxMessage } from '@/types/chat'

const FILTERS: [string, string][] = [['open', 'Open'], ['mine', 'Mine'], ['unassigned', 'Unassigned'], ['bot', 'Bot'], ['closed', 'Closed']]
const STATUS_LABEL: Record<string, string> = { bot: 'Bot', waiting: 'Waiting', open: 'Open', closed: 'Closed' }

function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.value = 880
    g.gain.value = 0.06
    o.connect(g)
    g.connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.25)
  } catch {
    /* no audio */
  }
}

function notifyBrowser(title: string, body: string) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body })
  } catch {
    /* ignore */
  }
}

export function ChatInboxPage() {
  const { app, org, can } = useWorkspace()
  const appId = app!.id
  const api = chatApi(appId)
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const selected = params.get('c')
  const [filter, setFilter] = useState('open')
  const [q, setQ] = useState('')
  const [presence, setPresence] = useState<'online' | 'away' | 'offline'>('offline')
  const [settings, setSettings] = useState(false)
  const since = useRef<string | null>(null)

  const list = useQuery({ queryKey: [...cqk.inbox(appId), filter, q], queryFn: () => api.inbox({ filter, q: q.trim() || undefined }) })
  const agents = useQuery({ queryKey: cqk.agents(appId), queryFn: () => api.agents() })
  useEffect(() => {
    if (agents.data?.me) setPresence(agents.data.me.status)
  }, [agents.data?.me])

  // Presence heartbeat while online or away.
  useEffect(() => {
    if (presence === 'offline' || !can('chat.reply')) return
    const beat = () => api.presence(presence).catch((e) => { toast.error(errorMessage(e)); setPresence('offline') })
    beat()
    const t = setInterval(beat, 20_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presence, appId])

  // Real-time feed: poll for changed conversations; alert on hand-offs and new chats.
  useEffect(() => {
    let stop = false
    async function tick() {
      try {
        const u = await api.updates(since.current)
        const first = since.current === null
        since.current = u.now
        if (!first && u.changed.length) {
          qc.invalidateQueries({ queryKey: cqk.inbox(appId) })
          if (selected && u.changed.some((c) => c.id === selected)) qc.invalidateQueries({ queryKey: cqk.conversation(appId, selected) })
        }
        if (!first) {
          for (const h of u.handoffs) {
            toast.warning(`${h.name} wants to talk to a person`, { action: { label: 'Open', onClick: () => setParams({ c: h.id }) } })
            notifyBrowser('Visitor waiting', `${h.name}: ${h.preview ?? ''}`)
            beep()
          }
          if (u.new_chats.length && presence === 'online') beep()
        }
      } catch {
        /* try again */
      }
      if (!stop) timer = setTimeout(tick, document.hidden ? 8000 : 2500)
    }
    let timer = setTimeout(tick, 0)
    return () => {
      stop = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, selected, presence])

  async function changePresence(s: 'online' | 'away' | 'offline') {
    if (s === 'online' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {})
    try {
      await api.presence(s)
      setPresence(s)
      qc.invalidateQueries({ queryKey: cqk.agents(appId) })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const counts = list.data?.counts
  return (
    <div>
      <PageHeader
        title="Live chat"
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${appId}` }, { label: 'Chat', to: `/apps/${appId}/chat` }, { label: 'Inbox' }]}
        actions={
          <>
            {can('chat.reply') && (
              <Select aria-label="Your status" value={presence} onChange={(e) => changePresence(e.target.value as typeof presence)} className="w-36" data-testid="presence">
                <option value="online">🟢 Online</option>
                <option value="away">🟡 Away</option>
                <option value="offline">⚪ Offline</option>
              </Select>
            )}
            <Button variant="outline" size="icon" aria-label="Inbox settings" onClick={() => setSettings(true)}>
              <Settings2 />
            </Button>
          </>
        }
      />
      <Card className="grid h-[calc(100vh-190px)] min-h-[520px] overflow-hidden md:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_300px]">
        <aside className={cn('flex min-h-0 min-w-0 flex-col border-r', selected && 'hidden md:flex')}>
          <div className="space-y-2 border-b p-3">
            <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Filter">
              {FILTERS.map(([k, label]) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={filter === k}
                  onClick={() => setFilter(k)}
                  className={cn('whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium', filter === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
                >
                  {label}
                  {counts && k in counts ? ` ${counts[k as keyof typeof counts]}` : ''}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input aria-label="Search conversations" placeholder="Search" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="conversation-list">
            {list.isLoading ? (
              <LoadingRows />
            ) : list.isError ? (
              <ErrorState error={list.error} onRetry={() => list.refetch()} />
            ) : !list.data?.items.length ? (
              <EmptyState icon={MessageSquareText} title="No conversations" description={filter === 'open' ? 'Chats that need a person show up here.' : 'Nothing here right now.'} />
            ) : (
              <ul>
                {list.data.items.map((c) => (
                  <ConversationRow key={c.id} c={c} active={c.id === selected} onClick={() => setParams({ c: c.id })} />
                ))}
              </ul>
            )}
          </div>
        </aside>
        {selected ? (
          <Conversation key={selected} id={selected} onBack={() => setParams({})} />
        ) : (
          <div className="hidden items-center justify-center md:flex xl:col-span-2">
            <EmptyState icon={MessageSquareText} title="Pick a conversation" description="Go online to receive chats. Visitors who ask for a person appear under Open and Unassigned." />
          </div>
        )}
      </Card>
      {settings && <InboxSettings onClose={() => setSettings(false)} />}
    </div>
  )
}

function ConversationRow({ c, active, onClick }: { c: InboxItem; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} data-testid="conversation-row" className={cn('flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left hover:bg-muted/50', active && 'bg-accent/60')}>
        <div className="flex items-center gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-sm', c.unread ? 'font-semibold' : 'font-medium')}>{c.name}</span>
          {c.last_message_at && <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(c.last_message_at)}</span>}
        </div>
        <p className="truncate text-xs text-muted-foreground">{c.preview}</p>
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant={c.status === 'waiting' ? 'warning' : c.status === 'open' ? 'success' : 'secondary'}>{STATUS_LABEL[c.status]}</Badge>
          {c.offline && <Badge variant="outline">Offline message</Badge>}
          {c.lead && <Badge variant="outline">Lead</Badge>}
          {c.assignee && <span className="truncate text-[11px] text-muted-foreground">→ {c.assignee.full_name}</span>}
          {c.unread > 0 && <span className="ml-auto rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">{c.unread}</span>}
        </div>
      </button>
    </li>
  )
}

// ------------------------------------------------------------------ one conversation

function Conversation({ id, onBack }: { id: string; onBack: () => void }) {
  const { app, can } = useWorkspace()
  const { user } = useAuth()
  const appId = app!.id
  const api = chatApi(appId)
  const qc = useQueryClient()
  const d = useQuery({ queryKey: cqk.conversation(appId, id), queryFn: () => api.conversation(id), refetchInterval: 2500 })
  const canned = useQuery({ queryKey: cqk.canned(appId), queryFn: () => api.canned(), staleTime: 60_000 })
  const agents = useQuery({ queryKey: cqk.agents(appId), queryFn: () => api.agents(), staleTime: 30_000 })
  const [text, setText] = useState('')
  const [note, setNote] = useState(false)
  const [busy, setBusy] = useState(false)
  const [improve, setImprove] = useState<InboxMessage | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const lastCount = useRef(0)
  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: cqk.conversation(appId, id) })
    qc.invalidateQueries({ queryKey: cqk.inbox(appId) })
  }, [qc, appId, id])

  useEffect(() => {
    api.read(id).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, d.data?.messages.length])
  useEffect(() => {
    const n = d.data?.messages.length ?? 0
    if (n !== lastCount.current) {
      lastCount.current = n
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
    }
  }, [d.data?.messages.length])

  const slash = text.startsWith('/') ? text.slice(1).toLowerCase() : null
  const suggestions = useMemo(
    () => (slash === null ? [] : (canned.data ?? []).filter((c) => c.shortcut.startsWith(slash)).slice(0, 6)),
    [slash, canned.data],
  )

  if (d.isLoading) return <div className="xl:col-span-2"><LoadingRows /></div>
  if (d.isError || !d.data) return <div className="xl:col-span-2"><ErrorState error={d.error} onRetry={() => d.refetch()} /></div>
  const c: ConversationDetail = d.data
  const mine = c.assignee?.id === user?.id && c.status === 'open'
  const closed = c.status === 'closed'

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true)
    try {
      await fn()
      if (ok) toast.success(ok)
      refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  async function send() {
    const body = text.trim()
    if (!body) return
    await act(async () => {
      await api.reply(id, body, note)
      setText('')
    })
  }

  return (
    <>
      <section className={cn('flex min-h-0 min-w-0 flex-col', 'xl:border-r')} aria-label="Conversation">
        <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Back to list" onClick={onBack}><ArrowLeft /></Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{c.name}</p>
            <p className="truncate text-xs text-muted-foreground">{c.bot.name} · {STATUS_LABEL[c.status]}{c.assignee ? ` · ${c.assignee.full_name}` : ''}</p>
          </div>
          {can('chat.reply') && !closed && !mine && (
            <Button size="sm" loading={busy} onClick={() => act(() => api.join(id), 'You joined the chat')} data-testid="take-over">
              <UserPlus /> {c.status === 'bot' ? 'Take over' : 'Join'}
            </Button>
          )}
          {can('chat.reply') && (closed ? (
            <Button size="sm" variant="outline" loading={busy} onClick={() => act(() => api.reopen(id))}><RotateCcw /> Reopen</Button>
          ) : (
            <Button size="sm" variant="outline" loading={busy} onClick={() => act(() => api.close(id), 'Chat closed')} data-testid="close-chat"><CheckCircle2 /> Close</Button>
          ))}
        </header>
        <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-muted/20 p-4" role="log" aria-live="polite" data-testid="transcript">
          {c.messages.map((m) => (
            <MessageRow key={m.id} m={m} canTrain={can('chat.write')} onImprove={() => setImprove(m)} />
          ))}
          {c.conversation.summary && (
            <div className="rounded-lg border bg-card p-3 text-sm" data-testid="ai-summary">
              <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground"><Bot className="size-3.5" /> AI summary</p>
              <p>{c.conversation.summary.text}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {c.conversation.summary.lead_quality && <Badge variant={c.conversation.summary.lead_quality === 'hot' ? 'destructive' : 'secondary'}>{c.conversation.summary.lead_quality} lead</Badge>}
                {c.conversation.summary.sentiment && <Badge variant="outline">{c.conversation.summary.sentiment}</Badge>}
                {c.conversation.summary.intent && <Badge variant="outline">{c.conversation.summary.intent}</Badge>}
              </div>
              {c.conversation.summary.follow_up && <p className="mt-1 text-xs text-muted-foreground">Follow-up: {c.conversation.summary.follow_up}</p>}
            </div>
          )}
        </div>
        {can('chat.reply') && (
          <div className="relative border-t p-3">
            {suggestions.length > 0 && (
              <ul className="absolute bottom-full left-3 right-3 mb-1 rounded-md border bg-card shadow-lg" role="listbox" aria-label="Canned responses">
                {suggestions.map((s) => (
                  <li key={s.id}>
                    <button type="button" className="flex w-full gap-2 px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => setText(s.body)}>
                      <span className="font-mono text-xs text-primary">/{s.shortcut}</span>
                      <span className="truncate text-muted-foreground">{s.body}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mb-2 flex gap-1 text-xs">
              <button type="button" className={cn('rounded px-2 py-1', !note ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')} onClick={() => setNote(false)}>Reply</button>
              <button type="button" className={cn('flex items-center gap-1 rounded px-2 py-1', note ? 'bg-warning-soft text-warning-strong' : 'hover:bg-muted')} onClick={() => setNote(true)}>
                <Lock className="size-3" /> Internal note
              </button>
              <span className="ml-auto self-center text-muted-foreground">Type / for canned responses</span>
            </div>
            <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); send() }}>
              <Textarea
                aria-label={note ? 'Internal note' : 'Reply'}
                dir="auto"
                rows={2}
                maxLength={4000}
                value={text}
                disabled={closed && !note}
                placeholder={closed ? 'This chat is closed. Reopen it to reply.' : note ? 'Only your team sees notes' : c.status === 'bot' ? 'Replying takes over from the bot' : 'Write a reply…'}
                className={cn('min-h-[44px] flex-1 resize-none', note && 'bg-warning-soft/40')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (suggestions.length && slash !== null && !text.includes(' ')) setText(suggestions[0]!.body)
                    else send()
                  }
                }}
                data-testid="reply-input"
              />
              <Button type="submit" size="icon" aria-label="Send" disabled={busy || !text.trim()} data-testid="reply-send"><Send /></Button>
            </form>
          </div>
        )}
      </section>
      <VisitorPanel c={c} assignees={agents.data?.agents ?? []} onChange={refresh} />
      {improve && (
        <ImproveDialog botId={c.bot.id} initial={{ question: improve.question ?? '', answer: '' }} messageId={improve.id} onClose={() => setImprove(null)} onSaved={refresh} />
      )}
    </>
  )
}

function MessageRow({ m, canTrain, onImprove }: { m: InboxMessage; canTrain: boolean; onImprove: () => void }) {
  if (m.role === 'system') return <p className="text-center text-xs text-muted-foreground">{m.body} · {timeAgo(m.created_at)}</p>
  if (m.role === 'note')
    return (
      <div className="mx-auto max-w-[90%] rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-strong">
        <p className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold"><Lock className="size-3" /> {m.author?.full_name ?? 'Note'} · internal</p>
        <p dir="auto" className="whitespace-pre-wrap">{m.body}</p>
      </div>
    )
  const visitor = m.role === 'visitor'
  return (
    <div className={cn('flex flex-col', visitor ? 'items-start' : 'items-end')}>
      <div dir="auto" className={cn('max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm', visitor ? 'rounded-bl-sm bg-card ring-1 ring-border' : m.role === 'bot' ? 'rounded-br-sm bg-accent' : 'rounded-br-sm bg-primary text-primary-foreground')}>
        {m.body}
      </div>
      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {m.role === 'bot' ? 'Bot' : m.role === 'agent' ? m.author?.full_name ?? 'Agent' : 'Visitor'} · {timeAgo(m.created_at)}
        {m.flag === 'unanswered' && <Badge variant="warning">Didn't know</Badge>}
        {m.meta.simulated === true && <Badge variant="outline">Simulated</Badge>}
        {m.role === 'bot' && canTrain && m.question && (
          <button type="button" className="inline-flex items-center gap-1 font-medium text-primary hover:underline" onClick={onImprove}>
            <Wand2 className="size-3" /> Improve answer
          </button>
        )}
      </p>
    </div>
  )
}

function VisitorPanel({ c, assignees, onChange }: { c: ConversationDetail; assignees: { user_id: string; full_name: string | null }[]; onChange: () => void }) {
  const { app, can } = useWorkspace()
  const api = chatApi(app!.id)
  const [tags, setTags] = useState(c.tags.join(', '))
  const v = c.visitor
  return (
    <aside className="hidden min-h-0 overflow-y-auto p-4 text-sm xl:block" aria-label="Visitor details">
      <h2 className="font-semibold">{c.contact?.name || v?.name || c.name}</h2>
      <dl className="mt-2 grid gap-1 text-xs">
        {(c.contact?.email || v?.email) && <div><dt className="inline text-muted-foreground">Email: </dt><dd className="inline break-all">{c.contact?.email || v?.email}</dd></div>}
        {(c.contact?.phone || v?.phone) && <div><dt className="inline text-muted-foreground">Phone: </dt><dd className="inline">{c.contact?.phone || v?.phone}</dd></div>}
        {c.contact?.company && <div><dt className="inline text-muted-foreground">Company: </dt><dd className="inline">{c.contact.company}</dd></div>}
      </dl>
      {c.contact ? (
        <div className="mt-3 space-y-1 rounded-md border p-2 text-xs">
          <p>Lifecycle: <span className="font-medium">{c.contact.lifecycle_stage}</span> · Score {c.contact.lead_score}</p>
          <p>Owner: <span className="font-medium">{c.contact.owner?.full_name ?? 'Unassigned'}</span></p>
          {c.contact.deals.map((dl) => <p key={dl.id}>Deal: <Link className="text-primary hover:underline" to={`/apps/${app!.id}/crm/deals/${dl.id}`}>{dl.name}</Link> ({dl.status})</p>)}
          <Link className="inline-flex items-center gap-1 font-medium text-primary hover:underline" to={`/apps/${app!.id}/audience/contacts/${c.contact.id}`} data-testid="open-contact">
            <ExternalLink className="size-3" /> Open contact
          </Link>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">No contact yet: it's created when the visitor shares an email or phone.</p>
      )}
      {can('chat.reply') && (
        <div className="mt-4 grid gap-3">
          <Field label="Assigned to" htmlFor="as">
            <Select id="as" value={c.assignee?.id ?? ''} onChange={async (e) => { try { await api.assign(c.id, e.target.value || null); onChange() } catch (err) { toast.error(errorMessage(err)) } }}>
              <option value="">Unassigned</option>
              {assignees.map((a) => <option key={a.user_id} value={a.user_id}>{a.full_name}</option>)}
            </Select>
          </Field>
          <Field label="Tags" htmlFor="tags" hint="Comma separated">
            <Input id="tags" value={tags} onChange={(e) => setTags(e.target.value)}
              onBlur={async () => { try { await api.tags(c.id, tags.split(',').map((t) => t.trim()).filter(Boolean)); onChange() } catch (err) { toast.error(errorMessage(err)) } }} />
          </Field>
        </div>
      )}
      {v && (
        <div className="mt-4 space-y-1 text-xs">
          <h3 className="font-semibold">Visit</h3>
          {v.current_page && <p className="break-all">Now on: <a className="text-primary hover:underline" href={v.current_page.url} target="_blank" rel="noreferrer noopener">{v.current_page.title || v.current_page.url}</a></p>}
          {v.referrer && <p className="break-all text-muted-foreground">From: {v.referrer}</p>}
          {Object.keys(v.utm).length > 0 && <p className="text-muted-foreground">{Object.entries(v.utm).map(([k, x]) => `${k}=${x}`).join(' · ')}</p>}
          {Object.keys(v.attributes).length > 0 && <p className="text-muted-foreground">{Object.entries(v.attributes).map(([k, x]) => `${k}: ${String(x)}`).join(' · ')}</p>}
          <p className="text-muted-foreground">First seen {timeAgo(v.first_seen_at)}</p>
          {v.pages.length > 1 && (
            <>
              <h4 className="pt-1 font-semibold">Pages visited</h4>
              <ul className="space-y-0.5">{v.pages.slice(0, 10).map((p, i) => <li key={i} className="truncate text-muted-foreground" title={p.url}>{p.title || p.url}</li>)}</ul>
            </>
          )}
        </div>
      )}
      {c.conversation.rating && <p className="mt-3 text-xs">Rating: {c.conversation.rating === 'up' ? '👍' : '👎'} {c.conversation.rating_comment}</p>}
      {c.previous.length > 0 && (
        <div className="mt-4 text-xs">
          <h3 className="font-semibold">Previous conversations</h3>
          <ul className="mt-1 space-y-1">{c.previous.map((p) => <li key={p.id}><Link className="text-primary hover:underline" to={`?c=${p.id}`}>{timeAgo(p.created_at)}</Link> <span className="text-muted-foreground">{p.summary ?? p.preview}</span></li>)}</ul>
        </div>
      )}
    </aside>
  )
}

// ------------------------------------------------------------------ agents & canned responses

function InboxSettings({ onClose }: { onClose: () => void }) {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const api = chatApi(appId)
  const qc = useQueryClient()
  const agents = useQuery({ queryKey: cqk.agents(appId), queryFn: () => api.agents() })
  const canned = useQuery({ queryKey: cqk.canned(appId), queryFn: () => api.canned() })
  const [form, setForm] = useState<Omit<CannedResponse, 'id'>>({ shortcut: '', title: '', body: '' })
  const [add, setAdd] = useState('')
  const reload = () => {
    qc.invalidateQueries({ queryKey: cqk.agents(appId) })
    qc.invalidateQueries({ queryKey: cqk.canned(appId) })
  }
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      reload()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Inbox settings</DialogTitle>
          <DialogDescription>
            Live-chat agents use {agents.data ? `${agents.data.seats.used} of ${agents.data.seats.limit ?? 'unlimited'}` : '…'} seats. Members become agents when they first go online.
          </DialogDescription>
        </DialogHeader>
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Agents</h3>
          <ul className="divide-y rounded-md border">
            {agents.data?.agents.map((a) => (
              <li key={a.user_id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className={cn('size-2 rounded-full', a.status === 'online' ? 'bg-emerald-500' : a.status === 'away' ? 'bg-amber-400' : 'bg-muted-foreground/40')} />
                <span className="flex-1 truncate">{a.full_name ?? a.email}</span>
                {can('chat.write') && <Button size="icon" variant="ghost" aria-label="Remove agent" onClick={() => run(() => api.removeAgent(a.user_id))}><Trash2 /></Button>}
              </li>
            ))}
          </ul>
          {can('chat.write') && !!agents.data?.candidates.length && (
            <div className="flex gap-2">
              <Select aria-label="Add an agent" value={add} onChange={(e) => setAdd(e.target.value)}>
                <option value="">Add a team member…</option>
                {agents.data.candidates.map((m) => <option key={m.id} value={m.id}>{m.full_name || m.email}</option>)}
              </Select>
              <Button disabled={!add} onClick={() => run(async () => { await api.addAgent(add); setAdd('') })}>Add</Button>
            </div>
          )}
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Canned responses</h3>
          <ul className="divide-y rounded-md border">
            {canned.data?.map((r) => (
              <li key={r.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                <span className="font-mono text-xs text-primary">/{r.shortcut}</span>
                <span className="min-w-0 flex-1 text-muted-foreground">{r.body}</span>
                {can('chat.reply') && <Button size="icon" variant="ghost" aria-label="Delete canned response" onClick={() => run(() => api.deleteCanned(r.id))}><Trash2 /></Button>}
              </li>
            ))}
            {!canned.data?.length && <li className="px-3 py-2 text-sm text-muted-foreground">None yet.</li>}
          </ul>
          {can('chat.reply') && (
            <form className="grid gap-2 sm:grid-cols-[120px_1fr]" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.saveCanned({ ...form, title: form.title || form.shortcut }); setForm({ shortcut: '', title: '', body: '' }) }) }}>
              <Input aria-label="Shortcut" placeholder="hello" value={form.shortcut} maxLength={40} onChange={(e) => setForm({ ...form, shortcut: e.target.value })} />
              <Input aria-label="Text" placeholder="Hi! Thanks for reaching out…" value={form.body} maxLength={4000} onChange={(e) => setForm({ ...form, body: e.target.value })} />
              <div className="sm:col-span-2"><Button type="submit" size="sm" disabled={!form.shortcut.trim() || !form.body.trim()}>Add canned response</Button></div>
            </form>
          )}
        </section>
      </DialogContent>
    </Dialog>
  )
}
