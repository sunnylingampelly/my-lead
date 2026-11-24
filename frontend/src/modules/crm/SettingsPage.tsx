import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, Lock, Pencil, Plus, RefreshCw, Star, Trash2, X } from 'lucide-react'
import { useAttributes, useSegments } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { cqk, crmApi, useAssignmentRules, useCrmSettings, useCrmTeam, useLostReasons, usePipelines, useScoringRules } from '@/api/crm'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { ALL_COUNTRIES } from '@/lib/regions'
import type { AssignmentRule, AssignmentRuleInput, Pipeline, ScoringEvent, ScoringOperator, ScoringRuleInput, StageInput, StageKind } from '@/types/crm'
import { FIT_FIELD_LABEL, LIFECYCLE_LABEL, LIFECYCLES } from './format'

const useInvalidate = (appId: string) => {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: cqk.all(appId) })
}

async function attempt(fn: () => Promise<unknown>, ok: string) {
  try {
    await fn()
    toast.success(ok)
    return true
  } catch (e) {
    toast.error(errorMessage(e))
    return false
  }
}

// ------------------------------------------------------------------ pipelines

function PipelinesTab({ appId, manage }: { appId: string; manage: boolean }) {
  const q = usePipelines(appId, true)
  const invalidate = useInvalidate(appId)
  const [selected, setSelected] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const p = q.data?.find((x) => x.id === selected) ?? q.data?.find((x) => x.is_default) ?? q.data?.[0]
  if (q.isLoading) return <LoadingRows />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  return (
    <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
      <div className="space-y-1">
        {q.data!.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => setSelected(x.id)}
            className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${x.id === p?.id ? 'bg-muted font-medium' : 'hover:bg-muted/60'}`}
          >
            <span className={x.archived ? 'text-muted-foreground line-through' : ''}>{x.name}</span>
            {x.is_default && <Star className="size-3.5 fill-amber-400 text-amber-500" aria-label="Default" />}
          </button>
        ))}
        {manage &&
          (creating ? (
            <form
              className="space-y-2 pt-2"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!newName.trim()) return
                const ok = await attempt(async () => {
                  const created = await crmApi(appId).createPipeline({ name: newName.trim() })
                  setSelected(created.id)
                }, 'Pipeline created')
                if (ok) {
                  setCreating(false)
                  setNewName('')
                  void invalidate()
                }
              }}
            >
              <Input autoFocus aria-label="New pipeline name" placeholder="Pipeline name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <div className="flex gap-2">
                <Button size="sm" type="submit">
                  Create
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setCreating(true)}>
              <Plus /> New pipeline
            </Button>
          ))}
      </div>
      {p && <PipelineEditor key={p.id + p.stages.map((s) => s.id).join()} appId={appId} p={p} manage={manage} />}
    </div>
  )
}

function PipelineEditor({ appId, p, manage }: { appId: string; p: Pipeline; manage: boolean }) {
  const invalidate = useInvalidate(appId)
  const [name, setName] = useState(p.name)
  const [stages, setStages] = useState<StageInput[]>(() => p.stages.map((s) => ({ id: s.id, name: s.name, probability: s.probability, kind: s.kind, rotting_days: s.rotting_days })))
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(false)
  const update = (i: number, patch: Partial<StageInput>) => setStages((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const moveStage = (i: number, d: number) =>
    setStages((ss) => {
      const next = [...ss]
      const [x] = next.splice(i, 1)
      next.splice(i + d, 0, x!)
      return next
    })
  const dirty = name !== p.name || JSON.stringify(stages) !== JSON.stringify(p.stages.map((s) => ({ id: s.id, name: s.name, probability: s.probability, kind: s.kind, rotting_days: s.rotting_days })))

  const save = async () => {
    setBusy(true)
    const ok = await attempt(
      () =>
        crmApi(appId).updatePipeline(p.id, {
          name: name.trim(),
          stages: stages.map((s) => ({ ...s, name: s.name.trim(), probability: Number(s.probability) || 0, rotting_days: s.rotting_days ? Number(s.rotting_days) : null })),
        }),
      'Pipeline saved',
    )
    setBusy(false)
    if (ok) void invalidate()
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex-1 space-y-1">
          <Field label="Pipeline name" htmlFor="pl-name">
            <Input id="pl-name" value={name} disabled={!manage} onChange={(e) => setName(e.target.value)} className="max-w-sm" />
          </Field>
          <p className="text-xs text-muted-foreground">
            Currency {p.currency}
            {p.is_default && ' · Default pipeline'}
            {p.archived && ' · Archived'}
          </p>
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2">
            {!p.is_default && !p.archived && (
              <Button size="sm" variant="outline" onClick={async () => (await attempt(() => crmApi(appId).updatePipeline(p.id, { is_default: true }), 'Default pipeline set')) && invalidate()}>
                <Star /> Make default
              </Button>
            )}
            {!p.is_default && (
              <Button size="sm" variant="outline" onClick={async () => (await attempt(() => crmApi(appId).updatePipeline(p.id, { archived: !p.archived }), p.archived ? 'Pipeline restored' : 'Pipeline archived')) && invalidate()}>
                {p.archived ? 'Restore' : 'Archive'}
              </Button>
            )}
            {!p.is_default && (
              <Button size="sm" variant="ghost" aria-label="Delete pipeline" onClick={() => setDel(true)}>
                <Trash2 />
              </Button>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        {/* Below sm each stage is a card; from sm up it's a table-like grid. */}
        <div className="space-y-2" role="table" aria-label="Pipeline stages">
          <div role="row" className="hidden gap-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid sm:grid-cols-[4rem_minmax(8rem,1fr)_6.5rem_7rem_8.5rem_2rem]">
            <span role="columnheader">Order</span>
            <span role="columnheader">Stage</span>
            <span role="columnheader">Probability %</span>
            <span role="columnheader">Kind</span>
            <span role="columnheader" title="Deals with no activity for this many days are flagged as going cold">Days until &lsquo;going cold&rsquo;</span>
            <span role="columnheader" />
          </div>
          {stages.map((s, i) => (
            <div
              role="row"
              key={s.id ?? `new-${i}`}
              data-testid="stage-row"
              className="grid grid-cols-2 items-end gap-2 rounded-lg border p-3 sm:grid-cols-[4rem_minmax(8rem,1fr)_6.5rem_7rem_8.5rem_2rem] sm:items-center sm:rounded-none sm:border-0 sm:border-t sm:p-1 sm:pt-2"
            >
              <div role="cell" className="order-2 flex gap-0.5 sm:order-none">
                <button type="button" disabled={!manage || i === 0} onClick={() => moveStage(i, -1)} className="rounded p-1 hover:bg-muted disabled:opacity-30" aria-label={`Move ${s.name} up`}>
                  <ArrowUp className="size-3.5" />
                </button>
                <button type="button" disabled={!manage || i === stages.length - 1} onClick={() => moveStage(i, 1)} className="rounded p-1 hover:bg-muted disabled:opacity-30" aria-label={`Move ${s.name} down`}>
                  <ArrowDown className="size-3.5" />
                </button>
              </div>
              <div role="cell" className="order-1 col-span-2 sm:order-none sm:col-span-1">
                <span className="mb-1 block text-xs text-muted-foreground sm:hidden">Stage</span>
                <Input aria-label="Stage name" value={s.name} disabled={!manage} maxLength={80} onChange={(e) => update(i, { name: e.target.value })} />
              </div>
              <div role="cell" className="order-3 sm:order-none">
                <span className="mb-1 block text-xs text-muted-foreground sm:hidden">Probability %</span>
                <Input aria-label="Probability" type="number" min={0} max={100} value={s.probability} disabled={!manage} onChange={(e) => update(i, { probability: Number(e.target.value) })} />
              </div>
              <div role="cell" className="order-4 sm:order-none">
                <span className="mb-1 block text-xs text-muted-foreground sm:hidden">Kind</span>
                <Select aria-label="Kind" value={s.kind} disabled={!manage} onChange={(e) => update(i, { kind: e.target.value as StageKind })}>
                  <option value="open">Open</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                </Select>
              </div>
              <div role="cell" className="order-5 sm:order-none">
                <span className="mb-1 block text-xs text-muted-foreground sm:hidden">Days until &lsquo;going cold&rsquo;</span>
                <Input aria-label="Days until going cold" type="number" min={1} max={365} placeholder="—" value={s.rotting_days ?? ''} disabled={!manage || s.kind !== 'open'} onChange={(e) => update(i, { rotting_days: e.target.value ? Number(e.target.value) : null })} />
              </div>
              <div role="cell" className="order-2 flex justify-end sm:order-none">
                {manage && (
                  <button type="button" onClick={() => setStages((ss) => ss.filter((_, j) => j !== i))} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label={`Remove ${s.name}`}>
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Each pipeline needs one Won and one Lost stage. Deals with no activity for the “days until going cold” are flagged as going cold. Leave it empty for stages that never go cold.</p>
      </CardContent>
      {manage && (
        <CardFooter className="justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const at = stages.findIndex((s) => s.kind !== 'open')
              const next = [...stages]
              next.splice(at < 0 ? next.length : at, 0, { name: 'New stage', probability: 50, kind: 'open', rotting_days: 14 })
              setStages(next)
            }}
          >
            <Plus /> Add stage
          </Button>
          <Button size="sm" loading={busy} disabled={!dirty} onClick={() => void save()}>
            Save pipeline
          </Button>
        </CardFooter>
      )}
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title={`Delete ${p.name}?`}
        description="Only pipelines without deals can be deleted. Archive it instead to keep history."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          setDel(false)
          if (await attempt(() => crmApi(appId).deletePipeline(p.id), 'Pipeline deleted')) void invalidate()
        }}
      />
    </Card>
  )
}

// ------------------------------------------------------------------ lost reasons

function LostReasonsTab({ appId, manage }: { appId: string; manage: boolean }) {
  const q = useLostReasons(appId)
  const invalidate = useInvalidate(appId)
  const [name, setName] = useState('')
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Lost reasons</CardTitle>
        <CardDescription>Asked when a deal is marked lost. Inactive reasons stay on old deals but can't be chosen.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.data?.map((r) => (
          <div key={r.id} className="flex items-center gap-2">
            <Input
              aria-label="Reason name"
              defaultValue={r.name}
              disabled={!manage}
              onBlur={async (e) => {
                const v = e.target.value.trim()
                if (v && v !== r.name && (await attempt(() => crmApi(appId).updateLostReason(r.id, { name: v, active: r.active }), 'Reason renamed'))) void invalidate()
              }}
            />
            <label className="flex shrink-0 items-center gap-1.5 text-sm">
              <Checkbox
                checked={r.active}
                disabled={!manage}
                onChange={async (e) => (await attempt(() => crmApi(appId).updateLostReason(r.id, { name: r.name, active: e.target.checked }), e.target.checked ? 'Reason enabled' : 'Reason disabled')) && invalidate()}
              />
              Active
            </label>
          </div>
        ))}
        {manage && (
          <form
            className="flex gap-2 pt-2"
            onSubmit={async (e) => {
              e.preventDefault()
              if (name.trim() && (await attempt(() => crmApi(appId).createLostReason({ name: name.trim() }), 'Reason added'))) {
                setName('')
                void invalidate()
              }
            }}
          >
            <Input aria-label="New lost reason" placeholder="Add a reason" value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" variant="outline" disabled={!name.trim()}>
              <Plus /> Add
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ assignment rules

const COND_LABEL: Record<string, string> = { source: 'Source', country: 'Country', state: 'State', city: 'City', lifecycle_stage: 'Lifecycle stage', segment_id: 'Segment' }

function RuleDialog({ appId, rule, open, onOpenChange }: { appId: string; rule: AssignmentRule | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const team = useCrmTeam(appId)
  const segments = useSegments(appId)
  const invalidate = useInvalidate(appId)
  const [v, setV] = useState<AssignmentRuleInput>({ name: '', active: true, conditions: {}, user_ids: [], max_open_per_user: null })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setV(rule ? { name: rule.name, active: rule.active, conditions: { ...rule.conditions }, user_ids: [...rule.user_ids], max_open_per_user: rule.max_open_per_user } : { name: '', active: true, conditions: {}, user_ids: [], max_open_per_user: null })
  }, [open, rule])
  const cond = (k: keyof AssignmentRuleInput['conditions'], val: string) => setV((x) => ({ ...x, conditions: { ...x.conditions, [k]: val } }))
  const c = v.conditions
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit assignment rule' : 'New assignment rule'}</DialogTitle>
          <DialogDescription>New contacts matching every condition are shared round-robin between the people you pick. Rules run top to bottom; the first match wins.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            const body = { ...v, name: v.name.trim(), conditions: Object.fromEntries(Object.entries(v.conditions).filter(([, x]) => x)) }
            const ok = await attempt(() => (rule ? crmApi(appId).updateAssignmentRule(rule.id, body) : crmApi(appId).createAssignmentRule(body)), 'Rule saved')
            setBusy(false)
            if (ok) {
              void invalidate()
              onOpenChange(false)
            }
          }}
        >
          <Field label="Rule name" htmlFor="ar-name" className="sm:col-span-2">
            <Input id="ar-name" value={v.name} maxLength={120} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Website leads in Maharashtra" />
          </Field>
          <Field label="Source" htmlFor="ar-source">
            <Input id="ar-source" value={c.source ?? ''} onChange={(e) => cond('source', e.target.value)} placeholder="Any" />
          </Field>
          <Field label="Country" htmlFor="ar-country">
            <Select id="ar-country" value={c.country ?? ''} onChange={(e) => cond('country', e.target.value)}>
              <option value="">Any</option>
              {ALL_COUNTRIES.map((x) => (
                <option key={x.code} value={x.code}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="State" htmlFor="ar-state">
            <Input id="ar-state" value={c.state ?? ''} onChange={(e) => cond('state', e.target.value)} placeholder="Any" />
          </Field>
          <Field label="City" htmlFor="ar-city">
            <Input id="ar-city" value={c.city ?? ''} onChange={(e) => cond('city', e.target.value)} placeholder="Any" />
          </Field>
          <Field label="Lifecycle stage" htmlFor="ar-life">
            <Select id="ar-life" value={c.lifecycle_stage ?? ''} onChange={(e) => cond('lifecycle_stage', e.target.value)}>
              <option value="">Any</option>
              {LIFECYCLES.map((l) => (
                <option key={l} value={l}>
                  {LIFECYCLE_LABEL[l]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Segment" htmlFor="ar-seg">
            <Select id="ar-seg" value={c.segment_id ?? ''} onChange={(e) => cond('segment_id', e.target.value)}>
              <option value="">Any</option>
              {segments.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1.5 text-sm font-medium">Rotate between</legend>
            <div className="grid gap-1.5 rounded-md border p-3 sm:grid-cols-2">
              {team.data?.map((u) => (
                <label key={u.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={v.user_ids.includes(u.id)}
                    onChange={(e) => setV({ ...v, user_ids: e.target.checked ? [...v.user_ids, u.id] : v.user_ids.filter((x) => x !== u.id) })}
                  />
                  {u.full_name}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Max open leads per person" htmlFor="ar-max" hint="Skip people at this limit. Empty for no limit.">
            <Input id="ar-max" type="number" min={1} value={v.max_open_per_user ?? ''} onChange={(e) => setV({ ...v, max_open_per_user: e.target.value ? Number(e.target.value) : null })} />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <Checkbox checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /> Active
          </label>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!v.name.trim() || v.user_ids.length === 0}>
              Save rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AssignmentTab({ appId, manage }: { appId: string; manage: boolean }) {
  const q = useAssignmentRules(appId)
  const team = useCrmTeam(appId)
  const segments = useSegments(appId)
  const invalidate = useInvalidate(appId)
  const [editing, setEditing] = useState<AssignmentRule | null>(null)
  const [open, setOpen] = useState(false)
  const names = (ids: string[]) => ids.map((id) => team.data?.find((u) => u.id === id)?.full_name ?? 'Former member').join(', ')
  const reorder = async (i: number, d: number) => {
    const ids = q.data!.map((r) => r.id)
    const [x] = ids.splice(i, 1)
    ids.splice(i + d, 0, x!)
    if (await attempt(() => crmApi(appId).orderAssignmentRules(ids), 'Order saved')) void invalidate()
  }
  const condText = (r: AssignmentRule) =>
    Object.entries(r.conditions)
      .map(([k, val]) => `${COND_LABEL[k] ?? k}: ${k === 'segment_id' ? (segments.data?.find((s) => s.id === val)?.name ?? 'segment') : k === 'lifecycle_stage' ? (LIFECYCLE_LABEL[val as keyof typeof LIFECYCLE_LABEL] ?? val) : val}`)
      .join(' · ') || 'Every new contact'
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div>
          <CardTitle>Assignment rules</CardTitle>
          <CardDescription>Give every new lead an owner automatically.</CardDescription>
        </div>
        {manage && (
          <Button
            size="sm"
            onClick={() => {
              setEditing(null)
              setOpen(true)
            }}
          >
            <Plus /> New rule
          </Button>
        )}
      </CardHeader>
      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data?.length ? (
        <EmptyState title="No assignment rules" description="Without rules, new contacts stay unassigned until someone takes them." />
      ) : (
        <ul className="divide-y border-t" data-testid="assignment-rules">
          {q.data.map((r, i) => (
            <li key={r.id} className="flex items-center gap-3 px-5 py-3">
              {manage && (
                <div className="flex flex-col">
                  <button type="button" disabled={i === 0} onClick={() => void reorder(i, -1)} className="rounded p-0.5 hover:bg-muted disabled:opacity-30" aria-label={`Move ${r.name} up`}>
                    <ArrowUp className="size-3.5" />
                  </button>
                  <button type="button" disabled={i === q.data.length - 1} onClick={() => void reorder(i, 1)} className="rounded p-0.5 hover:bg-muted disabled:opacity-30" aria-label={`Move ${r.name} down`}>
                    <ArrowDown className="size-3.5" />
                  </button>
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  {!r.active && <Badge variant="secondary">Paused</Badge>}
                  <span className="text-xs text-muted-foreground">{r.assigned_count} assigned</span>
                </div>
                <div className="truncate text-xs text-muted-foreground">{condText(r)}</div>
                <div className="truncate text-xs text-muted-foreground">
                  → {names(r.user_ids)}
                  {r.max_open_per_user && ` · max ${r.max_open_per_user} open each`}
                </div>
              </div>
              {manage && (
                <>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Edit ${r.name}`}
                    onClick={() => {
                      setEditing(r)
                      setOpen(true)
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={`Delete ${r.name}`} onClick={async () => (await attempt(() => crmApi(appId).deleteAssignmentRule(r.id), 'Rule deleted')) && invalidate()}>
                    <Trash2 />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <RuleDialog appId={appId} rule={editing} open={open} onOpenChange={setOpen} />
    </Card>
  )
}

// ------------------------------------------------------------------ scoring

const FIT_FIELDS = ['country', 'state', 'city', 'source', 'lifecycle_stage', 'company', 'email', 'phone', 'phone_type', 'timezone', 'company.industry', 'company.size', 'company.country', 'company.state']
const OPERATORS: Record<ScoringOperator, string> = { eq: 'is', neq: 'is not', contains: 'contains', set: 'is set', not_set: 'is empty' }
const EVENTS: Record<ScoringEvent, string> = {
  email_opened: 'Opened an email',
  email_clicked: 'Clicked an email',
  email_bounced: 'Email bounced',
  email_unsubscribed: 'Unsubscribed from email',
  sms_delivered: 'SMS delivered',
  sms_replied: 'Replied to SMS',
  call_answered: 'Answered a call',
  call_opted_out: 'Opted out of calls',
  note_added: 'Note added',
  activity_logged: 'Activity logged',
  deal_created: 'Deal created',
  form_submitted: 'Submitted a form',
}

function ScoringTab({ appId, manage }: { appId: string; manage: boolean }) {
  const q = useScoringRules(appId)
  const invalidate = useInvalidate(appId)
  const [fit, setFit] = useState({ field: 'country', custom: '', operator: 'eq' as ScoringOperator, value: '', points: '10' })
  const [eng, setEng] = useState({ event: 'email_clicked' as ScoringEvent, points: '5', max: '' })
  const [rescoring, setRescoring] = useState(false)
  const rules = q.data ?? []
  const toggle = (r: (typeof rules)[number]) => attempt(() => crmApi(appId).updateScoringRule(r.id, { ...r, active: !r.active }), r.active ? 'Rule paused' : 'Rule enabled').then((ok) => { if (ok) void invalidate() })
  const remove = (id: string) => attempt(() => crmApi(appId).deleteScoringRule(id), 'Rule deleted').then((ok) => { if (ok) void invalidate() })
  const create = async (body: ScoringRuleInput) => {
    const ok = await attempt(() => crmApi(appId).createScoringRule(body), 'Scoring rule added')
    if (ok) void invalidate()
    return ok
  }
  const needsValue = fit.operator !== 'set' && fit.operator !== 'not_set'
  const attrs = useAttributes(appId)
  const fieldLabel = (f: string | null | undefined) => {
    if (!f) return '—'
    if (f.startsWith('attr:')) return attrs.data?.find((a) => a.key === f.slice(5))?.label ?? `Custom field “${f.slice(5)}”`
    return FIT_FIELD_LABEL[f] ?? f
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between rounded-lg border bg-card p-4">
        <p className="text-sm text-muted-foreground">Lead score = fit points + engagement points (within the engagement window). Scores refresh every 10 minutes.</p>
        {manage && (
          <Button
            variant="outline"
            loading={rescoring}
            onClick={async () => {
              setRescoring(true)
              try {
                const r = await crmApi(appId).rescore()
                toast.success(`Rescored ${r.scored.toLocaleString()} contacts`)
                void invalidate()
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setRescoring(false)
              }
            }}
          >
            <RefreshCw /> Rescore now
          </Button>
        )}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Fit rules</CardTitle>
          <CardDescription>Who they are: points when a contact field matches.</CardDescription>
        </CardHeader>
        <Table>
          <THead>
            <TR>
              <TH>Condition</TH>
              <TH className="text-right">Points</TH>
              <TH>Active</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {rules
              .filter((r) => r.kind === 'fit')
              .map((r) => (
                <TR key={r.id} data-testid="fit-rule">
                  <TD>
                    <span className="font-medium">{fieldLabel(r.field)}</span> {OPERATORS[r.operator as ScoringOperator] ?? r.operator} {r.value && <span className="font-medium">“{r.value}”</span>}
                  </TD>
                  <TD className={`text-right tabular-nums ${r.points < 0 ? 'text-destructive' : ''}`}>{r.points > 0 ? `+${r.points}` : r.points}</TD>
                  <TD>
                    <Checkbox checked={r.active} disabled={!manage} onChange={() => void toggle(r)} aria-label="Active" />
                  </TD>
                  <TD className="text-right">
                    {manage && (
                      <Button size="icon" variant="ghost" aria-label="Delete rule" onClick={() => void remove(r.id)}>
                        <Trash2 />
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
          </TBody>
        </Table>
        {manage && (
          <form
            className="flex flex-wrap items-end gap-2 border-t p-4"
            onSubmit={async (e) => {
              e.preventDefault()
              const field = fit.field === 'attr' ? `attr:${fit.custom.trim()}` : fit.field
              if (await create({ kind: 'fit', field, operator: fit.operator, value: needsValue ? fit.value : null, points: Number(fit.points), active: true })) setFit({ ...fit, value: '' })
            }}
          >
            <Field label="Field" htmlFor="fit-field">
              <Select id="fit-field" value={fit.field} onChange={(e) => setFit({ ...fit, field: e.target.value })} className="w-full sm:w-48">
                {FIT_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {FIT_FIELD_LABEL[f] ?? f}
                  </option>
                ))}
                {!!attrs.data?.length && (
                  <optgroup label="Custom fields">
                    {attrs.data.map((a) => (
                      <option key={a.key} value={`attr:${a.key}`}>
                        {a.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="attr">Other custom field key…</option>
              </Select>
            </Field>
            {fit.field === 'attr' && (
              <Field label="Custom field key" htmlFor="fit-custom">
                <Input id="fit-custom" value={fit.custom} onChange={(e) => setFit({ ...fit, custom: e.target.value })} className="w-36" placeholder="plan" />
              </Field>
            )}
            <Field label="Operator" htmlFor="fit-op">
              <Select id="fit-op" value={fit.operator} onChange={(e) => setFit({ ...fit, operator: e.target.value as ScoringOperator })} className="w-32">
                {Object.entries(OPERATORS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            {needsValue && (
              <Field label="Value" htmlFor="fit-value">
                <Input id="fit-value" value={fit.value} onChange={(e) => setFit({ ...fit, value: e.target.value })} className="w-40" />
              </Field>
            )}
            <Field label="Points" htmlFor="fit-points">
              <Input id="fit-points" type="number" min={-100} max={100} value={fit.points} onChange={(e) => setFit({ ...fit, points: e.target.value })} className="w-24" />
            </Field>
            <Button type="submit" variant="outline" disabled={(needsValue && !fit.value.trim()) || (fit.field === 'attr' && !fit.custom.trim())}>
              <Plus /> Add fit rule
            </Button>
          </form>
        )}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Engagement rules</CardTitle>
          <CardDescription>What they do: points for each event, optionally capped.</CardDescription>
        </CardHeader>
        <Table>
          <THead>
            <TR>
              <TH>Event</TH>
              <TH className="text-right">Points</TH>
              <TH className="text-right">Max</TH>
              <TH>Active</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {rules
              .filter((r) => r.kind === 'engagement')
              .map((r) => (
                <TR key={r.id} data-testid="engagement-rule">
                  <TD>{EVENTS[r.event as ScoringEvent] ?? r.event}</TD>
                  <TD className={`text-right tabular-nums ${r.points < 0 ? 'text-destructive' : ''}`}>{r.points > 0 ? `+${r.points}` : r.points}</TD>
                  <TD className="text-right tabular-nums text-muted-foreground">{r.max_points ?? '—'}</TD>
                  <TD>
                    <Checkbox checked={r.active} disabled={!manage} onChange={() => void toggle(r)} aria-label="Active" />
                  </TD>
                  <TD className="text-right">
                    {manage && (
                      <Button size="icon" variant="ghost" aria-label="Delete rule" onClick={() => void remove(r.id)}>
                        <Trash2 />
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
          </TBody>
        </Table>
        {manage && (
          <form
            className="flex flex-wrap items-end gap-2 border-t p-4"
            onSubmit={async (e) => {
              e.preventDefault()
              await create({ kind: 'engagement', event: eng.event, points: Number(eng.points), max_points: eng.max ? Number(eng.max) : null, active: true })
            }}
          >
            <Field label="Event" htmlFor="eng-event">
              <Select id="eng-event" value={eng.event} onChange={(e) => setEng({ ...eng, event: e.target.value as ScoringEvent })} className="w-52">
                {Object.entries(EVENTS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Points" htmlFor="eng-points">
              <Input id="eng-points" type="number" min={-100} max={100} value={eng.points} onChange={(e) => setEng({ ...eng, points: e.target.value })} className="w-24" />
            </Field>
            <Field label="Max points" htmlFor="eng-max">
              <Input id="eng-max" type="number" min={1} max={1000} placeholder="No cap" value={eng.max} onChange={(e) => setEng({ ...eng, max: e.target.value })} className="w-28" />
            </Field>
            <Button type="submit" variant="outline">
              <Plus /> Add engagement rule
            </Button>
          </form>
        )}
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ general

function GeneralTab({ appId, manage }: { appId: string; manage: boolean }) {
  const q = useCrmSettings(appId)
  const invalidate = useInvalidate(appId)
  const [v, setV] = useState({ engagement_window_days: '', hot_score_threshold: '', sla_enabled: false, sla_minutes: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (q.data) setV({ engagement_window_days: String(q.data.engagement_window_days), hot_score_threshold: String(q.data.hot_score_threshold), sla_enabled: q.data.sla_enabled, sla_minutes: String(q.data.sla_minutes) })
  }, [q.data])
  if (q.isLoading) return <LoadingRows />
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Scoring window, what counts as a hot lead, and the first-response target.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field label="Engagement window (days)" htmlFor="gs-window" hint="Engagement older than this stops counting.">
          <Input id="gs-window" type="number" min={1} max={365} value={v.engagement_window_days} onChange={(e) => setV({ ...v, engagement_window_days: e.target.value })} />
        </Field>
        <Field label="Hot lead score" htmlFor="gs-hot" hint="Leads at or above this are flagged hot.">
          <Input id="gs-hot" type="number" min={1} max={1000} value={v.hot_score_threshold} onChange={(e) => setV({ ...v, hot_score_threshold: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <Checkbox checked={v.sla_enabled} onChange={(e) => setV({ ...v, sla_enabled: e.target.checked })} /> Track a first-response SLA for newly assigned leads
        </label>
        {v.sla_enabled && (
          <Field label="Respond within (minutes)" htmlFor="gs-sla">
            <Input id="gs-sla" type="number" min={1} max={10080} value={v.sla_minutes} onChange={(e) => setV({ ...v, sla_minutes: e.target.value })} />
          </Field>
        )}
      </CardContent>
      {manage && (
        <CardFooter>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true)
              const ok = await attempt(
                () =>
                  crmApi(appId).updateSettings({
                    engagement_window_days: Number(v.engagement_window_days),
                    hot_score_threshold: Number(v.hot_score_threshold),
                    sla_enabled: v.sla_enabled,
                    sla_minutes: Number(v.sla_minutes),
                  }),
                'Settings saved',
              )
              setBusy(false)
              if (ok) void invalidate()
            }}
          >
            Save settings
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}

export function CrmSettingsPage() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const manage = can('crm.manage')
  return (
    <>
      <PageHeader
        title="CRM settings"
        description={
          manage ? (
            'Pipelines, lost reasons, lead routing and scoring for this application.'
          ) : (
            <span className="flex items-center gap-1.5">
              <Lock className="size-3.5" /> Read only. Ask an admin for the “Manage CRM” permission to make changes.
            </span>
          )
        }
      />
      <Tabs defaultValue="pipelines">
        <TabsList className="overflow-x-auto whitespace-nowrap [scrollbar-width:none]">
          <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
          <TabsTrigger value="lost">Lost reasons</TabsTrigger>
          <TabsTrigger value="assignment">Assignment rules</TabsTrigger>
          <TabsTrigger value="scoring">Lead scoring</TabsTrigger>
          <TabsTrigger value="general">General</TabsTrigger>
        </TabsList>
        <TabsContent value="pipelines">
          <PipelinesTab appId={appId} manage={manage} />
        </TabsContent>
        <TabsContent value="lost">
          <LostReasonsTab appId={appId} manage={manage} />
        </TabsContent>
        <TabsContent value="assignment">
          <AssignmentTab appId={appId} manage={manage} />
        </TabsContent>
        <TabsContent value="scoring">
          <ScoringTab appId={appId} manage={manage} />
        </TabsContent>
        <TabsContent value="general">
          <GeneralTab appId={appId} manage={manage} />
        </TabsContent>
      </Tabs>
    </>
  )
}
