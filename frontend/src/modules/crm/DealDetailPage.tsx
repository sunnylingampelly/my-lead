import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, ChevronDown, Pencil, RotateCcw, Snowflake, Trash2, Trophy, UserPlus, X, XCircle } from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { cqk, crmApi, useDeal, usePipelines } from '@/api/crm'
import { EmptyState, ErrorState, FullPageSpinner, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/form-controls'
import { Avatar, Badge } from '@/components/ui/misc'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn, formatDateTime, timeAgo } from '@/lib/utils'
import type { ContactRef, DealDetail, DealInput, Ref } from '@/types/crm'
import { CompanyPicker, ContactPicker, LostReasonDialog, OwnerSelect, SectionTitle } from './components'
import { DealStatusBadge } from './DealsPage'
import { money, shortDate } from './format'
import { RecordActivity } from './Timeline'
import { QuickActions, ReachChips, WorkflowsCard } from './connect'

/** Click-to-edit field that saves on blur or Enter. */
function InlineField({ label, value, display, type = 'text', disabled, onSave, id, ...rest }: { label: string; value: string; display?: React.ReactNode; type?: string; disabled?: boolean; onSave: (v: string) => Promise<void>; id: string; min?: number; max?: number; placeholder?: string }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(value)
  const save = async () => {
    setEditing(false)
    if (v !== value) await onSave(v)
  }
  return (
    <div className="py-2">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {editing ? (
        <Input
          id={id}
          type={type}
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
            if (e.key === 'Escape') {
              setV(value)
              setEditing(false)
            }
          }}
          className="mt-1 h-8"
          {...rest}
        />
      ) : (
        <button
          type="button"
          id={id}
          disabled={disabled}
          onClick={() => {
            setV(value)
            setEditing(true)
          }}
          aria-label={`Edit ${label}`}
          className="group -mx-1.5 mt-0.5 flex w-[calc(100%+0.75rem)] items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left text-sm hover:bg-muted focus-visible:bg-muted disabled:hover:bg-transparent"
        >
          <span className="min-w-0 break-words">{display ?? (value || <span className="text-muted-foreground">—</span>)}</span>
          {!disabled && <Pencil className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />}
        </button>
      )}
    </div>
  )
}

