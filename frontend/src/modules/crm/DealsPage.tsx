import { useMemo, useState, type DragEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Building2, CalendarDays, Columns3, Handshake, List, Plus, Search, Snowflake, Trash2, User, Users } from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { useLists, useSegments, useTags } from '@/api/audience'
import { cqk, crmApi, useBoard, useCrmTeam, useDeals, usePipelines } from '@/api/crm'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Checkbox, Pagination } from '@/components/audience'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn } from '@/lib/utils'
import type { Board, Deal, DealStatus, Ref } from '@/types/crm'
import { CompanyPicker, DealFormDialog, LostReasonDialog, OwnerAvatar } from './components'
import { useDebounced } from './hooks'
import { money, moneyCompact, num, shortDate } from './format'

export function DealStatusBadge({ status }: { status: DealStatus }) {
  return <Badge variant={status === 'won' ? 'success' : status === 'lost' ? 'destructive' : 'secondary'}>{status === 'open' ? 'Open' : status === 'won' ? 'Won' : 'Lost'}</Badge>
}

function DealCard({ d, appId, draggable, onDragStart }: { d: Deal; appId: string; draggable: boolean; onDragStart: (e: DragEvent) => void }) {
  return (
    <Link
      to={`/apps/${appId}/crm/deals/${d.id}`}
      draggable={draggable}
      onDragStart={onDragStart}
      data-testid="deal-card"
      data-deal-id={d.id}
      className={cn(
        'block rounded-lg border bg-card p-3 text-left shadow-sm transition hover:border-primary/50 hover:shadow-card',
        d.rotting && 'border-l-4 border-l-destructive',
        draggable && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="line-clamp-2 text-sm font-medium">{d.title}</span>
        <OwnerAvatar owner={d.owner} />
      </div>
      {(d.company || d.contact) && (
        <div className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
          {d.company ? <Building2 className="size-3 shrink-0" /> : <User className="size-3 shrink-0" />}
          <span className="truncate">{d.company?.name ?? d.contact?.name}</span>
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold tabular-nums">{money(d.amount, d.currency)}</span>
        {d.expected_close_date && (
          <span className={cn('flex items-center gap-1 text-muted-foreground', d.status === 'open' && d.expected_close_date < new Date().toISOString().slice(0, 10) && 'text-destructive')}>
            <CalendarDays className="size-3" /> {shortDate(d.expected_close_date)}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{d.days_in_stage}d in stage</span>
        {d.rotting && (
          <span className="flex items-center gap-0.5 font-medium text-destructive" title={`No activity for more than ${d.rotting_days} days`}>
            <Snowflake className="size-3" /> Going cold
          </span>
        )}
      </div>
    </Link>
  )
}

/** Moves a deal between columns in a cached board, recomputing column counts and totals. */
function moveInBoard(b: Board, dealId: string, toStage: string): Board {
  let moving: Deal | undefined
  const cols = b.columns.map((c) => {
    const found = c.deals.find((d) => d.id === dealId)
    if (!found) return c
    moving = found
    return { ...c, deals: c.deals.filter((d) => d.id !== dealId), count: c.count - 1, total: num(c.total) - num(found.amount), weighted_total: num(c.weighted_total) - num(found.weighted_amount) }
  })
  if (!moving) return b
  return {
    ...b,
    columns: cols.map((c) => {
      if (c.stage.id !== toStage) return c
      const d: Deal = { ...moving!, stage_id: toStage, stage_name: c.stage.name, days_in_stage: 0, status: c.stage.kind === 'open' ? 'open' : c.stage.kind }
      const w = (num(d.amount) * (d.probability_overridden ? d.probability : c.stage.probability)) / 100
      return { ...c, deals: [d, ...c.deals], count: c.count + 1, total: num(c.total) + num(d.amount), weighted_total: num(c.weighted_total) + w }
    }),
  }
}

function BoardView({ appId, pipelineId, ownerId, search }: { appId: string; pipelineId?: string; ownerId?: string; search?: string }) {
  const { can } = useWorkspace()
  const qc = useQueryClient()
  const params = { pipeline_id: pipelineId, owner_id: ownerId, search }
  const q = useBoard(appId, params)
  const [over, setOver] = useState<string | null>(null)
  const [lost, setLost] = useState<{ deal: Deal; stageId: string } | null>(null)
  const [newIn, setNewIn] = useState<string | null>(null)
  const writable = can('crm.write')
  const key = cqk.board(appId, params)

  const move = async (deal: Deal, stageId: string, lostReasonId?: string, note?: string) => {
    const prev = qc.getQueryData<Board>(key)
    if (prev) qc.setQueryData(key, moveInBoard(prev, deal.id, stageId))
    try {
      await crmApi(appId).moveDeal(deal.id, { stage_id: stageId, position: 0, lost_reason_id: lostReasonId, lost_note: note || undefined })
      const stage = prev?.columns.find((c) => c.stage.id === stageId)?.stage
      toast.success(stage?.kind === 'won' ? `🎉 ${deal.title} won` : stage?.kind === 'lost' ? `${deal.title} marked lost` : `Moved to ${stage?.name ?? 'stage'}`)
    } catch (e) {
      if (prev) qc.setQueryData(key, prev)
      if (e instanceof ApiError && e.code === 'LOST_REASON_REQUIRED') setLost({ deal, stageId })
      else toast.error(errorMessage(e))
    } finally {
      void qc.invalidateQueries({ queryKey: cqk.all(appId) })
    }
  }

  const onDrop = (e: DragEvent, stageId: string) => {
    e.preventDefault()
    setOver(null)
    const id = e.dataTransfer.getData('application/x-deal')
    const deal = q.data?.columns.flatMap((c) => c.deals).find((d) => d.id === id)
    if (!deal || deal.stage_id === stageId) return
    const stage = q.data!.columns.find((c) => c.stage.id === stageId)!.stage
    if (stage.kind === 'lost') setLost({ deal, stageId })
    else void move(deal, stageId)
  }

  if (q.isLoading)
    return (
      <div className="flex gap-3 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-80 w-72 shrink-0" />
        ))}
      </div>
    )
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const b = q.data!
  const cur = b.pipeline.currency

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>
          <span className="text-muted-foreground">Open pipeline </span>
          <span className="font-semibold tabular-nums" data-testid="open-total">{money(b.open_total, cur)}</span>
        </span>
        <span>
          <span className="text-muted-foreground">Weighted </span>
          <span className="font-semibold tabular-nums">{money(b.weighted_total, cur)}</span>
        </span>
      </div>
      <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-4" data-testid="board">
        {b.columns.map((c) => (
          <section
            key={c.stage.id}
            aria-label={`${c.stage.name} column`}
            data-testid={`column-${c.stage.name}`}
            onDragOver={(e) => {
              if (!writable) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setOver(c.stage.id)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === c.stage.id ? null : o))
            }}
            onDrop={(e) => onDrop(e, c.stage.id)}
            className={cn(
              'flex max-h-[calc(100vh-15rem)] w-72 shrink-0 flex-col rounded-xl border bg-muted/40 transition-colors',
              over === c.stage.id && 'border-primary bg-primary/5 ring-2 ring-primary/30',
              c.stage.kind === 'won' && 'bg-success-soft/40',
              c.stage.kind === 'lost' && 'bg-danger-soft/30',
            )}
          >
            <header className="border-b px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="truncate text-sm font-semibold">{c.stage.name}</h2>
                <span className="rounded-full bg-background px-2 text-xs font-medium tabular-nums text-muted-foreground ring-1 ring-border" data-testid="column-count">
                  {c.count}
                </span>
              </div>
              <div className="mt-0.5 flex justify-between text-xs text-muted-foreground">
                <span className="font-medium tabular-nums text-foreground" title={money(c.total, cur)}>{moneyCompact(c.total, cur)}</span>
                {c.stage.kind === 'open' ? (
                  <span className="tabular-nums" title={`Weighted at ${c.stage.probability}%`}>
                    {moneyCompact(c.weighted_total, cur)} weighted · {c.stage.probability}%
                  </span>
                ) : (
                  <span>Last 30 days</span>
                )}
              </div>
            </header>
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {c.deals.map((d) => (
                <DealCard
                  key={d.id}
                  d={d}
                  appId={appId}
                  draggable={writable}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-deal', d.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                />
              ))}
              {c.deals.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{writable ? 'Drop deals here' : 'No deals'}</p>}
              {c.count > c.deals.length && <p className="px-2 text-center text-xs text-muted-foreground">+{c.count - c.deals.length} more in list view</p>}
            </div>
            {writable && c.stage.kind === 'open' && (
              <button type="button" onClick={() => setNewIn(c.stage.id)} className="flex items-center gap-1 border-t px-3 py-2 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground">
                <Plus className="size-3.5" /> Add deal
              </button>
            )}
          </section>
        ))}
      </div>
      <LostReasonDialog
        appId={appId}
        open={!!lost}
        dealTitle={lost?.deal.title}
        onCancel={() => setLost(null)}
        onConfirm={async (reason, note) => {
          const l = lost!
          setLost(null)
          await move(l.deal, l.stageId, reason, note)
        }}
      />
      <DealFormDialog appId={appId} open={!!newIn} onOpenChange={(o) => !o && setNewIn(null)} defaults={{ pipeline_id: b.pipeline.id, stage_id: newIn ?? undefined }} />
    </>
  )
}

