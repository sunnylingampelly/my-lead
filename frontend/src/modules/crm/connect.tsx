/**
 * Cross-module connections between Audience, CRM, campaigns and automation: reachability chips,
 * the quick-action bar on contact / deal / company pages, and the dialogs those actions open
 * (log call, add to list, add tag, enroll in workflow), plus the contact's "Workflows" card.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Briefcase, CheckSquare, ListPlus, Mail, Phone, PhoneCall, Plus, Tag, Workflow } from 'lucide-react'
import { aqk, audienceApi, useLists, useTags } from '@/api/audience'
import { http, errorMessage } from '@/api/client'
import { automationApi } from '@/api/automation'
import { cqk, crmApi } from '@/api/crm'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Channel } from '@/types/audience'
import type { Reach, Ref } from '@/types/crm'
import { DealFormDialog, TaskFormDialog } from './components'
import { CHANNEL_LABEL, campaignUrl, type CampaignChannel } from './links'

// Links and helpers live in ./links (kept out of this file for fast refresh); re-exported for existing callers.
// eslint-disable-next-line react-refresh/only-export-components
export { campaignUrl, CHANNEL_LABEL, reachFromEligibility, workflowUrl, type CampaignChannel } from './links'

// ------------------------------------------------------------------ reachability

/** Per-channel chips: green when the contact can be reached, muted (with a reason) when not. */
export function ReachChips({ reach, reasons, className }: { reach: Reach | null | undefined; reasons?: Partial<Record<Channel, string[]>>; className?: string }) {
  if (!reach) return null
  return (
    <span className={cn('inline-flex flex-wrap gap-1', className)} aria-label="Reachability">
      {(['email', 'sms', 'voice'] as Channel[]).map((ch) => {
        const ok = reach[ch]
        const why = reasons?.[ch]?.[0]
        return (
          <Tooltip key={ch} content={ok ? `Can receive ${CHANNEL_LABEL[ch]} marketing` : why || `No ${CHANNEL_LABEL[ch]} consent or address`}>
            <span
              tabIndex={0}
              data-reach={`${ch}-${ok ? 'yes' : 'no'}`}
              className={cn(
                'inline-flex h-5 items-center rounded px-1.5 text-[10px] font-semibold uppercase ring-1 ring-inset',
                ok ? 'bg-success-soft text-success-strong ring-success-border' : 'bg-muted text-muted-foreground line-through decoration-1 ring-border',
              )}
            >
              {ch === 'voice' ? 'Call' : CHANNEL_LABEL[ch]}
            </span>
          </Tooltip>
        )
      })}
    </span>
  )
}

// ------------------------------------------------------------------ quick actions

export interface QuickContact {
  id: string
  name: string
  email?: string | null
  phone?: string | null
  reach?: Reach | null
  reasons?: Partial<Record<Channel, string[]>>
}

const SEND: { ch: CampaignChannel; label: string; icon: typeof Mail; needs: 'email' | 'phone' }[] = [
  { ch: 'email', label: 'Send email', icon: Mail, needs: 'email' },
  { ch: 'voice', label: 'Call', icon: Phone, needs: 'phone' },
]

/**
 * The action bar for one contact. On deal and company pages pass `dealId` / `companyId` so logged calls,
 * tasks and new deals attach there too. `crm` / `write` hide actions the user can't take.
 */
