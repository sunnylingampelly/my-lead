import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Flame, ListPlus, Plus, Search, Tag, Target, Upload, Users, Workflow, X } from 'lucide-react'
import { aqk, audienceApi, useLists, useSegments, useTags } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { cqk, useCrmSettings, useCrmTeam, useLeads } from '@/api/crm'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input, Select } from '@/components/ui/form-controls'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Checkbox, Pagination } from '@/components/audience'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn } from '@/lib/utils'
import type { LeadFilters } from '@/types/crm'
import { ContactFormDialog } from '../audience/ContactFormDialog'
import { GradeBadge, LifecycleBadge, OwnerAvatar, SlaStatus } from './components'
import { AddTagDialog, AddToListDialog, EnrollDialog } from './connect'
import { useDebounced } from './hooks'
import { LIFECYCLE_LABEL, LIFECYCLES } from './format'

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn('h-9 rounded-md border px-3 text-xs font-medium transition', active ? 'border-primary bg-primary/10 text-primary' : 'bg-card text-muted-foreground hover:text-foreground')}
    >
      {children}
    </button>
  )
}

const FILTER_KEYS = ['mine', 'unassigned', 'breached', 'lifecycle', 'min', 'q', 'tag', 'list', 'segment'] as const

export function LeadsPage() {
  const { app, can } = useWorkspace()
  const { user } = useAuth()
  const appId = app!.id
  const navigate = useNavigate()
  const qc = useQueryClient()
  const settings = useCrmSettings(appId)
  const team = useCrmTeam(appId)
  const tags = useTags(appId)
  const lists = useLists(appId)
  const segments = useSegments(appId)
  // Filters live in the URL so reload / share keeps them.
  const [params, setParams] = useSearchParams()
  const get = (k: string) => params.get(k) ?? ''
  const set = (patch: Record<string, string | boolean>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v === false) next.delete(k)
      else next.set(k, v === true ? '1' : v)
    }
    next.delete('page')
    setParams(next, { replace: true })
    setSelected(new Set())
  }
  const page = Number(params.get('page') ?? 1) || 1
  const setPage = (p: number) => {
    const next = new URLSearchParams(params)
    if (p > 1) next.set('page', String(p))
    else next.delete('page')
    setParams(next, { replace: true })
  }
  const mine = get('mine') === '1'
  const unassigned = get('unassigned') === '1'
  const breached = get('breached') === '1'
  const lifecycle = get('lifecycle')
  const [searchText, setSearchText] = useState(get('q'))
  const [minScore, setMinScore] = useState(get('min'))
  const sort = get('sort') || '-lead_score'
  const search = useDebounced(searchText.trim())
  const dMin = useDebounced(minScore)
  const filters: LeadFilters = {
    owner_id: mine ? user?.id : undefined,
    unassigned,
    sla: breached ? 'breached' : '',
    lifecycle,
    min_score: dMin === '' ? '' : Number(dMin),
    search,
    sort,
    tag_id: get('tag') || undefined,
    list_id: get('list') || undefined,
    segment_id: get('segment') || undefined,
  }
  const anyFilter = FILTER_KEYS.some((k) => params.get(k)) || !!search || dMin !== ''
  const q = useLeads(appId, { ...filters, page, page_size: 25 })
  const hot = settings.data?.hot_score_threshold
  const write = can('audience.write')
  const crmWrite = can('crm.write')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<null | 'tag' | 'list' | 'enroll'>(null)
  const [addContact, setAddContact] = useState(false)
  const [busy, setBusy] = useState(false)
  const rows = q.data?.items ?? []
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const runBulk = async (body: { action: 'assign_owner' | 'set_lifecycle'; owner_id?: string | null; lifecycle_stage?: string }, done: string) => {
    setBusy(true)
    try {
      const r = await audienceApi(appId).bulk({ ...body, contact_ids: [...selected] })
      toast.success(`${done}: ${r.affected} of ${r.matched} lead(s) changed`)
      setSelected(new Set())
      await Promise.all([qc.invalidateQueries({ queryKey: cqk.all(appId) }), qc.invalidateQueries({ queryKey: aqk.all(appId) })])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const headerActions = write && (
    <>
      <Button variant="outline" asChild>
        <Link to={`/apps/${appId}/audience/import`}>
          <Upload /> Import
        </Link>
      </Button>
      <Button onClick={() => setAddContact(true)}>
        <Plus /> Add contact
      </Button>
    </>
  )

  return (
    <>
      <PageHeader
        title="Leads"
        description={
          <span className="block space-y-0.5">
            <span className="block">
              Leads are your contacts in an open lifecycle stage, ranked by lead score; every lead is also a contact.{' '}
              <Link to={`/apps/${appId}/audience/contacts`} className="font-medium text-primary underline-offset-4 hover:underline" data-testid="view-as-contacts">
                View as contacts
              </Link>
            </span>
            <span className="block text-xs">Grade letter is fit (A best), number is engagement (1 best).</span>
          </span>
        }
        actions={headerActions}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search leads"
            placeholder="Search name, email, phone, company"
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value)
              set({ q: e.target.value.trim() })
            }}
            className="w-full pl-8 sm:w-64"
          />
        </div>
        <Chip active={mine} onClick={() => set({ mine: !mine, unassigned: false })}>
          Mine
        </Chip>
        <Chip active={unassigned} onClick={() => set({ unassigned: !unassigned, mine: false })}>
          Unassigned
        </Chip>
        <Chip active={breached} onClick={() => set({ breached: !breached })}>
          SLA breached
        </Chip>
        <Select aria-label="Lifecycle stage" value={lifecycle} onChange={(e) => set({ lifecycle: e.target.value })} className="w-full sm:w-48">
          <option value="">All lifecycle stages</option>
          {LIFECYCLES.map((l) => (
            <option key={l} value={l}>
              {LIFECYCLE_LABEL[l]}
            </option>
          ))}
        </Select>
        <Input
          aria-label="Minimum score"
          type="number"
          placeholder="Min score"
          value={minScore}
          onChange={(e) => {
            setMinScore(e.target.value)
            set({ min: e.target.value })
          }}
          className="w-28"
        />
        <Select aria-label="Tag" value={get('tag')} onChange={(e) => set({ tag: e.target.value })} className="w-full sm:w-40">
          <option value="">Any tag</option>
          {tags.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select aria-label="List" value={get('list')} onChange={(e) => set({ list: e.target.value })} className="w-full sm:w-40">
          <option value="">Any list</option>
          {lists.data?.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Segment" value={get('segment')} onChange={(e) => set({ segment: e.target.value })} className="w-full sm:w-40">
          <option value="">Any segment</option>
          {segments.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        {anyFilter && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchText('')
              setMinScore('')
              setParams(new URLSearchParams(), { replace: true })
            }}
          >
            <X /> Clear
          </Button>
        )}
        <Select aria-label="Sort" value={sort} onChange={(e) => set({ sort: e.target.value === '-lead_score' ? '' : e.target.value })} className="w-full sm:ml-auto sm:w-44">
          <option value="-lead_score">Highest score</option>
          <option value="-engagement_score">Most engaged</option>
          <option value="sla_due_at">SLA due soonest</option>
          <option value="-created_at">Newest</option>
        </Select>
      </div>
      <Card>
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-accent/60 px-4 py-2 text-sm" data-testid="leads-bulk-bar">
            <span className="font-medium">{selected.size} selected</span>
            {crmWrite && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={busy}>
                    <Users /> Assign owner
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                  <DropdownMenuLabel>Assign to</DropdownMenuLabel>
                  {team.data?.map((u) => (
                    <DropdownMenuItem key={u.id} onSelect={() => void runBulk({ action: 'assign_owner', owner_id: u.id }, `Assigned to ${u.full_name}`)}>
                      {u.full_name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void runBulk({ action: 'assign_owner', owner_id: null }, 'Unassigned')}>Unassigned</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {crmWrite && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={busy}>
                    <Target /> Set lifecycle
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {LIFECYCLES.map((l) => (
                    <DropdownMenuItem key={l} onSelect={() => void runBulk({ action: 'set_lifecycle', lifecycle_stage: l }, `Set to ${LIFECYCLE_LABEL[l]}`)}>
                      {LIFECYCLE_LABEL[l]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {write && (
              <>
                <Button size="sm" variant="outline" onClick={() => setDialog('tag')}>
                  <Tag /> Add tag
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDialog('list')}>
                  <ListPlus /> Add to list
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDialog('enroll')}>
                  <Workflow /> Enroll in workflow
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !rows.length ? (
          anyFilter ? (
            <EmptyState icon={Target} title="No leads match" description="Try removing a filter. Scores update as people engage." />
          ) : (
            <EmptyState
              icon={Target}
              title="No leads yet"
              description="No leads yet. Leads are contacts in an open lifecycle stage (lead, MQL, SQL, opportunity)."
              action={
                write ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button variant="outline" asChild>
                      <Link to={`/apps/${appId}/audience/import`}>
                        <Upload /> Import contacts
                      </Link>
                    </Button>
                    <Button onClick={() => setAddContact(true)}>
                      <Plus /> Add contact
                    </Button>
                  </div>
                ) : undefined
              }
            />
          )
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH className="w-10">
                    <Checkbox
                      aria-label="Select all on this page"
                      checked={allOnPage}
                      onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...rows.map((r) => r.id)]) : new Set([...selected].filter((id) => !rows.some((r) => r.id === id))))}
                    />
                  </TH>
                  <TH>Name</TH>
                  <TH>Company</TH>
                  <TH>Owner</TH>
                  <TH>Lifecycle</TH>
                  <TH className="text-right">Score</TH>
                  <TH>Source</TH>
                  <TH>Response SLA</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((l) => (
                  <TR key={l.id} className={cn('cursor-pointer', selected.has(l.id) && 'bg-accent/40')} onClick={() => navigate(`/apps/${appId}/audience/contacts/${l.id}?tab=crm`)} data-testid="lead-row">
                    <TD onClick={(e) => e.stopPropagation()}>
                      <Checkbox aria-label={`Select ${l.name}`} checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                    </TD>
                    <TD>
                      <Link to={`/apps/${appId}/audience/contacts/${l.id}?tab=crm`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">
                        {l.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">{l.email ?? l.phone ?? ''}</div>
                    </TD>
                    <TD className="text-muted-foreground">
                      {l.company?.id ? (
                        <Link to={`/apps/${appId}/crm/companies/${l.company.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                          {l.company.name}
                        </Link>
                      ) : (
                        (l.company?.name ?? '—')
                      )}
                    </TD>
                    <TD>
                      <OwnerAvatar owner={l.owner} />
                    </TD>
                    <TD>
                      <LifecycleBadge stage={l.lifecycle_stage} />
                    </TD>
                    <TD className="text-right">
                      <span className="inline-flex items-center gap-2">
                        {hot !== undefined && l.lead_score >= hot && <Flame className="size-3.5 text-destructive" aria-label="Hot lead" />}
                        <span className="font-semibold tabular-nums">{l.lead_score}</span>
                        <GradeBadge grade={l.grade} fit={l.fit_score} engagement={l.engagement_score} score={l.lead_score} />
                      </span>
                    </TD>
                    <TD className="text-muted-foreground">{l.source ?? '—'}</TD>
                    <TD>
                      <SlaStatus due={l.sla_due_at} breached={l.sla_breached_at} responded={l.first_response_at} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={25} total={q.data!.total} onPage={setPage} />
          </>
        )}
      </Card>
      <AddTagDialog appId={appId} open={dialog === 'tag'} onOpenChange={(o) => !o && setDialog(null)} contactIds={[...selected]} />
      <AddToListDialog appId={appId} open={dialog === 'list'} onOpenChange={(o) => !o && setDialog(null)} contactIds={[...selected]} />
      <EnrollDialog appId={appId} open={dialog === 'enroll'} onOpenChange={(o) => !o && setDialog(null)} audience={{ contact_ids: [...selected] }} />
      <ContactFormDialog
        open={addContact}
        onOpenChange={setAddContact}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: cqk.leads(appId) })
        }}
      />
    </>
  )
}
