import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, Columns3, Download, Filter, ListPlus, Megaphone, Save, Search, Tag as TagIcon, Trash2, UserCheck, Users, Workflow, X } from 'lucide-react'
import { audienceApi, aqk, useContacts, useLists, useTags, type BulkAction } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { useCrmTeam } from '@/api/crm'
import { EmptyState, ErrorState, LoadingRows } from '@/components/page'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Checkbox, ConsentDots, Pagination, StatusBadge, TagChip } from '@/components/audience'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { downloadFile } from '@/lib/download'
import { countryFlag } from '@/lib/regions'
import { formatDate, timeAgo } from '@/lib/utils'
import type { ContactFilters, SegmentCondition, SegmentGroup } from '@/types/audience'
import { LifecycleBadge, OwnerSelect } from '../crm/components'
import { AddTagDialog, AddToListDialog, campaignUrl, EnrollDialog } from '../crm/connect'
import { LIFECYCLE_LABEL, LIFECYCLES } from '../crm/format'
import { ContactPeek } from './ContactPeek'

const PAGE_SIZE = 25
const COLS = [
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['company', 'Company'],
  ['city', 'Location'],
  ['tags', 'Tags'],
  ['status', 'Status'],
  ['consent', 'Consent'],
  ['owner', 'Owner'],
  ['lifecycle', 'Lifecycle'],
  ['score', 'Lead score'],
  ['created', 'Created'],
  ['activity', 'Last activity'],
] as const
type ColKey = (typeof COLS)[number][0]
const DEFAULT_COLS: ColKey[] = ['email', 'phone', 'company', 'city', 'tags', 'status', 'consent', 'owner', 'lifecycle', 'score', 'created']
const CRM_COLS: ColKey[] = ['owner', 'lifecycle', 'score']
/** Filter keys kept in the URL query (besides q, sort and page). */
const FILTER_KEYS = ['status', 'eligible_for', 'tag_id', 'list_id', 'country', 'owner_id', 'lifecycle_stage', 'min_lead_score'] as const

function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  return [
    v,
    (next: T) => {
      setV(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        /* ignore */
      }
    },
  ]
}

function filtersFromParams(p: URLSearchParams): ContactFilters {
  const f: Record<string, string> = {}
  for (const k of FILTER_KEYS) {
    const v = p.get(k)
    if (v) f[k] = v
  }
  return f as ContactFilters
}

/** Current filters as segment rules. `meId` replaces the "me" owner. */
function filtersToRules(f: ContactFilters, meId?: string): SegmentGroup {
  const cond = (field: string, operator: string, value?: unknown): SegmentCondition => ({ type: 'condition', field, operator, value })
  const conditions: (SegmentCondition | SegmentGroup)[] = []
  if (f.status) conditions.push(cond('status', 'is', f.status))
  if (f.eligible_for) conditions.push(cond('eligible', 'is', f.eligible_for))
  if (f.tag_id) conditions.push(cond('tag', 'has_tag', f.tag_id))
  if (f.list_id) conditions.push(cond('list', 'in_list', f.list_id))
  if (f.country) conditions.push(cond('country', 'is', f.country))
  if (f.owner_id) conditions.push(cond('owner', 'is', f.owner_id === 'me' ? meId : f.owner_id))
  if (f.lifecycle_stage) conditions.push(cond('lifecycle_stage', 'is', f.lifecycle_stage))
  if (f.min_lead_score !== undefined && f.min_lead_score !== '') conditions.push(cond('lead_score', 'gt', Number(f.min_lead_score) - 1))
  if (f.search?.trim()) {
    const t = f.search.trim()
    conditions.push({
      type: 'group',
      match: 'any',
      conditions: ['first_name', 'last_name', 'email', 'company'].map((k) => cond(k, 'contains', t)),
    } as SegmentGroup)
  }
  return { type: 'group', match: 'all', conditions } as SegmentGroup
}

interface Props {
  /** Fixed filters, e.g. a list or segment the table is scoped to. */
  scope?: ContactFilters
  showFilters?: boolean
  emptyAction?: React.ReactNode
  extraBulk?: (ids: string[], clear: () => void) => React.ReactNode
  /** Keep search, filters, sort and page in the URL so reloads and shared links keep them. */
  syncUrl?: boolean
}