export function QuickActions({
  appId,
  contact,
  dealId,
  companyId,
  company,
  crm = true,
  write = true,
  className,
  compact,
}: {
  appId: string
  contact: QuickContact
  dealId?: string
  companyId?: string
  company?: Ref | null
  crm?: boolean
  write?: boolean
  className?: string
  compact?: boolean
}) {
  const [dialog, setDialog] = useState<null | 'call' | 'task' | 'deal' | 'list' | 'tag' | 'enroll'>(null)
  const close = () => setDialog(null)
  const target = dealId ? { deal_id: dealId } : companyId ? { contact_id: contact.id, company_id: companyId } : { contact_id: contact.id }
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)} data-testid="quick-actions">
      {SEND.map(({ ch, label, icon: Icon, needs }) => {
        const hasId = needs === 'email' ? !!contact.email : !!contact.phone
        const ok = hasId && (contact.reach ? contact.reach[ch] : true)
        const reason = !hasId ? (needs === 'email' ? 'No email address' : 'No phone number') : (contact.reasons?.[ch]?.[0] ?? `No ${CHANNEL_LABEL[ch]} consent`)
        return ok ? (
          <Button key={ch} asChild size="sm" variant="outline">
            <Link to={campaignUrl(appId, ch, { contact_ids: [contact.id] })}>
              <Icon /> {compact ? null : label}
              {compact && <span className="sr-only">{label}</span>}
            </Link>
          </Button>
        ) : (
          <span key={ch} className="inline-flex items-center gap-1">
            <Button size="sm" variant="outline" disabled aria-describedby={`why-${ch}-${contact.id}`}>
              <Icon /> {compact ? <span className="sr-only">{label}</span> : label}
            </Button>
            <Badge variant="secondary" id={`why-${ch}-${contact.id}`} className="max-w-[11rem] truncate text-[10px]" title={reason}>
              {reason}
            </Badge>
          </span>
        )
      })}
      {crm && write && (
        <>
          <Button size="sm" variant="outline" onClick={() => setDialog('call')}>
            <PhoneCall /> Log call
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('task')}>
            <CheckSquare /> Add task
          </Button>
          {!dealId && (
            <Button size="sm" variant="outline" onClick={() => setDialog('deal')}>
              <Briefcase /> Create deal
            </Button>
          )}
        </>
      )}
      {write && (
        <>
          <Button size="sm" variant="outline" onClick={() => setDialog('list')}>
            <ListPlus /> Add to list
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('tag')}>
            <Tag /> Add tag
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('enroll')}>
            <Workflow /> Enroll in workflow
          </Button>
        </>
      )}
      <LogCallDialog appId={appId} open={dialog === 'call'} onOpenChange={(o) => !o && close()} target={target} who={contact.name} />
      <TaskFormDialog appId={appId} open={dialog === 'task'} onOpenChange={(o) => !o && close()} target={target} targetLabel={contact.name} />
      <DealFormDialog appId={appId} open={dialog === 'deal'} onOpenChange={(o) => !o && close()} defaults={{ contact: { id: contact.id, name: contact.name }, company: company ?? null }} />
      <AddToListDialog appId={appId} open={dialog === 'list'} onOpenChange={(o) => !o && close()} contactIds={[contact.id]} who={contact.name} />
      <AddTagDialog appId={appId} open={dialog === 'tag'} onOpenChange={(o) => !o && close()} contactIds={[contact.id]} who={contact.name} />
      <EnrollDialog appId={appId} open={dialog === 'enroll'} onOpenChange={(o) => !o && close()} audience={{ contact_ids: [contact.id] }} who={contact.name} />
    </div>
  )
}

// ------------------------------------------------------------------ dialogs

