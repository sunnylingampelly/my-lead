import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Flame, Loader2, Plus, Search, X } from 'lucide-react'
import { audienceApi } from '@/api/audience'
import { ApiError, errorMessage } from '@/api/client'
import { cqk, crmApi, useCrmTeam, useLostReasons, usePipelines } from '@/api/crm'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Avatar, Badge } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Lifecycle, Priority, Ref, TaskType, UserRef } from '@/types/crm'
import { useDebounced } from './hooks'
import { countdown, isoDate, LIFECYCLE_LABEL, PRIORITY_META, TASK_TYPE_META, toLocalInput } from './format'

// ------------------------------------------------------------------ small display pieces

export function OwnerAvatar({ owner, className }: { owner: UserRef | null | undefined; className?: string }) {
  if (!owner)
    return (
      <span className={cn('inline-flex h-6 items-center whitespace-nowrap rounded-full border border-dashed px-2 text-[10px] text-muted-foreground', className)}>
        Unassigned
      </span>
    )
  return (
    <Tooltip content={owner.full_name}>
      <span className="inline-flex">
        <Avatar name={owner.full_name} className={cn('size-6 text-[10px]', className)} />
      </span>
    </Tooltip>
  )
}

const GRADE_TONE: Record<string, string> = {
  A: 'bg-success-soft text-success-strong ring-success-border',
  B: 'bg-warning-soft text-warning-strong ring-warning-border',
  C: 'bg-muted text-muted-foreground ring-border',
}

export function GradeBadge({ grade, fit, engagement, score }: { grade: string; fit: number; engagement: number; score: number }) {
  return (
    <Tooltip
      content={
        <span className="block space-y-0.5">
          <span className="block">Lead score {score}</span>
          <span className="block">Fit {fit} · Engagement {engagement}</span>
          <span className="block opacity-70">Letter = fit (A best), number = engagement (1 best)</span>
        </span>
      }
    >
      <span
        tabIndex={0}
        className={cn('inline-flex h-5 items-center rounded px-1.5 font-mono text-[11px] font-semibold ring-1 ring-inset', GRADE_TONE[grade[0] ?? 'C'] ?? GRADE_TONE.C)}
        aria-label={`Grade ${grade}, fit ${fit}, engagement ${engagement}`}
      >
        {grade}
      </span>
    </Tooltip>
  )
}

export function HotBadge() {
  return (
    <Badge variant="destructive" className="gap-0.5">
      <Flame className="size-3" /> Hot
    </Badge>
  )
}

export function SlaStatus({ due, breached, responded }: { due: string | null; breached: string | null; responded: string | null }) {
  if (responded)
    return (
      <Badge variant="success" title={`Responded ${new Date(responded).toLocaleString()}`}>
        Responded
      </Badge>
    )
  if (breached)
    return (
      <Badge variant="destructive" title={`Breached ${new Date(breached).toLocaleString()}`}>
        SLA breached
      </Badge>
    )
  if (due) {
    const late = new Date(due).getTime() < Date.now()
    return (
      <Badge variant={late ? 'destructive' : 'warning'} title={`Respond by ${new Date(due).toLocaleString()}`}>
        {late ? 'Overdue' : `Due ${countdown(due)}`}
      </Badge>
    )
  }
  return <span className="text-xs text-muted-foreground">—</span>
}

export function LifecycleBadge({ stage }: { stage: string }) {
  const variant = stage === 'customer' ? 'success' : stage === 'sql' || stage === 'opportunity' ? 'default' : 'secondary'
  return <Badge variant={variant}>{LIFECYCLE_LABEL[stage as Lifecycle] ?? stage}</Badge>
}

/** Renders note bodies, turning `@[Full Name](user-id)` into highlighted names. */
export function MentionText({ body, className }: { body: string; className?: string }) {
  const parts: ReactNode[] = []
  const re = /@\[([^\]]+)\]\(([^)]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    if (m.index > last) parts.push(body.slice(last, m.index))
    parts.push(
      <span key={m.index} className="rounded bg-primary/10 px-1 font-medium text-primary" data-mention={m[2]}>
        @{m[1]}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < body.length) parts.push(body.slice(last))
  return <p className={cn('whitespace-pre-wrap break-words text-sm', className)}>{parts}</p>
}

// ------------------------------------------------------------------ pickers