function StageBar({ deal, appId, onMove, writable }: { deal: DealDetail; appId: string; onMove: (stageId: string, kind: string) => void; writable: boolean }) {
  const pipelines = usePipelines(appId, true)
  const p = pipelines.data?.find((x) => x.id === deal.pipeline_id)
  if (!p) return null
  const open = p.stages.filter((s) => s.kind === 'open')
  const idx = open.findIndex((s) => s.id === deal.stage_id)
  return (
    <div className="mb-6">
      <div className="flex overflow-hidden rounded-lg border" role="list" aria-label="Pipeline stages">
        {open.map((s, i) => {
          const done = deal.status === 'won' || (idx >= 0 && i < idx)
          const current = s.id === deal.stage_id
          return (
            <button
              type="button"
              role="listitem"
              key={s.id}
              disabled={!writable || current}
              onClick={() => onMove(s.id, s.kind)}
              title={`${s.name} · ${s.probability}%`}
              aria-current={current ? 'step' : undefined}
              className={cn(
                'relative flex min-w-0 flex-1 items-center justify-center gap-1 border-r px-2 py-2 text-xs font-medium transition last:border-r-0',
                current ? 'bg-primary text-primary-foreground' : done ? 'bg-primary/15 text-primary' : 'bg-card text-muted-foreground hover:bg-muted',
                deal.status === 'lost' && !current && 'opacity-60',
              )}
            >
              {done && <Check className="size-3 shrink-0" />}
              <span className="truncate">{s.name}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function DealDetailPage() {
  const { dealId } = useParams()
  const { app, can } = useWorkspace()
  const appId = app!.id
  const api = crmApi(appId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useDeal(appId, dealId!)
  const [lostOpen, setLostOpen] = useState<string | null>(null)
  const [del, setDel] = useState(false)
  const [addPerson, setAddPerson] = useState(false)
  const [person, setPerson] = useState<Ref | null>(null)
  const [role, setRole] = useState('')
  const writable = can('crm.write')
  const audienceWrite = can('audience.write')
  const base = `/apps/${appId}`
  const [openPerson, setOpenPerson] = useState<string | null | undefined>(undefined)

  if (q.isLoading) return <FullPageSpinner />
  if (q.isError)
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <EmptyState title="Deal not found" description="It may have been deleted." action={<Button asChild><Link to={`${base}/crm/deals`}>Back to deals</Link></Button>} />
    ) : (
      <ErrorState error={q.error} onRetry={() => q.refetch()} />
    )
  const d = q.data!

  const after = async (p: Promise<DealDetail>, msg?: string) => {
    try {
      const r = await p
      qc.setQueryData(cqk.deal(appId, d.id), r)
      void qc.invalidateQueries({ queryKey: cqk.all(appId) })
      if (msg) toast.success(msg)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'LOST_REASON_REQUIRED') setLostOpen('close')
      else toast.error(errorMessage(e))
      throw e
    }
  }
  const patch = (body: DealInput) => after(api.updateDeal(d.id, body), 'Saved').catch(() => undefined)
  const move = (stageId: string, kind: string) => {
    if (kind === 'lost') return setLostOpen(stageId)
    void after(api.moveDeal(d.id, { stage_id: stageId })).catch(() => undefined)
  }
  const cur = d.currency
  // The primary contact first (badged), then everyone else linked to the deal.
  const people: (ContactRef & { primary?: boolean })[] = [
    ...(d.contact ? [{ ...d.contact, primary: true }] : []),
    ...d.contacts.filter((c) => c.id !== d.contact?.id),
  ]
  const expanded = openPerson === undefined ? people[0]?.id ?? null : openPerson

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Deals', to: `${base}/crm/deals` }, { label: d.title }]}
        title={d.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <DealStatusBadge status={d.status} />
            <span className="font-semibold text-foreground tabular-nums">{money(d.amount, cur)}</span>
            <span>· {d.stage_name}</span>
            {d.status === 'lost' && d.lost_reason && <Badge variant="outline">Lost: {d.lost_reason.name}</Badge>}
            {d.rotting && (
              <Badge variant="destructive">
                <Snowflake className="size-3" /> Going cold
              </Badge>
            )}
          </span>
        }
        actions={
          writable && (
            <>
              {d.status === 'open' ? (
                <>
                  <Button variant="outline" className="border-success-border text-success-strong hover:bg-success-soft" onClick={() => void after(api.closeDeal(d.id, { outcome: 'won' }), '🎉 Deal won').catch(() => undefined)}>
                    <Trophy /> Won
                  </Button>
                  <Button variant="outline" className="text-destructive" onClick={() => setLostOpen('close')}>
                    <XCircle /> Lost
                  </Button>
                </>
              ) : (
                <Button variant="outline" onClick={() => void after(api.reopenDeal(d.id), 'Deal reopened').catch(() => undefined)}>
                  <RotateCcw /> Reopen
                </Button>
              )}
              <Button variant="ghost" size="icon" aria-label="Delete deal" onClick={() => setDel(true)}>
                <Trash2 />
              </Button>
            </>
          )
        }
      />
      <StageBar deal={d} appId={appId} onMove={move} writable={writable && d.status === 'open'} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="divide-y">
              <InlineField id="f-title" label="Title" value={d.title} disabled={!writable} onSave={(v) => (v.trim() ? patch({ title: v.trim() }) : Promise.resolve())} />
              <InlineField id="f-amount" label={`Amount (${cur})`} type="number" min={0} value={String(Number(d.amount))} display={money(d.amount, cur, true)} disabled={!writable} onSave={(v) => patch({ amount: v || 0 })} />
              <InlineField
                id="f-prob"
                label={d.probability_overridden ? 'Probability (overridden)' : 'Probability (from stage)'}
                type="number"
                min={0}
                max={100}
                value={d.probability_overridden ? String(d.probability) : ''}
                placeholder={`${d.probability}`}
                display={
                  <span>
                    {d.probability}% <span className="text-muted-foreground">· weighted {money(d.weighted_amount, cur)}</span>
                  </span>
                }
                disabled={!writable}
                onSave={(v) => patch(v === '' ? { clear_probability: true } : { probability: Number(v) })}
              />
              <InlineField id="f-close" label="Expected close date" type="date" value={d.expected_close_date ?? ''} display={d.expected_close_date ? shortDate(d.expected_close_date) : undefined} disabled={!writable} onSave={(v) => patch({ expected_close_date: v || null })} />
              <InlineField id="f-source" label="Source" value={d.source ?? ''} disabled={!writable} onSave={(v) => patch({ source: v || null })} />
              <div className="py-2">
                <Field label="Owner" htmlFor="f-owner">
                  <fieldset disabled={!writable}>
                    <OwnerSelect appId={appId} id="f-owner" value={d.owner?.id ?? ''} onChange={(v) => void patch({ owner_id: v || null })} />
                  </fieldset>
                </Field>
              </div>
              <div className="py-2">
                <Field label="Primary contact" htmlFor="f-contact">
                  <ContactPicker appId={appId} id="f-contact" disabled={!writable} value={d.contact ? { id: d.contact.id, name: d.contact.name } : null} onChange={(v) => void patch({ contact_id: v?.id ?? null })} />
                </Field>
                {d.contact && (
                  <Link to={`${base}/audience/contacts/${d.contact.id}`} className="mt-1 inline-block text-xs text-primary hover:underline">
                    Open contact
                  </Link>
                )}
              </div>
              <div className="py-2">
                <Field label="Company" htmlFor="f-company">
                  <CompanyPicker appId={appId} id="f-company" disabled={!writable} value={d.company} onChange={(v) => void patch({ company_id: v?.id ?? null })} />
                </Field>
                {d.company && (
                  <Link to={`${base}/crm/companies/${d.company.id}`} className="mt-1 inline-block text-xs text-primary hover:underline">
                    Open company
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-5">
              <SectionTitle
                action={
                  writable && (
                    <Button size="sm" variant="ghost" onClick={() => setAddPerson((x) => !x)}>
                      <UserPlus /> Add
                    </Button>
                  )
                }
              >
                People on this deal
              </SectionTitle>
              {addPerson && (
                <div className="mb-3 space-y-2 rounded-lg border p-3">
                  <ContactPicker appId={appId} value={person} onChange={setPerson} />
                  <Input placeholder="Role (e.g. Decision maker)" value={role} maxLength={60} onChange={(e) => setRole(e.target.value)} aria-label="Role" />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setAddPerson(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={!person}
                      onClick={async () => {
                        const list = [...d.contacts.filter((c) => c.id !== person!.id).map((c) => ({ contact_id: c.id, role: c.role ?? null })), { contact_id: person!.id, role: role || null }]
                        await after(api.setDealContacts(d.id, list), 'Person added').catch(() => undefined)
                        setPerson(null)
                        setRole('')
                        setAddPerson(false)
                      }}
                    >
                      Add person
                    </Button>
                  </div>
                </div>
              )}
              {people.length === 0 ? (
                <p className="text-sm text-muted-foreground">No one linked yet. Set a primary contact above or add people.</p>
              ) : (
                <ul className="space-y-3" data-testid="deal-people">
                  {people.map((c) => (
                    <li key={c.id} className="rounded-lg border p-2" data-testid="deal-person">
                    <div className="flex items-center gap-2">
                      <Avatar name={c.name} className="size-7 text-[10px]" />
                      <div className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <Link to={`${base}/audience/contacts/${c.id}`} className="block truncate text-sm font-medium hover:underline">
                            {c.name}
                          </Link>
                          {c.primary && <Badge variant="default">Primary</Badge>}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">{c.role || c.email || c.phone || ''}</span>
                        <ReachChips reach={c.reach} className="mt-1" />
                      </div>
                      <button
                        type="button"
                        className="rounded p-1 text-muted-foreground hover:bg-muted"
                        aria-expanded={expanded === c.id}
                        aria-label={`Actions for ${c.name}`}
                        onClick={() => setOpenPerson(expanded === c.id ? null : c.id)}
                      >
                        <ChevronDown className={cn('size-4 transition', expanded === c.id && 'rotate-180')} />
                      </button>
                      {writable && !c.primary && (
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-muted"
                          aria-label={`Remove ${c.name}`}
                          onClick={() =>
                            void after(
                              api.setDealContacts(
                                d.id,
                                d.contacts.filter((x) => x.id !== c.id).map((x) => ({ contact_id: x.id, role: x.role ?? null })),
                              ),
                            ).catch(() => undefined)
                          }
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                    {expanded === c.id && (
                      <QuickActions
                        className="mt-2"
                        appId={appId}
                        dealId={d.id}
                        contact={{ id: c.id, name: c.name, email: c.email, phone: c.phone, reach: c.reach }}
                        crm={writable}
                        write={audienceWrite}
                      />
                    )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <WorkflowsCard appId={appId} contactIds={people.map((p) => p.id)} />

          <Card>
            <CardContent className="pt-5">
              <SectionTitle>Stage history</SectionTitle>
              {d.stage_history.length === 0 ? (
                <p className="text-sm text-muted-foreground">No moves yet.</p>
              ) : (
                <ol className="space-y-2 text-sm" data-testid="stage-history">
                  {d.stage_history.map((h, i) => (
                    <li key={i} className="flex flex-col">
                      <span>
                        {h.from_stage ? (
                          <>
                            {h.from_stage} → <span className="font-medium">{h.to_stage}</span>
                          </>
                        ) : (
                          <>
                            Created in <span className="font-medium">{h.to_stage}</span>
                          </>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground" title={formatDateTime(h.changed_at)}>
                        {timeAgo(h.changed_at)}
                        {h.changed_by && ` · ${h.changed_by.full_name}`}
                        {h.from_stage && ` · ${h.days_in_previous}d in previous`}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 lg:col-span-2">
          <RecordActivity appId={appId} target={{ deal_id: d.id }} />
        </div>
      </div>

      <LostReasonDialog
        appId={appId}
        open={!!lostOpen}
        dealTitle={d.title}
        onCancel={() => setLostOpen(null)}
        onConfirm={async (reason, note) => {
          const target = lostOpen
          setLostOpen(null)
          await after(
            target === 'close' ? api.closeDeal(d.id, { outcome: 'lost', lost_reason_id: reason, lost_note: note || undefined }) : api.moveDeal(d.id, { stage_id: target!, lost_reason_id: reason, lost_note: note || undefined }),
            'Deal marked lost',
          ).catch(() => undefined)
        }}
      />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title="Delete this deal?"
        description="Its notes, tasks and history are deleted too. This can't be undone."
        confirmLabel="Delete deal"
        destructive
        onConfirm={async () => {
          try {
            await api.deleteDeal(d.id)
            await qc.invalidateQueries({ queryKey: cqk.all(appId) })
            toast.success('Deal deleted')
            navigate(`${base}/crm/deals`, { replace: true })
          } catch (e) {
            toast.error(errorMessage(e))
          }
        }}
      />
    </>
  )
}