export function LogCallDialog({
  appId,
  open,
  onOpenChange,
  target,
  who,
}: {
  appId: string
  open: boolean
  onOpenChange: (o: boolean) => void
  target: { contact_id?: string; deal_id?: string; company_id?: string }
  who?: string
}) {
  const qc = useQueryClient()
  const [subject, setSubject] = useState('')
  const [outcome, setOutcome] = useState('connected')
  const [minutes, setMinutes] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setSubject(who ? `Call with ${who}` : 'Call')
      setOutcome('connected')
      setMinutes('')
      setBody('')
    }
  }, [open, who])
  const submit = async () => {
    setBusy(true)
    try {
      await crmApi(appId).logActivity({ type: 'call', subject: subject.trim() || 'Call', outcome, duration_minutes: minutes ? Number(minutes) : null, body: body || null, ...target })
      await qc.invalidateQueries({ queryKey: cqk.all(appId) })
      toast.success('Call logged')
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
          <DialogTitle>Log a call</DialogTitle>
          <DialogDescription>{who ? `With ${who}. ` : ''}Logging a call counts as the first response.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Field label="Subject" htmlFor="call-subject" className="sm:col-span-2">
            <Input id="call-subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Outcome" htmlFor="call-outcome">
            <Select id="call-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="connected">Connected</option>
              <option value="left_voicemail">Left voicemail</option>
              <option value="no_answer">No answer</option>
              <option value="busy">Busy</option>
              <option value="wrong_number">Wrong number</option>
            </Select>
          </Field>
          <Field label="Duration (minutes)" htmlFor="call-minutes">
            <Input id="call-minutes" type="number" min={0} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </Field>
          <Field label="Notes (optional)" htmlFor="call-notes" className="sm:col-span-2">
            <Textarea id="call-notes" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Log call
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AddToListDialog({ appId, open, onOpenChange, contactIds, who }: { appId: string; open: boolean; onOpenChange: (o: boolean) => void; contactIds: string[]; who?: string }) {
  const qc = useQueryClient()
  const lists = useLists(appId)
  const [listId, setListId] = useState('')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setListId('')
      setNewName('')
    }
  }, [open])
  const creating = listId === '__new'
  const submit = async () => {
    setBusy(true)
    try {
      const api = audienceApi(appId)
      const id = creating ? (await api.createList({ name: newName.trim() })).id : listId
      const r = await api.addToList(id, contactIds)
      await qc.invalidateQueries({ queryKey: aqk.all(appId) })
      toast.success(r.added ? `Added to list` : 'Already on that list')
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
          <DialogTitle>Add to list</DialogTitle>
          <DialogDescription>{who ? `Add ${who} to a static list.` : `Add ${contactIds.length} contact(s) to a static list.`}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="List" htmlFor="atl-list">
            <Select id="atl-list" value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">Choose a list…</option>
              {lists.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
              <option value="__new">+ New list…</option>
            </Select>
          </Field>
          {creating && (
            <Field label="New list name" htmlFor="atl-new">
              <Input id="atl-new" autoFocus value={newName} maxLength={120} onChange={(e) => setNewName(e.target.value)} />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!listId || (creating && !newName.trim())} onClick={() => void submit()}>
            Add to list
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AddTagDialog({ appId, open, onOpenChange, contactIds, who }: { appId: string; open: boolean; onOpenChange: (o: boolean) => void; contactIds: string[]; who?: string }) {
  const qc = useQueryClient()
  const tags = useTags(appId)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setQ('')
  }, [open])
  const matches = (tags.data ?? []).filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase()))
  const exact = (tags.data ?? []).some((t) => t.name.toLowerCase() === q.trim().toLowerCase())
  const apply = async (tagId: string | null) => {
    setBusy(true)
    try {
      const api = audienceApi(appId)
      const id = tagId ?? (await api.createTag({ name: q.trim() })).id
      await api.bulk({ action: 'add_tag', contact_ids: contactIds, tag_id: id })
      await qc.invalidateQueries({ queryKey: aqk.all(appId) })
      toast.success('Tag added')
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
          <DialogTitle>Add tag</DialogTitle>
          <DialogDescription>{who ? `Tag ${who}.` : `Tag ${contactIds.length} contact(s).`} Type to find a tag or create a new one.</DialogDescription>
        </DialogHeader>
        <Field label="Tag" htmlFor="atg-q">
          <Input id="atg-q" autoFocus value={q} maxLength={60} onChange={(e) => setQ(e.target.value)} placeholder="e.g. VIP" />
        </Field>
        <div className="max-h-56 space-y-0.5 overflow-y-auto" role="listbox" aria-label="Tags">
          {matches.map((t) => (
            <button key={t.id} type="button" role="option" aria-selected={false} disabled={busy} onClick={() => void apply(t.id)} className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-muted">
              {t.name}
            </button>
          ))}
          {q.trim() && !exact && (
            <button type="button" role="option" aria-selected={false} disabled={busy} onClick={() => void apply(null)} className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm font-medium text-primary hover:bg-muted">
              <Plus className="size-3.5" /> Create tag “{q.trim()}”
            </button>
          )}
          {!q.trim() && !matches.length && <p className="px-2 py-1.5 text-sm text-muted-foreground">No tags yet. Type a name to create one.</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** C1: enroll contacts, a list or a segment into an active workflow. */
export function EnrollDialog({
  appId,
  open,
  onOpenChange,
  audience,
  who,
}: {
  appId: string
  open: boolean
  onOpenChange: (o: boolean) => void
  audience: { contact_ids?: string[]; list_id?: string; segment_id?: string }
  who?: string
}) {
  const qc = useQueryClient()
  const wfs = useQuery({
    queryKey: ['automation', appId, 'active-workflows'],
    queryFn: () => automationApi(appId).list({ page: 1, page_size: 100, status: 'active' }),
    enabled: open,
  })
  const [wf, setWf] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setWf('')
  }, [open])
  const active = (wfs.data?.items ?? []).filter((w) => w.status === 'active')
  const submit = async () => {
    setBusy(true)
    try {
      const r = await http.post<{ enrolled: number; skipped: number }>(`/apps/${appId}/automation/workflows/${wf}/enroll`, audience)
      await qc.invalidateQueries({ queryKey: ['automation', appId] })
      toast.success(`Enrolled ${r.data.enrolled}${r.data.skipped ? `, skipped ${r.data.skipped} (already in it or not eligible)` : ''}`)
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
          <DialogTitle>Enroll in a workflow</DialogTitle>
          <DialogDescription>{who ? `Start ${who} on an active workflow.` : 'Start these contacts on an active workflow.'}</DialogDescription>
        </DialogHeader>
        {wfs.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading workflows…</p>
        ) : active.length ? (
          <Field label="Workflow" htmlFor="enroll-wf">
            <Select id="enroll-wf" value={wf} onChange={(e) => setWf(e.target.value)}>
              <option value="">Choose a workflow…</option>
              {active.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-sm text-muted-foreground">
            No active workflows yet.{' '}
            <Link className="font-medium text-primary underline-offset-4 hover:underline" to={`/apps/${appId}/automation`}>
              Create or activate one
            </Link>{' '}
            first.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!wf} onClick={() => void submit()}>
            Enroll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ------------------------------------------------------------------ workflows card (C2)

interface ContactRun {
  run_id: string
  workflow_id: string
  workflow_name: string
  status: string
  current_step: string | null
  started_at: string
  finished_at: string | null
  exit_reason: string | null
}

/** Workflows a contact (or a deal's people) is or was in. */
export function WorkflowsCard({ appId, contactIds, className }: { appId: string; contactIds: string[]; className?: string }) {
  const ids = contactIds.filter(Boolean)
  const runs = useQuery({
    queryKey: ['automation', appId, 'contact-runs', ids],
    queryFn: async () => {
      const all = await Promise.all(ids.map((id) => http.get<ContactRun[]>(`/apps/${appId}/automation/runs`, { params: { contact_id: id } }).then((r) => r.data)))
      return all.flat().sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))
    },
    enabled: ids.length > 0,
    retry: false,
  })
  return (
    <div className={cn('rounded-lg border bg-card p-4', className)} data-testid="workflows-card">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Workflows</h3>
      {!ids.length ? (
        <p className="text-sm text-muted-foreground">No people linked yet.</p>
      ) : runs.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : runs.isError ? (
        <p className="text-sm text-muted-foreground">Workflow history isn’t available right now.</p>
      ) : !runs.data?.length ? (
        <p className="text-sm text-muted-foreground">Not in any workflow yet. Use “Enroll in workflow” to start one.</p>
      ) : (
        <ul className="space-y-2">
          {runs.data.slice(0, 8).map((r) => (
            <li key={r.run_id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <Link to={`/apps/${appId}/automation/${r.workflow_id}`} className="min-w-0 truncate font-medium hover:underline">
                {r.workflow_name}
              </Link>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {r.current_step && r.status === 'active' ? <span className="truncate">at {r.current_step}</span> : r.exit_reason ? <span className="truncate">{r.exit_reason.replace(/_/g, ' ')}</span> : null}
                <Badge variant={r.status === 'active' || r.status === 'waiting' ? 'default' : r.status === 'completed' ? 'success' : 'secondary'}>{r.status}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