export function OwnerSelect({
  appId,
  value,
  onChange,
  id,
  allowNone = true,
  noneLabel = 'Unassigned',
}: {
  appId: string
  value: string
  onChange: (v: string) => void
  id?: string
  allowNone?: boolean
  noneLabel?: string
}) {
  const team = useCrmTeam(appId)
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone && <option value="">{noneLabel}</option>}
      {team.data?.map((u) => (
        <option key={u.id} value={u.id}>
          {u.full_name}
        </option>
      ))}
    </Select>
  )
}


/** Type-ahead picker for a record. Shows the chosen record as a chip with a clear button. */
function RecordPicker({
  id,
  value,
  onChange,
  placeholder,
  search,
  queryKey,
  disabled,
  createLabel,
  onCreate,
}: {
  id?: string
  value: Ref | null
  onChange: (v: Ref | null) => void
  placeholder: string
  search: (q: string) => Promise<(Ref & { hint?: string | null })[]>
  queryKey: readonly unknown[]
  disabled?: boolean
  /** e.g. q => `Create company “${q}”`. With onCreate, offers to create what was typed. */
  createLabel?: (q: string) => string
  /** Create a record from the typed text. Resolve with it to select it, or null if cancelled. */
  onCreate?: (q: string) => Promise<Ref | null>
}) {
  const [creating, setCreating] = useState(false)
  const create = async () => {
    if (!onCreate) return
    setCreating(true)
    try {
      const made = await onCreate(q.trim())
      if (made) {
        onChange(made)
        setQ('')
        setOpen(false)
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setCreating(false)
    }
  }
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const dq = useDebounced(q)
  const box = useRef<HTMLDivElement>(null)
  const results = useQuery({ queryKey: [...queryKey, dq], queryFn: () => search(dq), enabled: open })
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  if (value)
    return (
      <div className="flex h-9 items-center justify-between rounded-md border bg-muted/40 px-3 text-sm">
        <span className="truncate font-medium">{value.name}</span>
        {!disabled && (
          <button type="button" onClick={() => onChange(null)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Clear ${value.name}`}>
            <X className="size-3.5" />
          </button>
        )}
      </div>
    )
  return (
    <div ref={box} className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
      <Input
        id={id}
        value={q}
        disabled={disabled}
        placeholder={placeholder}
        className="pl-8"
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
          if (e.key === 'Enter') {
            e.preventDefault()
            const first = results.data?.[0]
            if (first) {
              onChange({ id: first.id, name: first.name })
              setQ('')
              setOpen(false)
            }
          }
        }}
      />
      {open && (
        <div className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-pop" role="listbox">
          {results.isLoading ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Searching…
            </div>
          ) : !results.data?.length ? (
            !onCreate || !q.trim() ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">{onCreate ? 'No matches. Type a name to create one.' : 'No matches'}</div>
            ) : null
          ) : (
            results.data.map((r) => (
              <button
                type="button"
                role="option"
                aria-selected={false}
                key={r.id}
                onClick={() => {
                  onChange({ id: r.id, name: r.name })
                  setQ('')
                  setOpen(false)
                }}
                className="flex w-full flex-col items-start rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <span className="font-medium">{r.name}</span>
                {r.hint && <span className="text-xs text-muted-foreground">{r.hint}</span>}
              </button>
            ))
          )}
          {onCreate && q.trim() && !results.isLoading && !results.data?.some((r) => r.name.toLowerCase() === q.trim().toLowerCase()) && (
            <button
              type="button"
              role="option"
              aria-selected={false}
              disabled={creating}
              onClick={() => void create()}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm font-medium text-primary hover:bg-muted"
            >
              {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              {createLabel ? createLabel(q.trim()) : `Create “${q.trim()}”`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function ContactPicker({
  appId,
  allowCreate = true,
  createDefaults,
  ...p
}: {
  appId: string
  id?: string
  value: Ref | null
  onChange: (v: Ref | null) => void
  disabled?: boolean
  placeholder?: string
  allowCreate?: boolean
  /** Extra fields for a contact created from the picker (e.g. the company it is being added to). */
  createDefaults?: { company_id?: string }
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<{ name: string; resolve: (r: Ref | null) => void } | null>(null)
  return (
    <>
      <RecordPicker
        {...p}
        placeholder={p.placeholder ?? 'Search contacts by name, email or phone'}
        queryKey={['crm', appId, 'pick-contact']}
        search={async (q) => {
          const r = await audienceApi(appId).contacts({ search: q || undefined, page: 1, page_size: 8 })
          return r.items.map((c) => ({ id: c.id, name: c.full_name || c.email || c.phone_display || 'Unnamed', hint: [c.email, c.phone_display].filter(Boolean).join(' · ') }))
        }}
        createLabel={(q) => `Create contact “${q}”`}
        onCreate={allowCreate ? (q) => new Promise<Ref | null>((resolve) => setDraft({ name: q, resolve })) : undefined}
      />
      <QuickContactDialog
        appId={appId}
        draft={draft?.name ?? null}
        defaults={createDefaults}
        onDone={(r) => {
          draft?.resolve(r)
          setDraft(null)
          if (r) void qc.invalidateQueries({ queryKey: ['aud', appId] })
        }}
      />
    </>
  )
}

/** A minimal "new contact" form: name plus email or phone. */
export function QuickContactDialog({
  appId,
  draft,
  defaults,
  onDone,
}: {
  appId: string
  /** The typed name; null closes the dialog. */
  draft: string | null
  defaults?: { company_id?: string }
  onDone: (r: Ref | null) => void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (draft === null) return
    const looksEmail = draft.includes('@')
    const looksPhone = /^[+\d][\d\s-]{5,}$/.test(draft)
    setName(looksEmail || looksPhone ? '' : draft)
    setEmail(looksEmail ? draft : '')
    setPhone(looksPhone ? draft : '')
    setErr('')
  }, [draft])
  const submit = async () => {
    if (!email.trim() && !phone.trim()) return setErr('Enter an email or a phone number')
    const [first, ...rest] = name.trim().split(/\s+/)
    setBusy(true)
    try {
      const c = await audienceApi(appId).createContact({
        first_name: first || null,
        last_name: rest.join(' ') || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        ...(defaults?.company_id ? { company_id: defaults.company_id } : {}),
      })
      toast.success('Contact created')
      onDone({ id: c.id, name: c.full_name || c.email || c.phone_display || 'Unnamed' })
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={draft !== null} onOpenChange={(o) => !o && !busy && onDone(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New contact</DialogTitle>
          <DialogDescription>Add the basics now; you can fill in the rest on their profile.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void submit()
          }}
        >
          <Field label="Name" htmlFor="qc-name">
            <Input id="qc-name" autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Asha Rao" />
          </Field>
          <Field label="Email" htmlFor="qc-email">
            <Input id="qc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="asha@company.com" />
          </Field>
          <Field label="Phone" htmlFor="qc-phone" error={err || undefined}>
            <Input id="qc-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onDone(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Create contact
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function CompanyPicker({
  appId,
  allowCreate = true,
  ...p
}: {
  appId: string
  id?: string
  value: Ref | null
  onChange: (v: Ref | null) => void
  disabled?: boolean
  placeholder?: string
  allowCreate?: boolean
}) {
  const qc = useQueryClient()
  return (
    <RecordPicker
      {...p}
      placeholder={p.placeholder ?? 'Search companies'}
      queryKey={['crm', appId, 'pick-company']}
      search={async (q) => {
        const r = await crmApi(appId).companies({ search: q || undefined, page: 1, page_size: 8 })
        return r.items.map((c) => ({ id: c.id, name: c.name, hint: [c.domain, c.city].filter(Boolean).join(' · ') }))
      }}
      createLabel={(q) => `Create company “${q}”`}
      onCreate={
        allowCreate
          ? async (q) => {
              let c
              try {
                c = await crmApi(appId).createCompany({ name: q })
              } catch (e) {
                // A similar company exists: offer it instead of failing.
                const dupes = e instanceof ApiError ? ((e.details as { duplicates?: { id: string; name: string }[] } | null)?.duplicates) : undefined
                if (dupes?.[0]) {
                  toast.info(`Using the existing company “${dupes[0].name}”`)
                  return { id: dupes[0].id, name: dupes[0].name }
                }
                throw e
              }
              await qc.invalidateQueries({ queryKey: cqk.companies(appId) })
              toast.success(`Company “${c.name}” created`)
              return { id: c.id, name: c.name }
            }
          : undefined
      }
    />
  )
}

// ------------------------------------------------------------------ dialogs

/** Asks why a deal was lost. Resolves with the reason (and note) or nothing when cancelled. */
export function LostReasonDialog({
  appId,
  open,
  dealTitle,
  onCancel,
  onConfirm,
}: {
  appId: string
  open: boolean
  dealTitle?: string
  onCancel: () => void
  onConfirm: (reasonId: string, note: string) => Promise<void> | void
}) {
  const reasons = useLostReasons(appId)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setReason('')
      setNote('')
    }
  }, [open])
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark as lost</DialogTitle>
          <DialogDescription>{dealTitle ? `Why was “${dealTitle}” lost?` : 'Why was this deal lost?'} Reasons feed the win/loss report.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Lost reason" htmlFor="lost-reason">
            <Select id="lost-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Choose a reason…</option>
              {reasons.data
                ?.filter((r) => r.active)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Note (optional)" htmlFor="lost-note">
            <Textarea id="lost-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!reason}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm(reason, note)
              } finally {
                setBusy(false)
              }
            }}
          >
            Mark as lost
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DealFormDialog({
  appId,
  open,
  onOpenChange,
  defaults,
  onCreated,
}: {
  appId: string
  open: boolean
  onOpenChange: (o: boolean) => void
  defaults?: { pipeline_id?: string; stage_id?: string; contact?: Ref | null; company?: Ref | null }
  onCreated?: (id: string) => void
}) {
  const qc = useQueryClient()
  const pipelines = usePipelines(appId)
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [pipelineId, setPipelineId] = useState('')
  const [stageId, setStageId] = useState('')
  const [close, setClose] = useState('')
  const [owner, setOwner] = useState('')
  const [contact, setContact] = useState<Ref | null>(null)
  const [company, setCompany] = useState<Ref | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    setTitle('')
    setAmount('')
    setClose(isoDate(new Date(Date.now() + 30 * 864e5)))
    setOwner('')
    setContact(defaults?.contact ?? null)
    setCompany(defaults?.company ?? null)
    setPipelineId(defaults?.pipeline_id ?? '')
    setStageId(defaults?.stage_id ?? '')
    setErr({})
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const list = pipelines.data ?? []
  const pipeline = list.find((p) => p.id === pipelineId) ?? list.find((p) => p.is_default) ?? list[0]
  const stages = pipeline?.stages.filter((s) => s.kind === 'open') ?? []

  const submit = async () => {
    if (!title.trim()) return setErr({ title: 'Enter a title' })
    setBusy(true)
    try {
      const d = await crmApi(appId).createDeal({
        title: title.trim(),
        amount: amount === '' ? undefined : amount,
        pipeline_id: pipeline?.id,
        stage_id: stageId || undefined,
        expected_close_date: close || undefined,
        owner_id: owner || undefined,
        contact_id: contact?.id,
        company_id: company?.id,
      })
      await qc.invalidateQueries({ queryKey: cqk.all(appId) })
      toast.success('Deal created')
      onOpenChange(false)
      onCreated?.(d.id)
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) setErr(e.fieldErrors())
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New deal</DialogTitle>
          <DialogDescription>Track an opportunity through your pipeline.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Field label="Title" htmlFor="deal-title" error={err.title} className="sm:col-span-2">
            <Input id="deal-title" autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Annual plan for Acme" />
          </Field>
          <Field label={`Amount (${pipeline?.currency ?? 'INR'})`} htmlFor="deal-amount" error={err.amount}>
            <Input id="deal-amount" type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Expected close date" htmlFor="deal-close">
            <Input id="deal-close" type="date" value={close} onChange={(e) => setClose(e.target.value)} />
          </Field>
          <Field label="Pipeline" htmlFor="deal-pipeline">
            <Select
              id="deal-pipeline"
              value={pipeline?.id ?? ''}
              onChange={(e) => {
                setPipelineId(e.target.value)
                setStageId('')
              }}
            >
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Stage" htmlFor="deal-stage">
            <Select id="deal-stage" value={stageId || stages[0]?.id || ''} onChange={(e) => setStageId(e.target.value)}>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.probability}%)
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Contact" htmlFor="deal-contact">
            <ContactPicker appId={appId} id="deal-contact" value={contact} onChange={setContact} />
          </Field>
          <Field label="Company" htmlFor="deal-company">
            <CompanyPicker appId={appId} id="deal-company" value={company} onChange={setCompany} />
          </Field>
          <Field label="Owner" htmlFor="deal-owner" hint="Defaults to you.">
            <OwnerSelect appId={appId} id="deal-owner" value={owner} onChange={setOwner} noneLabel="Me" />
          </Field>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Create deal
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function TaskFormDialog({
  appId,
  open,
  onOpenChange,
  target,
  targetLabel,
}: {
  appId: string
  open: boolean
  onOpenChange: (o: boolean) => void
  target?: { contact_id?: string; deal_id?: string; company_id?: string }
  targetLabel?: string
}) {
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [type, setType] = useState<TaskType>('follow_up')
  const [priority, setPriority] = useState<Priority>('normal')
  const [due, setDue] = useState('')
  const [assignee, setAssignee] = useState('')
  const [notes, setNotes] = useState('')
  const [contact, setContact] = useState<Ref | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    const d = new Date(Date.now() + 864e5)
    d.setHours(10, 0, 0, 0)
    setTitle('')
    setType('follow_up')
    setPriority('normal')
    setDue(toLocalInput(d))
    setAssignee('')
    setNotes('')
    setContact(null)
  }, [open])

  const submit = async () => {
    if (!title.trim()) return
    setBusy(true)
    try {
      await crmApi(appId).createTask({
        title: title.trim(),
        type,
        priority,
        due_at: due ? new Date(due).toISOString() : null,
        assignee_id: assignee || undefined,
        notes: notes || undefined,
        ...(target ?? (contact ? { contact_id: contact.id } : {})),
      })
      await Promise.all([qc.invalidateQueries({ queryKey: cqk.tasks(appId) }), qc.invalidateQueries({ queryKey: cqk.taskSummary(appId) }), qc.invalidateQueries({ queryKey: cqk.contact(appId, target?.contact_id ?? '') })])
      toast.success('Task created')
      onOpenChange(false)
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
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>{targetLabel ? `For ${targetLabel}` : 'A reminder for you or a teammate.'}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <TaskFields
            appId={appId}
            v={{ title, type, priority, due, assignee, notes }}
            set={(p) => {
              if (p.title !== undefined) setTitle(p.title)
              if (p.type) setType(p.type)
              if (p.priority) setPriority(p.priority)
              if (p.due !== undefined) setDue(p.due)
              if (p.assignee !== undefined) setAssignee(p.assignee)
              if (p.notes !== undefined) setNotes(p.notes)
            }}
            idPrefix="task"
          />
          {!target && (
            <Field label="Related contact (optional)" htmlFor="task-contact" className="sm:col-span-2">
              <ContactPicker appId={appId} id="task-contact" value={contact} onChange={setContact} />
            </Field>
          )}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!title.trim()}>
              Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export interface TaskFieldValues {
  title: string
  type: TaskType
  priority: Priority
  due: string
  assignee: string
  notes: string
}

/** Task inputs shared by the dialog and the timeline composer. */
export function TaskFields({ appId, v, set, idPrefix }: { appId: string; v: TaskFieldValues; set: (p: Partial<TaskFieldValues>) => void; idPrefix: string }) {
  return (
    <>
      <Field label="Task" htmlFor={`${idPrefix}-title`} className="sm:col-span-2">
        <Input id={`${idPrefix}-title`} value={v.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} placeholder="Call back about pricing" />
      </Field>
      <Field label="Type" htmlFor={`${idPrefix}-type`}>
        <Select id={`${idPrefix}-type`} value={v.type} onChange={(e) => set({ type: e.target.value as TaskType })}>
          {Object.entries(TASK_TYPE_META).map(([k, m]) => (
            <option key={k} value={k}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Priority" htmlFor={`${idPrefix}-priority`}>
        <Select id={`${idPrefix}-priority`} value={v.priority} onChange={(e) => set({ priority: e.target.value as Priority })}>
          {Object.entries(PRIORITY_META).map(([k, m]) => (
            <option key={k} value={k}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Due" htmlFor={`${idPrefix}-due`}>
        <Input id={`${idPrefix}-due`} type="datetime-local" value={v.due} onChange={(e) => set({ due: e.target.value })} />
      </Field>
      <Field label="Assignee" htmlFor={`${idPrefix}-assignee`}>
        <OwnerSelect appId={appId} id={`${idPrefix}-assignee`} value={v.assignee} onChange={(a) => set({ assignee: a })} noneLabel="Record owner / me" />
      </Field>
      <Field label="Notes (optional)" htmlFor={`${idPrefix}-notes`} className="sm:col-span-2">
        <Textarea id={`${idPrefix}-notes`} rows={2} value={v.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
    </>
  )
}

/** Small section header used inside record pages. */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
      {action}
    </div>
  )
}