function ListView({ appId, pipelineId, ownerId, search }: { appId: string; pipelineId?: string; ownerId?: string; search?: string }) {
  const { can } = useWorkspace()
  const qc = useQueryClient()
  const team = useCrmTeam(appId)
  const pipelines = usePipelines(appId)
  const tags = useTags(appId)
  const lists = useLists(appId)
  const segments = useSegments(appId)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<DealStatus | ''>('open')
  const [sort, setSort] = useState('-created_at')
  const [company, setCompany] = useState<Ref | null>(null)
  const [sourceText, setSourceText] = useState('')
  const source = useDebounced(sourceText.trim()) || undefined
  const [audience, setAudience] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [lostTo, setLostTo] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const navigate = useNavigate()
  const [audKind, audId] = audience.split(':')
  const q = useDeals(appId, {
    pipeline_id: pipelineId,
    owner_id: ownerId,
    search,
    status,
    sort,
    page,
    page_size: 25,
    company_id: company?.id,
    source,
    tag_id: audKind === 'tag' ? audId : undefined,
    list_id: audKind === 'list' ? audId : undefined,
    segment_id: audKind === 'segment' ? audId : undefined,
  })
  const rows = q.data?.items ?? []
  const writable = can('crm.write')
  const stages = pipelines.data?.find((p) => p.id === pipelineId)?.stages ?? []
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const reset = () => {
    setPage(1)
    setSelected(new Set())
  }
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const forEach = async (label: string, fn: (id: string) => Promise<unknown>) => {
    setBusy(true)
    let ok = 0
    const failed: string[] = []
    for (const id of selected) {
      try {
        await fn(id)
        ok++
      } catch (e) {
        failed.push(errorMessage(e))
      }
    }
    setBusy(false)
    if (ok) toast.success(`${label}: ${ok} deal(s)`)
    if (failed.length) toast.error(`${failed.length} failed: ${failed[0]}`)
    setSelected(new Set())
    await qc.invalidateQueries({ queryKey: cqk.all(appId) })
  }
  const moveTo = (stageId: string) => {
    const st = stages.find((x) => x.id === stageId)
    if (st?.kind === 'lost') setLostTo(stageId)
    else void forEach(`Moved to ${st?.name ?? 'stage'}`, (id) => crmApi(appId).moveDeal(id, { stage_id: stageId }))
  }
  // The API sorts title and close date ascending only; amount both ways.
  const head = (label: string, field: string, className?: string) => (
    <TH className={className}>
      <button type="button" className="uppercase hover:text-foreground" onClick={() => setSort((s) => (field !== 'amount' ? field : s === '-amount' ? 'amount' : '-amount'))}>
        {label}
        {sort.replace('-', '') === field && (sort.startsWith('-') ? ' ↓' : ' ↑')}
      </button>
    </TH>
  )
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <Select aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value as DealStatus | ''), reset())} className="w-full sm:w-36">
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
        </Select>
        <div className="w-full sm:w-56" data-testid="deal-company-filter">
          <CompanyPicker appId={appId} allowCreate={false} value={company} onChange={(c) => (setCompany(c), reset())} placeholder="Filter by company" />
        </div>
        <Input aria-label="Source" placeholder="Source (e.g. website)" value={sourceText} onChange={(e) => (setSourceText(e.target.value), reset())} className="w-full sm:w-44" />
        <Select aria-label="Contact in tag, list or segment" value={audience} onChange={(e) => (setAudience(e.target.value), reset())} className="w-full sm:w-52">
          <option value="">Any contact</option>
          {!!tags.data?.length && (
            <optgroup label="Contact has tag">
              {tags.data.map((t) => (
                <option key={t.id} value={`tag:${t.id}`}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          )}
          {!!lists.data?.length && (
            <optgroup label="Contact in list">
              {lists.data.map((l) => (
                <option key={l.id} value={`list:${l.id}`}>
                  {l.name}
                </option>
              ))}
            </optgroup>
          )}
          {!!segments.data?.length && (
            <optgroup label="Contact in segment">
              {segments.data.map((sg) => (
                <option key={sg.id} value={`segment:${sg.id}`}>
                  {sg.name}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </div>
      {writable && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-accent/60 px-4 py-2 text-sm" data-testid="deals-bulk-bar">
          <span className="font-medium">{selected.size} selected</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={busy}>
                <Users /> Assign owner
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
              {team.data?.map((u) => (
                <DropdownMenuItem key={u.id} onSelect={() => void forEach(`Assigned to ${u.full_name}`, (id) => crmApi(appId).updateDeal(id, { owner_id: u.id }))}>
                  {u.full_name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={busy || !stages.length}>
                <Columns3 /> Move stage
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {stages.map((st) => (
                <DropdownMenuItem key={st.id} onSelect={() => moveTo(st.id)}>
                  {st.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Delete
          </Button>
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
        <EmptyState icon={Handshake} title="No deals match" />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                {writable && (
                  <TH className="w-10">
                    <Checkbox aria-label="Select all deals on this page" checked={allOnPage} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
                  </TH>
                )}
                {head('Deal', 'title')}
                <TH>Stage</TH>
                {head('Amount', 'amount', 'text-right')}
                <TH>Company / contact</TH>
                <TH>Source</TH>
                <TH>Owner</TH>
                {head('Close date', 'close_date')}
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((d) => (
                <TR key={d.id} className={cn('cursor-pointer', selected.has(d.id) && 'bg-accent/40')} onClick={() => navigate(`/apps/${appId}/crm/deals/${d.id}`)} data-testid="deal-row">
                  {writable && (
                    <TD onClick={(e) => e.stopPropagation()}>
                      <Checkbox aria-label={`Select ${d.title}`} checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
                    </TD>
                  )}
                  <TD className="font-medium">
                    <Link to={`/apps/${appId}/crm/deals/${d.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                      {d.title}
                    </Link>
                    {d.rotting && <Snowflake className="ml-1.5 inline size-3.5 text-destructive" aria-label="Going cold" />}
                  </TD>
                  <TD className="text-muted-foreground">{d.stage_name}</TD>
                  <TD className="text-right tabular-nums">{money(d.amount, d.currency)}</TD>
                  <TD className="text-muted-foreground">{d.company?.name ?? d.contact?.name ?? '—'}</TD>
                  <TD className="text-muted-foreground">{d.source ?? '—'}</TD>
                  <TD>{d.owner?.full_name ?? <span className="text-muted-foreground">Unassigned</span>}</TD>
                  <TD className="text-muted-foreground">{d.expected_close_date ? shortDate(d.expected_close_date) : '—'}</TD>
                  <TD>
                    <DealStatusBadge status={d.status} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={25} total={q.data!.total} onPage={setPage} />
        </>
      )}
      <LostReasonDialog
        appId={appId}
        open={!!lostTo}
        dealTitle={selected.size === 1 ? rows.find((r) => selected.has(r.id))?.title : `${selected.size} deals`}
        onCancel={() => setLostTo(null)}
        onConfirm={async (reason, note) => {
          const stageId = lostTo!
          setLostTo(null)
          await forEach('Marked lost', (id) => crmApi(appId).moveDeal(id, { stage_id: stageId, lost_reason_id: reason, lost_note: note || undefined }))
        }}
      />
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selected.size} deal(s)?</DialogTitle>
            <DialogDescription>Their notes, tasks and stage history go with them. This can’t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              onClick={async () => {
                setConfirmDelete(false)
                await forEach('Deleted', (id) => crmApi(appId).deleteDeal(id))
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export function DealsPage() {
  const { app, can } = useWorkspace()
  const { user } = useAuth()
  const appId = app!.id
  const [params, setParams] = useSearchParams()
  const pipelines = usePipelines(appId)
  const [create, setCreate] = useState(() => params.get('new') === '1')
  const [searchText, setSearchText] = useState(params.get('q') ?? '')
  const search = useDebounced(searchText.trim()) || undefined
  const view = params.get('view') === 'list' ? 'list' : 'board'
  const mine = params.get('owner') === 'me'
  const defaultPipeline = useMemo(() => pipelines.data?.find((p) => p.is_default) ?? pipelines.data?.[0], [pipelines.data])
  const pipelineId = params.get('pipeline') ?? defaultPipeline?.id
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }
  const ownerId = mine ? user?.id : undefined

  return (
    <>
      <PageHeader
        title="Deals"
        description="Drag deals between stages. Deals with no recent activity are flagged as going cold."
        actions={
          can('crm.write') && (
            <Button onClick={() => setCreate(true)}>
              <Plus /> New deal
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label="Pipeline" value={pipelineId ?? ''} onChange={(e) => set('pipeline', e.target.value)} className="w-full sm:w-52">
          {pipelines.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.is_default ? ' (default)' : ''}
            </option>
          ))}
        </Select>
        <div className="flex rounded-md border bg-card p-0.5" role="group" aria-label="Owner">
          {[
            ['all', 'All deals'],
            ['me', 'My deals'],
          ].map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={(k === 'me') === mine}
              onClick={() => set('owner', k === 'me' ? 'me' : null)}
              className={cn('rounded px-3 py-1 text-xs font-medium transition', (k === 'me') === mine ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input aria-label="Search deals" placeholder="Search deals" value={searchText} onChange={(e) => setSearchText(e.target.value)} className="w-full pl-8 sm:w-56" />
        </div>
        <div className="ml-auto flex rounded-md border bg-card p-0.5" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'board'} onClick={() => set('view', null)} className={cn('flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium', view === 'board' ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
            <Columns3 className="size-3.5" /> Board
          </button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => set('view', 'list')} className={cn('flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium', view === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
            <List className="size-3.5" /> List
          </button>
        </div>
      </div>
      {!pipelineId ? (
        pipelines.isError ? <ErrorState error={pipelines.error} onRetry={() => pipelines.refetch()} /> : <LoadingRows />
      ) : view === 'board' ? (
        <BoardView appId={appId} pipelineId={pipelineId} ownerId={ownerId} search={search} />
      ) : (
        <ListView appId={appId} pipelineId={pipelineId} ownerId={ownerId} search={search} />
      )}
      <DealFormDialog appId={appId} open={create} onOpenChange={setCreate} defaults={{ pipeline_id: pipelineId }} />
    </>
  )
}
