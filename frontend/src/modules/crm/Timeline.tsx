import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bot, CalendarClock, CheckSquare, ListTodo, Mail, Pencil, Phone, Pin, PinOff, StickyNote, Trash2, PhoneCall } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { errorMessage } from '@/api/client'
import { cqk, crmApi, useCrmTeam, useNotes, useTasks } from '@/api/crm'
import { EmptyState, ErrorState, LoadingRows } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/audience'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn, formatDateTime, timeAgo } from '@/lib/utils'
import type { ActivityType, CrmTarget, Task, TimelineItem } from '@/types/crm'
import { useRefreshRecord } from './hooks'
import { MentionText, TaskFields, type TaskFieldValues } from './components'
import { ACTIVITY_META, KIND_META, PRIORITY_META, shortDate, TASK_TYPE_META, toLocalInput } from './format'

const PAGE = 30
const FILTER_KINDS = ['activity', 'note', 'task', 'system', 'email', 'sms', 'call', 'profile'] as const

/** Audience history types (contact_activities) shown as kind 'profile'. */
const PROFILE_LABEL: Record<string, string> = {
  created: 'Created',
  imported: 'Import',
  updated: 'Edited',
  status_changed: 'Status',
  consent_granted: 'Consent',
  consent_revoked: 'Consent',
  email_bounced: 'Bounce',
  email_complained: 'Complaint',
  email_unsubscribed: 'Unsubscribe',
  form_submitted: 'Form',
}

// ------------------------------------------------------------------ feed