export function ContactsTable({ scope = {}, showFilters = true, emptyAction, extraBulk, syncUrl = false }: Props) {
  const { app, can } = useWorkspace()
  const { user } = useAuth()
  const appId = app!.id
  const api = audienceApi(appId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState(() => (syncUrl ? params.get('q') ?? '' : ''))
  const [debounced, setDebounced] = useState(() => (syncUrl ? params.get('q') ?? '' : ''))
  const [filters, setFilters] = useState<ContactFilters>(() => (syncUrl ? filtersFromParams(params) : {}))
  const [sort, setSort] = useState(() => (syncUrl && params.get('sort')) || '-created_at')
  const [page, setPage] = useState(() => (syncUrl ? Math.max(1, Number(params.get('page')) || 1) : 1))
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [allMatching, setAllMatching] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [peek, setPeek] = useState<string | null>(null)
  const [dialog, setDialog] = useState<null | 'tag' | 'list' | 'enroll' | 'owner' | 'lifecycle' | 'segment'>(null)
  const [cols, setCols] = usePersisted<ColKey[]>('sc-contact-cols-v2', DEFAULT_COLS)
  const [density, setDensity] = usePersisted<'comfortable' | 'compact'>('sc-density', 'comfortable')
  const crm = can('crm.read')
  const crmWrite = can('crm.write')
  const show = (k: ColKey) => cols.includes(k) && (crm || !CRM_COLS.includes(k))
  const tags = useTags(appId)
  const lists = useLists(appId)
  const team = useCrmTeam(appId, crm)
  const write = can('audience.write')

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  // Callers often pass an inline object (or the default {}), so key the memo on its content.
  const scopeKey = JSON.stringify(scope)
  const effective = useMemo(
    () => ({ ...filters, ...(JSON.parse(scopeKey) as ContactFilters), search: debounced || undefined }),
    [filters, scopeKey, debounced],
  )
  const effectiveKey = JSON.stringify(effective)
  const [firstRun, setFirstRun] = useState(true)
  useEffect(() => {
    // Keep a page from the URL on first load; any later filter or sort change goes back to page 1.
    if (firstRun) setFirstRun(false)
    else setPage(1)
    setSelected(new Set())
    setAllMatching(false)
  }, [effectiveKey, sort]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!syncUrl) return
    const next = new URLSearchParams(params)
    for (const k of [...FILTER_KEYS, 'q', 'sort', 'page']) next.delete(k)
    for (const k of FILTER_KEYS) {
      const v = filters[k]
      if (v !== undefined && v !== null && v !== '') next.set(k, String(v))
    }
    if (debounced) next.set('q', debounced)
    if (sort !== '-created_at') next.set('sort', sort)
    if (page > 1) next.set('page', String(page))
    if (next.toString() !== params.toString()) setParams(next, { replace: true })
  }, [syncUrl, filters, debounced, sort, page]) // eslint-disable-line react-hooks/exhaustive-deps

  const q = useContacts(appId, { ...effective, page, page_size: PAGE_SIZE, sort })
  const rows = q.data?.items ?? []
  const total = q.data?.total ?? 0
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const count = allMatching ? total : selected.size
  const hasFilters = !!debounced || Object.values(filters).some((v) => v !== undefined && v !== null && v !== '')

  const toggleSort = (field: string) => setSort((s) => (s === field ? `-${field}` : s === `-${field}` ? field : `-${field}`))
  const sortIcon = (field: string) =>
    sort === field ? <ArrowUp className="size-3" /> : sort === `-${field}` ? <ArrowDown className="size-3" /> : null
  const clear = () => {
    setSelected(new Set())
    setAllMatching(false)
  }
  const target = () => (allMatching ? { filters: effective } : { contact_ids: [...selected] })

  const runBulk = async (action: BulkAction, extra: { tag_id?: string; list_id?: string; owner_id?: string | null; lifecycle_stage?: string } = {}) => {
    setBusy(true)
    try {
      const r = await api.bulk({ action, ...extra, ...target() })
      await qc.invalidateQueries({ queryKey: aqk.all(appId) })
      if (action === 'assign_owner' || action === 'set_lifecycle') await qc.invalidateQueries({ queryKey: ['crm', appId] })
      toast.success(action === 'delete' ? `Deleted ${r.affected.toLocaleString()} contacts` : `Updated ${r.matched.toLocaleString()} contacts`)
      clear()
      setDialog(null)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
      setConfirmDelete(false)
    }
  }

  const exportCsv = async () => {
    try {
      await downloadFile(api.exportUrl(effective, allMatching ? undefined : [...selected]), 'contacts.csv')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const sortable = (label: string, field: string) => (
    <button className="inline-flex items-center gap-1 uppercase hover:text-foreground" onClick={() => toggleSort(field)}>
      {label} {sortIcon(field)}
    </button>
  )
  // Campaign links carry explicit ids; "all matching" beyond one page needs a segment instead.
  const selectedIds = [...selected]

  return (
    <div className="rounded-lg border bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="relative w-full min-w-0 sm:w-72 sm:flex-none">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, phone, company" className="pl-8 pr-8" aria-label="Search contacts" data-page-search />
          {!search && <kbd className="pointer-events-none absolute right-2 top-2 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">/</kbd>}
        </div>
        {showFilters && (
          <div className="grid flex-1 grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <Select aria-label="Status" value={filters.status ?? ''} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as ContactFilters['status'] }))} className="sm:w-36">
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="unsubscribed">Unsubscribed</option>
              <option value="bounced">Bounced</option>
              <option value="blocked">Blocked</option>
            </Select>
            <Select aria-label="Reachable on" value={filters.eligible_for ?? ''} onChange={(e) => setFilters((f) => ({ ...f, eligible_for: e.target.value as ContactFilters['eligible_for'] }))} className="sm:w-40">
              <option value="">Any reachability</option>
              <option value="email">Reachable by email</option>
              <option value="sms">Reachable by SMS</option>
              <option value="voice">Reachable by voice</option>
            </Select>
            {!scope.tag_id && (
              <Select aria-label="Tag" value={filters.tag_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, tag_id: e.target.value }))} className="sm:w-36">
                <option value="">All tags</option>
                {tags.data?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
            {!scope.list_id && (
              <Select aria-label="List" value={filters.list_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, list_id: e.target.value }))} className="sm:w-36">
                <option value="">All lists</option>
                {lists.data?.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
            <Select aria-label="Country" value={filters.country ?? ''} onChange={(e) => setFilters((f) => ({ ...f, country: e.target.value }))} className="sm:w-36">
              <option value="">All countries</option>
              <option value="IN">🇮🇳 India</option>
              <option value="US">🇺🇸 United States</option>
            </Select>
            {crm && (
              <>
                <Select aria-label="Owner" value={filters.owner_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, owner_id: e.target.value }))} className="sm:w-40">
                  <option value="">Any owner</option>
                  <option value="me">Owned by me</option>
                  <option value="unassigned">Unassigned</option>
                  {team.data?.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name}
                    </option>
                  ))}
                </Select>
                <Select aria-label="Lifecycle stage" value={filters.lifecycle_stage ?? ''} onChange={(e) => setFilters((f) => ({ ...f, lifecycle_stage: e.target.value }))} className="sm:w-40">
                  <option value="">Any lifecycle</option>
                  {LIFECYCLES.map((l) => (
                    <option key={l} value={l}>
                      {LIFECYCLE_LABEL[l]}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label="Minimum lead score"
                  type="number"
                  placeholder="Min score"
                  value={filters.min_lead_score ?? ''}
                  onChange={(e) => setFilters((f) => ({ ...f, min_lead_score: e.target.value === '' ? '' : Number(e.target.value) }))}
                  className="sm:w-28"
                />
              </>
            )}
            {hasFilters && (
              <span className="col-span-2 flex flex-wrap gap-1 sm:col-span-1">
                {write && !scope.segment_id && !scope.list_id && (
                  <Button variant="outline" size="sm" className="h-9" onClick={() => setDialog('segment')}>
                    <Save /> Save as segment
                  </Button>
                )}
                {Object.values(filters).some(Boolean) && (
                  <Button variant="ghost" size="sm" className="h-9" onClick={() => setFilters({})}>
                    <X /> Clear
                  </Button>
                )}
              </span>
            )}
          </div>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto h-9" aria-label="View options">
              <Columns3 /> View
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>Columns</DropdownMenuLabel>
            {COLS.filter(([k]) => crm || !CRM_COLS.includes(k)).map(([k, label]) => (
              <DropdownMenuCheckboxItem
                key={k}
                checked={show(k)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(v) => setCols(v ? [...cols, k] : cols.filter((x) => x !== k))}
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Density</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={density} onValueChange={(v) => setDensity(v as 'comfortable' | 'compact')}>
              <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setCols(DEFAULT_COLS)}>Reset columns</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {count > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-accent/60 px-4 py-2 text-sm" data-testid="bulk-bar">
          <span className="font-medium">{count.toLocaleString()} selected</span>
          {allOnPage && !allMatching && total > rows.length && (
            <button className="text-primary underline-offset-2 hover:underline" onClick={() => setAllMatching(true)}>
              Select all {total.toLocaleString()} matching
            </button>
          )}
          <div className="flex flex-wrap gap-1.5 sm:ml-auto">
            {write && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={busy}>
                    <TagIcon /> Tag
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                  {!allMatching && <DropdownMenuItem onSelect={() => setDialog('tag')}>+ Create a new tag…</DropdownMenuItem>}
                  {!!tags.data?.length && <DropdownMenuLabel>Add tag</DropdownMenuLabel>}
                  {tags.data?.map((t) => (
                    <DropdownMenuItem key={t.id} onSelect={() => runBulk('add_tag', { tag_id: t.id })}>
                      {t.name}
                    </DropdownMenuItem>
                  ))}
                  {!!tags.data?.length && <DropdownMenuLabel>Remove tag</DropdownMenuLabel>}
                  {tags.data?.map((t) => (
                    <DropdownMenuItem key={`r-${t.id}`} onSelect={() => runBulk('remove_tag', { tag_id: t.id })}>
                      Remove “{t.name}”
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {write && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={busy}>
                    <ListPlus /> Add to list
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                  {lists.data?.map((l) => (
                    <DropdownMenuItem key={l.id} onSelect={() => runBulk('add_to_list', { list_id: l.id })}>
                      {l.name}
                    </DropdownMenuItem>
                  ))}
                  {!allMatching && !!lists.data?.length && <DropdownMenuSeparator />}
                  {!allMatching && <DropdownMenuItem onSelect={() => setDialog('list')}>+ New list…</DropdownMenuItem>}
                  {allMatching && !lists.data?.length && <div className="px-2 py-1.5 text-xs text-muted-foreground">Select contacts on this page to create a new list.</div>}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {crmWrite && (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog('owner')}>
                  <UserCheck /> Assign owner
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog('lifecycle')}>
                  <Filter /> Set lifecycle
                </Button>
              </>
            )}
            {write && !allMatching && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog('enroll')}>
                <Workflow /> Enroll in workflow
              </Button>
            )}
            {!allMatching && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    <Megaphone /> Use in campaign
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link to={campaignUrl(appId, 'email', { contact_ids: selectedIds })}>Email campaign</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to={campaignUrl(appId, 'sms', { contact_ids: selectedIds })}>SMS campaign</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to={campaignUrl(appId, 'voice', { contact_ids: selectedIds })}>Voice campaign</Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {extraBulk?.([...selected], clear)}
            {can('audience.export') && (
              <Button size="sm" variant="outline" onClick={exportCsv}>
                <Download /> Export
              </Button>
            )}
            {write && (
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)} disabled={busy}>
                <Trash2 /> Delete
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={clear} aria-label="Clear selection">
              <X />
            </Button>
          </div>
        </div>
      )}

      {q.isLoading ? (
        <LoadingRows rows={8} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title={hasFilters ? 'No contacts match' : 'No contacts yet'}
          description={hasFilters ? 'Try different filters.' : 'Import a file or add contacts one by one.'}
          action={hasFilters ? <Button variant="outline" onClick={() => { setFilters({}); setSearch('') }}>Clear filters</Button> : emptyAction}
        />
      ) : (
        <>
          <Table className={density === 'compact' ? '[&_td]:py-1.5 [&_th]:h-9' : ''}>
            <THead>
              <TR>
                <TH className="w-10">
                  <Checkbox
                    aria-label="Select all on this page"
                    checked={allOnPage}
                    onChange={(e) => {
                      setAllMatching(false)
                      setSelected((s) => {
                        const n = new Set(s)
                        rows.forEach((r) => (e.target.checked ? n.add(r.id) : n.delete(r.id)))
                        return n
                      })
                    }}
                  />
                </TH>
                <TH>{sortable('Name', 'first_name')}</TH>
                {show('email') && <TH>{sortable('Email', 'email')}</TH>}
                {show('phone') && <TH>Phone</TH>}
                {show('company') && <TH>{sortable('Company', 'company')}</TH>}
                {show('city') && <TH>{sortable('Location', 'city')}</TH>}
                {show('tags') && <TH>Tags</TH>}
                {show('status') && <TH>Status</TH>}
                {show('consent') && <TH>Consent</TH>}
                {show('owner') && <TH>Owner</TH>}
                {show('lifecycle') && <TH>{sortable('Lifecycle', 'lifecycle_stage')}</TH>}
                {show('score') && <TH>{sortable('Score', 'lead_score')}</TH>}
                {show('created') && <TH>{sortable('Created', 'created_at')}</TH>}
                {show('activity') && <TH>{sortable('Last activity', 'last_activity_at')}</TH>}
              </TR>
            </THead>
            <TBody>
              {rows.map((c) => (
                <TR
                  key={c.id}
                  className={`group cursor-pointer ${selected.has(c.id) || allMatching ? 'bg-accent/40' : ''} ${peek === c.id ? 'bg-accent/60' : ''}`}
                  onClick={(e) => (e.ctrlKey || e.metaKey ? navigate(`/apps/${appId}/audience/contacts/${c.id}`) : setPeek(c.id))}
                >
                  <TD onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label={`Select ${c.full_name || c.email || c.phone}`}
                      checked={allMatching || selected.has(c.id)}
                      onChange={(e) => {
                        setAllMatching(false)
                        setSelected((s) => {
                          const n = new Set(s)
                          if (e.target.checked) n.add(c.id)
                          else n.delete(c.id)
                          return n
                        })
                      }}
                    />
                  </TD>
                  <TD className="font-medium">
                    <span className="whitespace-nowrap group-hover:text-primary">{c.full_name || <span className="text-muted-foreground">—</span>}</span>
                  </TD>
                  {show('email') && <TD className="max-w-[220px] truncate text-muted-foreground">{c.email ?? '—'}</TD>}
                  {show('phone') && <TD className="whitespace-nowrap text-muted-foreground">
                    {c.phone_display ? (
                      <>
                        <span className="mr-1">{countryFlag(c.phone_country)}</span>
                        {c.phone_display}
                      </>
                    ) : (
                      '—'
                    )}
                  </TD>}
                  {show('company') && <TD className="max-w-[160px] truncate text-muted-foreground">{c.company ?? '—'}</TD>}
                  {show('city') && <TD className="text-muted-foreground">{[c.city, c.state].filter(Boolean).join(', ') || '—'}</TD>}
                  {show('tags') && <TD>
                    <div className="flex max-w-[180px] flex-wrap gap-1">
                      {c.tags.slice(0, 2).map((t) => (
                        <TagChip key={t.id} name={t.name} color={t.color} />
                      ))}
                      {c.tags.length > 2 && <span className="text-xs text-muted-foreground">+{c.tags.length - 2}</span>}
                    </div>
                  </TD>}
                  {show('status') && <TD>
                    <StatusBadge status={c.status} />
                  </TD>}
                  {show('consent') && <TD>
                    <ConsentDots c={c} />
                  </TD>}
                  {show('owner') && <TD className="whitespace-nowrap text-muted-foreground">{c.owner_name ?? <span className="text-xs">Unassigned</span>}</TD>}
                  {show('lifecycle') && <TD>{c.lifecycle_stage ? <LifecycleBadge stage={c.lifecycle_stage} /> : '—'}</TD>}
                  {show('score') && <TD className="tabular-nums">{c.lead_score ?? 0}</TD>}
                  {show('created') && <TD className="whitespace-nowrap text-muted-foreground">{formatDate(c.created_at)}</TD>}
                  {show('activity') && <TD className="whitespace-nowrap text-muted-foreground">
                    {c.last_activity_at ? timeAgo(c.last_activity_at) : '—'}
                  </TD>}
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
        </>
      )}
      <ContactPeek contactId={peek} onClose={() => setPeek(null)} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${count.toLocaleString()} contacts?`}
        description="Contact data, consent history and activity will be permanently erased. Unsubscribes stay on the suppression list so these people are not contacted again."
        confirmLabel="Delete contacts"
        destructive
        loading={busy}
        onConfirm={() => runBulk('delete')}
      />
      {/* Tag / list dialogs act on explicit ids; with "all matching" use the menu items instead. */}
      <AddTagDialog appId={appId} open={dialog === 'tag'} onOpenChange={(o) => !o && setDialog(null)} contactIds={selectedIds} />
      <AddToListDialog appId={appId} open={dialog === 'list'} onOpenChange={(o) => !o && setDialog(null)} contactIds={selectedIds} />
      <EnrollDialog appId={appId} open={dialog === 'enroll'} onOpenChange={(o) => !o && setDialog(null)} audience={{ contact_ids: selectedIds }} />
      <BulkOwnerDialog appId={appId} open={dialog === 'owner'} count={count} busy={busy} onClose={() => setDialog(null)} onApply={(owner) => runBulk('assign_owner', { owner_id: owner || null })} />
      <BulkLifecycleDialog open={dialog === 'lifecycle'} count={count} busy={busy} onClose={() => setDialog(null)} onApply={(stage) => runBulk('set_lifecycle', { lifecycle_stage: stage })} />
      <SaveSegmentDialog
        appId={appId}
        open={dialog === 'segment'}
        onClose={() => setDialog(null)}
        rules={filtersToRules({ ...filters, search: debounced || undefined }, user?.id)}
      />
    </div>
  )
}

function BulkOwnerDialog({ appId, open, count, busy, onClose, onApply }: { appId: string; open: boolean; count: number; busy: boolean; onClose: () => void; onApply: (owner: string) => void }) {
  const [owner, setOwner] = useState('')
  useEffect(() => {
    if (open) setOwner('')
  }, [open])
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign owner</DialogTitle>
          <DialogDescription>Set the CRM owner of {count.toLocaleString()} contact(s). They’re notified of new leads.</DialogDescription>
        </DialogHeader>
        <Field label="Owner" htmlFor="bulk-owner">
          <OwnerSelect appId={appId} id="bulk-owner" value={owner} onChange={setOwner} noneLabel="Unassigned (remove owner)" />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => onApply(owner)}>
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BulkLifecycleDialog({ open, count, busy, onClose, onApply }: { open: boolean; count: number; busy: boolean; onClose: () => void; onApply: (stage: string) => void }) {
  const [stage, setStage] = useState('lead')
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set lifecycle stage</DialogTitle>
          <DialogDescription>Move {count.toLocaleString()} contact(s) to a lifecycle stage.</DialogDescription>
        </DialogHeader>
        <Field label="Lifecycle stage" htmlFor="bulk-lifecycle">
          <Select id="bulk-lifecycle" value={stage} onChange={(e) => setStage(e.target.value)}>
            {LIFECYCLES.map((l) => (
              <option key={l} value={l}>
                {LIFECYCLE_LABEL[l]}
              </option>
            ))}
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => onApply(stage)}>
            Set stage
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SaveSegmentDialog({ appId, open, onClose, rules }: { appId: string; open: boolean; onClose: () => void; rules: SegmentGroup }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setName('')
  }, [open])
  const save = async () => {
    setBusy(true)
    try {
      const s = await audienceApi(appId).createSegment({ name: name.trim(), rules })
      await qc.invalidateQueries({ queryKey: aqk.segments(appId) })
      toast.success('Segment saved')
      onClose()
      navigate(`/apps/${appId}/audience/segments/${s.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as segment</DialogTitle>
          <DialogDescription>A dynamic segment with these filters. It updates as contacts change, and can be used in campaigns and workflows.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) void save()
          }}
        >
          <Field label="Segment name" htmlFor="seg-name">
            <Input id="seg-name" autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Hot leads in Mumbai" />
          </Field>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              Save segment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
