import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, Circle, Clock, FlaskConical, GitBranch, Search, Send, TriangleAlert, Flag } from 'lucide-react'
import { useContacts, useLists, useSegments } from '@/api/audience'
import { automationApi, type TestResult, type Workflow, wqk } from '@/api/automation'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Checkbox } from '@/components/audience'
import { cn } from '@/lib/utils'

function useDebounced(value: string, ms = 250) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Search contacts by name, email or phone. */
function ContactSearch({ appId, selected, onToggle, multiple }: { appId: string; selected: string[]; onToggle: (id: string, name: string) => void; multiple?: boolean }) {
  const [q, setQ] = useState('')
  const search = useDebounced(q)
  const contacts = useContacts(appId, { page: 1, page_size: 8, search: search || undefined })
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-8" autoFocus placeholder="Search by name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" />
      </div>
      <ul className="max-h-64 divide-y overflow-y-auto rounded-md border" data-testid="contact-results">
        {contacts.data?.items.map((c) => {
          const on = selected.includes(c.id)
          const name = c.full_name || c.email || c.phone_display || c.phone || 'Contact'
          return (
            <li key={c.id}>
              <button type="button" onClick={() => onToggle(c.id, name)} className={cn('flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/60', on && 'bg-primary/10')}>
                {multiple ? <Checkbox checked={on} readOnly aria-label={`Select ${name}`} tabIndex={-1} /> : <Circle className={cn('size-4', on ? 'fill-primary text-primary' : 'text-muted-foreground')} />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{[c.email, c.phone_display ?? c.phone].filter(Boolean).join(' · ')}</span>
                </span>
              </button>
            </li>
          )
        })}
        {contacts.data?.items.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted-foreground">No contacts match.</li>}
      </ul>
    </div>
  )
}

const OUTCOME: Record<string, { icon: typeof Circle; tone: string }> = {
  trigger: { icon: Flag, tone: 'text-amber-600' },
  would_send: { icon: Send, tone: 'text-primary' },
  would_skip: { icon: TriangleAlert, tone: 'text-warning-strong' },
  would_do: { icon: CheckCircle2, tone: 'text-success-strong' },
  wait: { icon: Clock, tone: 'text-muted-foreground' },
  branch_yes: { icon: GitBranch, tone: 'text-success-strong' },
  branch_no: { icon: GitBranch, tone: 'text-destructive' },
  branch_a: { icon: GitBranch, tone: 'text-primary' },
  end: { icon: Flag, tone: 'text-muted-foreground' },
  problem: { icon: TriangleAlert, tone: 'text-destructive' },
}

export function TestDialog({ open, onOpenChange, workflow, appId, onSelectStep, beforeRun }: { open: boolean; onOpenChange: (o: boolean) => void; workflow: Workflow; appId: string; onSelectStep: (nodeId: string) => void; beforeRun: () => Promise<void> }) {
  const [contact, setContact] = useState<{ id: string; name: string } | null>(null)
  const [graph, setGraph] = useState<'draft' | 'published'>('draft')
  const [result, setResult] = useState<TestResult | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) {
      setResult(null)
      setContact(null)
    }
  }, [open])
  const run = async () => {
    if (!contact) return
    setBusy(true)
    try {
      await beforeRun()
      setResult(await automationApi(appId).test(workflow.id, contact.id, graph))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="test-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="size-4" /> Test with a contact
          </DialogTitle>
          <DialogDescription>See the path this person would take and what each step would do. Nothing is sent and they are not enrolled.</DialogDescription>
        </DialogHeader>
        {!result ? (
          <div className="space-y-3">
            <ContactSearch appId={appId} selected={contact ? [contact.id] : []} onToggle={(id, name) => setContact({ id, name })} />
            {workflow.version > 0 && workflow.has_unpublished_changes && (
              <Field label="Version" htmlFor="test-graph">
                <Select id="test-graph" value={graph} onChange={(e) => setGraph(e.target.value as 'draft' | 'published')}>
                  <option value="draft">Your edits (draft)</option>
                  <option value="published">Live version {workflow.version}</option>
                </Select>
              </Field>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              Path for <strong>{result.contact}</strong> ({result.graph === 'draft' ? 'your edits' : 'live version'}):
            </p>
            <ol className="relative space-y-3 border-l pl-5" data-testid="test-steps">
              {result.steps.map((s, i) => {
                const m = OUTCOME[s.outcome] ?? OUTCOME.would_do!
                const Icon = m.icon
                return (
                  <li key={i} className="relative">
                    <Icon className={cn('absolute -left-[27px] top-0.5 size-4 bg-card', m.tone)} />
                    {s.node_id ? (
                      <button
                        type="button"
                        className="text-left text-sm font-medium hover:text-primary hover:underline"
                        onClick={() => {
                          onSelectStep(s.node_id!)
                          onOpenChange(false)
                        }}
                      >
                        {s.label}
                      </button>
                    ) : (
                      <div className="text-sm font-medium">{s.label}</div>
                    )}
                    <div className="text-xs text-muted-foreground">{s.detail}</div>
                  </li>
                )
              })}
            </ol>
          </div>
        )}
        <DialogFooter>
          {result ? (
            <Button variant="outline" onClick={() => setResult(null)}>
              Test someone else
            </Button>
          ) : (
            <Button onClick={run} disabled={!contact} loading={busy} data-testid="run-test">
              <FlaskConical /> Run test{contact ? ` for ${contact.name}` : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function EnrollDialog({ open, onOpenChange, workflow, appId }: { open: boolean; onOpenChange: (o: boolean) => void; workflow: Workflow; appId: string }) {
  const qc = useQueryClient()
  const lists = useLists(appId)
  const segments = useSegments(appId)
  const [mode, setMode] = useState<'contacts' | 'list' | 'segment'>('contacts')
  const [picked, setPicked] = useState<{ id: string; name: string }[]>([])
  const [listId, setListId] = useState('')
  const [segmentId, setSegmentId] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) {
      setPicked([])
      setListId('')
      setSegmentId('')
    }
  }, [open])
  const ready = mode === 'contacts' ? picked.length > 0 : mode === 'list' ? !!listId : !!segmentId
  const submit = async () => {
    setBusy(true)
    try {
      const body = mode === 'contacts' ? { contact_ids: picked.map((p) => p.id) } : mode === 'list' ? { list_id: listId } : { segment_id: segmentId }
      const r = await automationApi(appId).enroll(workflow.id, body)
      await qc.invalidateQueries({ queryKey: wqk.all(appId) })
      if (r.enrolled) toast.success(`${r.enrolled} enrolled${r.skipped ? `, ${r.skipped} skipped` : ''}`, { description: r.skipped ? r.message : undefined })
      else toast.info(`No one new was enrolled (${r.skipped} skipped)`, { description: r.message })
      onOpenChange(false)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="enroll-dialog">
        <DialogHeader>
          <DialogTitle>Enroll contacts</DialogTitle>
          <DialogDescription>
            They start the journey now, from the first step. People already on it are skipped
            {workflow.allow_reentry ? '.' : ', and so is anyone who went through it before (re-entry is off).'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex rounded-lg border p-0.5 text-sm" role="tablist" aria-label="Who to enroll">
          {(['contacts', 'list', 'segment'] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} type="button" onClick={() => setMode(m)} className={cn('flex-1 rounded-md px-3 py-1 font-medium', mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
              {m === 'contacts' ? 'Contacts' : m === 'list' ? 'A list' : 'A segment'}
            </button>
          ))}
        </div>
        {mode === 'contacts' && (
          <>
            <ContactSearch appId={appId} multiple selected={picked.map((p) => p.id)} onToggle={(id, name) => setPicked((ps) => (ps.some((p) => p.id === id) ? ps.filter((p) => p.id !== id) : [...ps, { id, name }]))} />
            {picked.length > 0 && <p className="text-xs text-muted-foreground">Selected: {picked.map((p) => p.name).join(', ')}</p>}
          </>
        )}
        {mode === 'list' && (
          <Field label="List" htmlFor="enroll-list">
            <Select id="enroll-list" value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">Choose…</option>
              {lists.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {mode === 'segment' && (
          <Field label="Segment" htmlFor="enroll-segment">
            <Select id="enroll-segment" value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
              <option value="">Choose…</option>
              {segments.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <DialogFooter>
          <Button onClick={submit} disabled={!ready} loading={busy} data-testid="enroll-submit">
            Enroll{mode === 'contacts' && picked.length ? ` ${picked.length}` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SettingsDialog({ open, onOpenChange, workflow, appId, readOnly, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; workflow: Workflow; appId: string; readOnly: boolean; onSaved: (w: Workflow) => void }) {
  const [name, setName] = useState(workflow.name)
  const [description, setDescription] = useState(workflow.description ?? '')
  const [reentry, setReentry] = useState(workflow.allow_reentry)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setName(workflow.name)
      setDescription(workflow.description ?? '')
      setReentry(workflow.allow_reentry)
    }
  }, [open, workflow])
  const save = async () => {
    setBusy(true)
    try {
      const w = await automationApi(appId).update(workflow.id, { name: name.trim(), description: description.trim() || null, allow_reentry: reentry })
      onSaved(w)
      toast.success('Settings saved')
      onOpenChange(false)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="settings-dialog">
        <DialogHeader>
          <DialogTitle>Workflow settings</DialogTitle>
          <DialogDescription>Name, description and who can go through the journey again.</DialogDescription>
        </DialogHeader>
        <fieldset disabled={readOnly} className="space-y-4">
          <Field label="Name" htmlFor="wf-name">
            <Input id="wf-name" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description (optional)" htmlFor="wf-desc">
            <Textarea id="wf-desc" value={description} maxLength={500} rows={3} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
            <Checkbox checked={reentry} onChange={(e) => setReentry(e.target.checked)} aria-label="Allow re-entry" />
            <span>
              <span className="font-medium">Allow re-entry</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Off: each contact goes through this workflow once, ever. On: they can start again each time the trigger happens (for example, every time they’re tagged), but never while they are still on the journey. Message steps still reach a person at most once per step.
              </span>
            </span>
          </label>
        </fieldset>
        <DialogFooter>
          <Button onClick={save} loading={busy} disabled={readOnly || !name.trim()} data-testid="settings-save">
            Save settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