/** Newest-first history. `kinds` fixes the kinds shown (and hides the filter chips). */
export function TimelineFeed({ appId, target, kinds: fixedKinds, emptyText }: { appId: string; target: CrmTarget; kinds?: string[]; emptyText?: string }) {
  const [chosen, setKinds] = useState<string[]>([])
  const kinds = fixedKinds ?? chosen
  const kindParam = kinds.join(',')
  const q = useInfiniteQuery({
    queryKey: [...cqk.timeline(appId, target), kindParam],
    queryFn: ({ pageParam }) => crmApi(appId).timeline(target, { before: pageParam, limit: PAGE, kinds: kindParam || undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.length >= PAGE ? last[last.length - 1]!.occurred_at : undefined),
  })
  // Pages are capped per source on the server, so de-duplicate and keep a single newest-first order.
  const items = useMemo(() => {
    const seen = new Set<string>()
    const out: TimelineItem[] = []
    for (const p of q.data?.pages ?? [])
      for (const it of p)
        if (!seen.has(`${it.kind}:${it.id}`)) {
          seen.add(`${it.kind}:${it.id}`)
          out.push(it)
        }
    return out.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
  }, [q.data])

  const toggle = (k: string) => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]))

  return (
    <div>
      {!fixedKinds && (
      <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter timeline">
        <button
          type="button"
          onClick={() => setKinds([])}
          className={cn('rounded-full border px-2.5 py-0.5 text-xs font-medium transition', kinds.length === 0 ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}
          aria-pressed={kinds.length === 0}
        >
          All
        </button>
        {FILTER_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => toggle(k)}
            aria-pressed={kinds.includes(k)}
            className={cn('rounded-full border px-2.5 py-0.5 text-xs font-medium transition', kinds.includes(k) ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}
          >
            {KIND_META[k]!.label}
          </button>
        ))}
      </div>
      )}
      {q.isLoading ? (
        <LoadingRows rows={4} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing here yet" description={emptyText ?? 'Calls, meetings, notes, completed tasks, campaign messages and profile changes show up here.'} />
      ) : (
        <ol className="relative space-y-4 border-l pl-6" data-testid="timeline">
          {items.map((it) => (
            <TimelineEntry key={`${it.kind}:${it.id}`} it={it} />
          ))}
        </ol>
      )}
      {q.hasNextPage && (
        <div className="mt-4 text-center">
          <Button variant="outline" size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}

function TimelineEntry({ it }: { it: TimelineItem }) {
  const meta = KIND_META[it.kind] ?? KIND_META.system!
  const actIcon = it.kind === 'activity' ? ACTIVITY_META[it.type as ActivityType]?.icon : undefined
  const Icon = actIcon ?? meta.icon
  const outcome = it.meta.outcome as string | undefined
  const duration = it.meta.duration_minutes as number | undefined
  const campaign = it.meta.campaign as string | undefined
  if (it.type === 'ai_call') return <AiCallEntry it={it} />
  if (it.type === 'chat') return <ChatEntry it={it} />
  return (
    <li className="relative" data-kind={it.kind}>
      <span className={cn('absolute -left-[37px] top-0 flex size-6 items-center justify-center rounded-full ring-4 ring-card', meta.tone)}>
        <Icon className="size-3.5" />
      </span>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={cn('text-sm', it.kind === 'system' ? 'text-muted-foreground' : 'font-medium')}>{it.title}</span>
        {it.kind === 'activity' && <Badge variant="secondary">{ACTIVITY_META[it.type as ActivityType]?.label ?? it.type}</Badge>}
        {it.kind === 'profile' && <Badge variant="outline">{PROFILE_LABEL[it.type] ?? 'Profile'}</Badge>}
        {outcome && <Badge variant="outline">{outcome}</Badge>}
        {duration ? <span className="text-xs text-muted-foreground">{duration} min</span> : null}
      </div>
      {it.body && (it.kind === 'note' ? <MentionText body={it.body} className="mt-1 rounded-md bg-muted/40 p-2" /> : <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">{it.body}</p>)}
      <p className="mt-0.5 text-xs text-muted-foreground" title={formatDateTime(it.occurred_at)}>
        {timeAgo(it.occurred_at)}
        {it.actor && ` · ${it.actor.full_name}`}
        {campaign && ` · ${campaign}`}
      </p>
    </li>
  )
}

/** A website chat: AI summary, lead quality, sentiment, follow-up and a link to the conversation. */
function ChatEntry({ it }: { it: TimelineItem }) {
  const { appId } = useParams()
  const m = it.meta as { conversation_id?: string; lead_quality?: string; sentiment?: string; intent?: string; follow_up?: string; simulated?: boolean }
  const meta = KIND_META.system!
  return (
    <li className="relative" data-kind="chat" data-testid="timeline-chat">
      <span className={cn('absolute -left-[37px] top-0 flex size-6 items-center justify-center rounded-full ring-4 ring-card', meta.tone)}>
        <Bot className="size-3.5" />
      </span>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{it.title}</span>
        <Badge variant="secondary">Chat</Badge>
        {m.lead_quality && <Badge variant={m.lead_quality === 'hot' ? 'destructive' : 'outline'}>{m.lead_quality} lead</Badge>}
        {m.sentiment && <Badge variant="outline">{m.sentiment}</Badge>}
      </div>
      {it.body && <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">{it.body}</p>}
      {m.follow_up && <p className="mt-0.5 text-xs text-muted-foreground">Follow-up: {m.follow_up}</p>}
      <p className="mt-0.5 text-xs text-muted-foreground" title={formatDateTime(it.occurred_at)}>
        {timeAgo(it.occurred_at)}
        {it.actor && ` · ${it.actor.full_name}`}
        {appId && m.conversation_id && (
          <>
            {' · '}
            <Link className="font-medium text-primary hover:underline" to={`/apps/${appId}/chat/inbox?c=${m.conversation_id}`}>
              View chat
            </Link>
          </>
        )}
      </p>
    </li>
  )
}

/** An AI-agent call pushed into the CRM: summary, interest and sentiment, captured fields, link to the call. */
function AiCallEntry({ it }: { it: TimelineItem }) {
  const { appId } = useParams()
  const m = it.meta as { voice_call_id?: string; campaign_id?: string; campaign?: string; sentiment?: string; interest?: string; next_step?: string; outcomes?: { key: string; label: string; value: unknown }[] }
  const meta = KIND_META.call ?? KIND_META.system!
  const show = (v: unknown) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v === null || v === undefined || v === '' ? '—' : String(v))
  return (
    <li className="relative" data-kind="ai_call" data-testid="timeline-ai-call">
      <span className={cn('absolute -left-[37px] top-0 flex size-6 items-center justify-center rounded-full ring-4 ring-card', meta.tone)}>
        <Bot className="size-3.5" />
      </span>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{it.title}</span>
        <Badge variant="secondary">AI call</Badge>
        {m.sentiment && <Badge variant="outline">{m.sentiment}</Badge>}
      </div>
      {it.body && <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">{it.body}</p>}
      {!!m.outcomes?.length && (
        <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
          {m.outcomes.map((o) => (
            <div key={o.key} className="flex min-w-0 gap-1">
              <dt className="text-muted-foreground">{o.label}:</dt>
              <dd className="min-w-0 truncate font-medium">{show(o.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {m.next_step && <p className="mt-0.5 text-xs text-muted-foreground">Next step: {m.next_step}</p>}
      <p className="mt-0.5 text-xs text-muted-foreground" title={formatDateTime(it.occurred_at)}>
        {timeAgo(it.occurred_at)}
        {m.campaign && ` · ${m.campaign}`}
        {appId && m.campaign_id && m.voice_call_id && (
          <>
            {' · '}
            <Link className="font-medium text-primary hover:underline" to={`/apps/${appId}/voice/campaigns/${m.campaign_id}?call=${m.voice_call_id}`}>
              View call
            </Link>
          </>
        )}
      </p>
    </li>
  )
}

// ------------------------------------------------------------------ composer

type Mode = 'activity' | 'note' | 'task'

export function Composer({ appId, target, initial = 'activity' }: { appId: string; target: CrmTarget; initial?: Mode }) {
  const { can } = useWorkspace()
  const [mode, setMode] = useState<Mode>(initial)
  if (!can('crm.write')) return null
  const tabs: [Mode, string, typeof PhoneCall][] = [
    ['activity', 'Log activity', PhoneCall],
    ['note', 'Add note', StickyNote],
    ['task', 'Add task', ListTodo],
  ]
  return (
    <Card className="mb-5">
      <div className="flex gap-1 border-b px-3 pt-2" role="tablist">
        {tabs.map(([m, label, Icon]) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cn('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition', mode === m ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>
      <CardContent className="pt-4">
        {mode === 'activity' ? <ActivityForm appId={appId} target={target} /> : mode === 'note' ? <NoteForm appId={appId} target={target} /> : <InlineTaskForm appId={appId} target={target} />}
      </CardContent>
    </Card>
  )
}

const OUTCOMES: Record<string, string[]> = {
  call: ['Connected', 'No answer', 'Left voicemail', 'Busy', 'Wrong number'],
  meeting: ['Held', 'Rescheduled', 'No show'],
  visit: ['Held', 'Rescheduled', 'No show'],
}

function ActivityForm({ appId, target }: { appId: string; target: CrmTarget }) {
  const refresh = useRefreshRecord(appId)
  const qc = useQueryClient()
  const [type, setType] = useState<ActivityType>('call')
  const [subject, setSubject] = useState('')
  const [outcome, setOutcome] = useState('')
  const [duration, setDuration] = useState('')
  const [when, setWhen] = useState(() => toLocalInput(new Date()))
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!subject.trim()) return
    setBusy(true)
    try {
      await crmApi(appId).logActivity({
        type,
        subject: subject.trim(),
        body: body || null,
        outcome: outcome || null,
        duration_minutes: duration ? Number(duration) : null,
        occurred_at: when ? new Date(when).toISOString() : null,
        ...target,
      })
      await refresh()
      // Logging an activity can satisfy the first-response SLA and change scores.
      await qc.invalidateQueries({ queryKey: cqk.all(appId) })
      toast.success('Activity logged')
      setSubject('')
      setOutcome('')
      setDuration('')
      setBody('')
      setWhen(toLocalInput(new Date()))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="grid gap-3 sm:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      aria-label="Log activity"
    >
      <Field label="Type" htmlFor="act-type">
        <Select id="act-type" value={type} onChange={(e) => setType(e.target.value as ActivityType)}>
          {Object.entries(ACTIVITY_META).map(([k, m]) => (
            <option key={k} value={k}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Subject" htmlFor="act-subject" className="sm:col-span-3">
        <Input id="act-subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} placeholder="Discussed pricing" />
      </Field>
      <Field label="Outcome" htmlFor="act-outcome">
        <Input id="act-outcome" list="act-outcomes" value={outcome} maxLength={40} onChange={(e) => setOutcome(e.target.value)} />
        <datalist id="act-outcomes">
          {(OUTCOMES[type] ?? []).map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      </Field>
      <Field label="Duration (min)" htmlFor="act-duration">
        <Input id="act-duration" type="number" min={0} max={1440} value={duration} onChange={(e) => setDuration(e.target.value)} />
      </Field>
      <Field label="When" htmlFor="act-when" className="sm:col-span-2">
        <Input id="act-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
      </Field>
      <Field label="Details (optional)" htmlFor="act-body" className="sm:col-span-4">
        <Textarea id="act-body" rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <div className="flex justify-end sm:col-span-4">
        <Button type="submit" loading={busy} disabled={!subject.trim()}>
          Log activity
        </Button>
      </div>
    </form>
  )
}

/** Textarea with an @mention picker; picked people are written as `@[Full Name](user-id)`. */
export function MentionTextarea({ appId, value, onChange, id, placeholder }: { appId: string; value: string; onChange: (v: string) => void; id: string; placeholder?: string }) {
  const team = useCrmTeam(appId)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const matches = query === null ? [] : (team.data ?? []).filter((u) => u.full_name.toLowerCase().includes(query.toLowerCase())).slice(0, 6)

  const detect = (text: string, caret: number) => {
    const m = /(^|\s)@([\w.-]{0,30})$/.exec(text.slice(0, caret))
    setQuery(m ? m[2]! : null)
    setActive(0)
  }
  const pick = (u: { id: string; full_name: string }) => {
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const before = value.slice(0, caret).replace(/@([\w.-]{0,30})$/, `@[${u.full_name}](${u.id}) `)
    const next = before + value.slice(caret)
    onChange(next)
    setQuery(null)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(before.length, before.length)
    })
  }
  return (
    <div className="relative">
      <Textarea
        ref={ref}
        id={id}
        rows={3}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value)
          detect(e.target.value, e.target.selectionStart)
        }}
        onKeyDown={(e) => {
          if (!matches.length) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => (a + 1) % matches.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => (a - 1 + matches.length) % matches.length)
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            pick(matches[active]!)
          } else if (e.key === 'Escape') setQuery(null)
        }}
        onBlur={() => window.setTimeout(() => setQuery(null), 150)}
      />
      {matches.length > 0 && (
        <div className="absolute left-2 top-full z-50 mt-1 w-64 rounded-md border bg-popover p-1 shadow-pop" role="listbox" aria-label="Mention a teammate">
          {matches.map((u, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              key={u.id}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(u)
              }}
              className={cn('flex w-full flex-col rounded px-2 py-1.5 text-left text-sm', i === active ? 'bg-muted' : 'hover:bg-muted')}
            >
              <span className="font-medium">{u.full_name}</span>
              {u.email && <span className="text-xs text-muted-foreground">{u.email}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NoteForm({ appId, target }: { appId: string; target: CrmTarget }) {
  const refresh = useRefreshRecord(appId)
  const [body, setBody] = useState('')
  const [pinned, setPinned] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <form
      aria-label="Add note"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!body.trim()) return
        setBusy(true)
        try {
          await crmApi(appId).createNote({ body: body.trim(), pinned, ...target })
          await refresh()
          toast.success('Note added')
          setBody('')
          setPinned(false)
        } catch (err) {
          toast.error(errorMessage(err))
        } finally {
          setBusy(false)
        }
      }}
      className="space-y-3"
    >
      <Field label="Note" htmlFor="note-body" hint="Type @ to mention a teammate. They get a notification.">
        <MentionTextarea appId={appId} id="note-body" value={body} onChange={setBody} placeholder="What happened? Type @ to mention someone" />
      </Field>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to top
        </label>
        <Button type="submit" loading={busy} disabled={!body.trim()}>
          Add note
        </Button>
      </div>
    </form>
  )
}

function InlineTaskForm({ appId, target }: { appId: string; target: CrmTarget }) {
  const refresh = useRefreshRecord(appId)
  const blank = (): TaskFieldValues => {
    const d = new Date(Date.now() + 864e5)
    d.setHours(10, 0, 0, 0)
    return { title: '', type: 'follow_up', priority: 'normal', due: toLocalInput(d), assignee: '', notes: '' }
  }
  const [v, setV] = useState<TaskFieldValues>(blank)
  const [busy, setBusy] = useState(false)
  return (
    <form
      aria-label="Add task"
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!v.title.trim()) return
        setBusy(true)
        try {
          await crmApi(appId).createTask({
            title: v.title.trim(),
            type: v.type,
            priority: v.priority,
            due_at: v.due ? new Date(v.due).toISOString() : null,
            assignee_id: v.assignee || undefined,
            notes: v.notes || undefined,
            ...target,
          })
          await refresh()
          toast.success('Task created')
          setV(blank())
        } catch (err) {
          toast.error(errorMessage(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <TaskFields appId={appId} v={v} set={(p) => setV((x) => ({ ...x, ...p }))} idPrefix="ctask" />
      <div className="flex justify-end sm:col-span-2">
        <Button type="submit" loading={busy} disabled={!v.title.trim()}>
          Add task
        </Button>
      </div>
    </form>
  )
}

// ------------------------------------------------------------------ notes & tasks lists

export function NotesList({ appId, target }: { appId: string; target: CrmTarget }) {
  const q = useNotes(appId, target)
  const { user } = useAuth()
  const { can } = useWorkspace()
  const refresh = useRefreshRecord(appId)
  const notes = [...(q.data ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at.localeCompare(a.created_at))
  if (q.isLoading) return <LoadingRows rows={2} />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  if (!notes.length) return <EmptyState icon={StickyNote} title="No notes yet" description="Add a note above. Mention teammates with @." />
  return (
    <ul className="space-y-3" data-testid="notes-list">
      {notes.map((n) => {
        const mine = n.author?.id === user?.id
        return (
          <li key={n.id} className={cn('rounded-lg border p-3', n.pinned && 'border-amber-300 bg-amber-50/50 dark:border-amber-500/30 dark:bg-amber-500/5')}>
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              {n.pinned && <Pin className="size-3 text-amber-600" />}
              <span className="font-medium text-foreground">{n.author?.full_name ?? 'Someone'}</span>
              <span title={formatDateTime(n.created_at)}>{timeAgo(n.created_at)}</span>
              <span className="ml-auto flex gap-1">
                {mine && (
                  <button
                    type="button"
                    className="rounded p-1 hover:bg-muted"
                    aria-label={n.pinned ? 'Unpin note' : 'Pin note'}
                    onClick={async () => {
                      await crmApi(appId).updateNote(n.id, { pinned: !n.pinned }).catch((e) => toast.error(errorMessage(e)))
                      void refresh()
                    }}
                  >
                    {n.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  </button>
                )}
                {(mine || can('crm.manage')) && (
                  <button
                    type="button"
                    className="rounded p-1 text-destructive hover:bg-danger-soft"
                    aria-label="Delete note"
                    onClick={async () => {
                      await crmApi(appId).deleteNote(n.id).catch((e) => toast.error(errorMessage(e)))
                      void refresh()
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </span>
            </div>
            <MentionText body={n.body} />
          </li>
        )
      })}
    </ul>
  )
}

function addDays(iso: string | null, days: number) {
  const d = iso ? new Date(iso) : new Date()
  if (!iso || d.getTime() < Date.now()) {
    // Overdue or undated: move relative to today, keeping a working-hours time.
    const now = new Date()
    now.setHours(iso ? d.getHours() : 10, iso ? d.getMinutes() : 0, 0, 0)
    now.setDate(now.getDate() + days)
    return now.toISOString()
  }
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

export function TaskRow({ appId, t, showRelated = false, highlight = false, autoEdit = false }: { appId: string; t: Task; showRelated?: boolean; highlight?: boolean; autoEdit?: boolean }) {
  const { can } = useWorkspace()
  const refresh = useRefreshRecord(appId)
  const qc = useQueryClient()
  const [done, setDone] = useState(t.status === 'done')
  const [editing, setEditing] = useState(autoEdit)
  const [confirmDel, setConfirmDel] = useState(false)
  const TypeIcon = TASK_TYPE_META[t.type]?.icon ?? CheckSquare
  const base = `/apps/${appId}`
  const write = can('crm.write')
  const reload = async () => {
    await refresh()
    await qc.invalidateQueries({ queryKey: cqk.all(appId) })
  }
  const reschedule = async (days: number, label: string) => {
    try {
      await crmApi(appId).updateTask(t.id, { due_at: addDays(t.due_at, days) })
      toast.success(`Moved to ${label}`)
      await reload()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const remove = async () => {
    try {
      await crmApi(appId).deleteTask(t.id)
      toast.success('Task deleted')
      setConfirmDel(false)
      await reload()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const toggle = async (next: boolean) => {
    setDone(next)
    try {
      await crmApi(appId).updateTask(t.id, { status: next ? 'done' : 'open' })
      if (next) toast.success('Task completed')
      await refresh()
      await qc.invalidateQueries({ queryKey: cqk.all(appId) })
    } catch (e) {
      setDone(!next)
      toast.error(errorMessage(e))
    }
  }
  const phone = t.contact?.phone
  const email = t.contact?.email
  return (
    <li className={cn('flex flex-wrap items-start gap-3 px-4 py-3 sm:flex-nowrap', highlight && 'bg-primary/5')} data-testid="task-row" data-task-id={t.id}>
      <Checkbox className="mt-0.5" checked={done} disabled={!write} onChange={(e) => void toggle(e.target.checked)} aria-label={`Complete ${t.title}`} />
      <TypeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label={TASK_TYPE_META[t.type]?.label} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('text-sm font-medium', done && 'text-muted-foreground line-through')}>{t.title}</span>
          {t.priority === 'high' && <Badge variant="destructive">High</Badge>}
          {t.priority === 'low' && <span className={cn('text-xs', PRIORITY_META.low.className)}>Low</span>}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {t.due_at && (
            <span className={cn(t.overdue && !done && 'font-medium text-destructive')} title={formatDateTime(t.due_at)}>
              {t.overdue && !done ? 'Overdue · ' : 'Due '}
              {shortDate(t.due_at)} {new Date(t.due_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
          {t.assignee && <span>{t.assignee.full_name}</span>}
          {showRelated && t.deal && (
            <Link className="text-primary hover:underline" to={`${base}/crm/deals/${t.deal.id}`}>
              {t.deal.name}
            </Link>
          )}
          {showRelated && t.contact && (
            <Link className="text-primary hover:underline" to={`${base}/audience/contacts/${t.contact.id}`}>
              {t.contact.name}
            </Link>
          )}
          {showRelated && t.company && (
            <Link className="text-primary hover:underline" to={`${base}/crm/companies/${t.company.id}`}>
              {t.company.name}
            </Link>
          )}
          {t.type === 'call' && phone && (
            <a className="inline-flex items-center gap-1 text-primary hover:underline" href={`tel:${phone}`} data-testid="task-tel">
              <Phone className="size-3" /> {phone}
            </a>
          )}
          {t.type === 'email' && email && (
            <a className="inline-flex items-center gap-1 text-primary hover:underline" href={`mailto:${email}`} data-testid="task-mailto">
              <Mail className="size-3" /> {email}
            </a>
          )}
        </div>
        {t.notes && <p className="mt-1 text-xs text-muted-foreground">{t.notes}</p>}
      </div>
      {write && !done && (
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={`Reschedule ${t.title}`} title="Reschedule">
                <CalendarClock />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void reschedule(1, 'tomorrow')}>+1 day</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void reschedule(7, 'next week')}>Next week</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditing(true)}>Pick a date…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="sm" aria-label={`Edit ${t.title}`} title="Edit" onClick={() => setEditing(true)}>
            <Pencil />
          </Button>
          <Button variant="ghost" size="sm" aria-label={`Delete ${t.title}`} title="Delete" className="text-destructive" onClick={() => setConfirmDel(true)}>
            <Trash2 />
          </Button>
        </div>
      )}
      {write && done && (
        <Button variant="ghost" size="sm" className="ml-auto text-destructive" aria-label={`Delete ${t.title}`} title="Delete" onClick={() => setConfirmDel(true)}>
          <Trash2 />
        </Button>
      )}
      <TaskEditDialog appId={appId} t={t} open={editing} onOpenChange={setEditing} onSaved={reload} />
      <Dialog open={confirmDel} onOpenChange={setConfirmDel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete task?</DialogTitle>
            <DialogDescription>“{t.title}” will be removed. This can’t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDel(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void remove()}>
              Delete task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  )
}

/** Edit a task's title, type, priority, due date, assignee and notes. */
export function TaskEditDialog({ appId, t, open, onOpenChange, onSaved }: { appId: string; t: Task; open: boolean; onOpenChange: (o: boolean) => void; onSaved?: () => void | Promise<unknown> }) {
  const [v, setV] = useState<TaskFieldValues>(() => fromTask(t))
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setV(fromTask(t))
  }, [open, t])
  const submit = async () => {
    if (!v.title.trim()) return
    setBusy(true)
    try {
      await crmApi(appId).updateTask(t.id, {
        title: v.title.trim(),
        type: v.type,
        priority: v.priority,
        due_at: v.due ? new Date(v.due).toISOString() : null,
        ...(v.assignee ? { assignee_id: v.assignee } : {}),
        notes: v.notes || null,
      })
      toast.success('Task updated')
      onOpenChange(false)
      await onSaved?.()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit task</DialogTitle>
          <DialogDescription>{t.contact ? `For ${t.contact.name}` : t.deal ? `For ${t.deal.name}` : 'Change the details or reschedule.'}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <TaskFields appId={appId} v={v} set={(p) => setV((x) => ({ ...x, ...p }))} idPrefix={`etask-${t.id.slice(0, 6)}`} />
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!v.title.trim()}>
              Save task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function fromTask(t: Task): TaskFieldValues {
  return { title: t.title, type: t.type, priority: t.priority, due: t.due_at ? toLocalInput(new Date(t.due_at)) : '', assignee: t.assignee?.id ?? '', notes: t.notes ?? '' }
}

export function RecordTasks({ appId, target }: { appId: string; target: CrmTarget }) {
  const [status, setStatus] = useState<'open' | 'done'>('open')
  const q = useTasks(appId, { ...target, status, page: 1, page_size: 50 })
  return (
    <div>
      <div className="mb-2 flex gap-1">
        {(['open', 'done'] as const).map((s) => (
          <Button key={s} size="sm" variant={status === s ? 'secondary' : 'ghost'} onClick={() => setStatus(s)}>
            {s === 'open' ? 'Open' : 'Done'}
          </Button>
        ))}
      </div>
      {q.isLoading ? (
        <LoadingRows rows={2} />
      ) : !q.data?.items.length ? (
        <EmptyState icon={CheckSquare} title={status === 'open' ? 'No open tasks' : 'No completed tasks'} />
      ) : (
        <Card>
          <ul className="divide-y">
            {q.data.items.map((t) => (
              <TaskRow key={t.id} appId={appId} t={t} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

/** Timeline / Notes / Tasks tabs with the composer above. Used on contact, deal and company pages. */
export function RecordActivity({ appId, target }: { appId: string; target: CrmTarget }) {
  const [tab, setTab] = useState('timeline')
  return (
    <div>
      <Composer appId={appId} target={target} initial={tab === 'notes' ? 'note' : tab === 'tasks' ? 'task' : 'activity'} key={tab} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="pt-4">
          <TimelineFeed appId={appId} target={target} />
        </TabsContent>
        <TabsContent value="notes" className="pt-4">
          <NotesList appId={appId} target={target} />
        </TabsContent>
        <TabsContent value="tasks" className="pt-4">
          <RecordTasks appId={appId} target={target} />
        </TabsContent>
      </Tabs>
    </div>
  )
}


