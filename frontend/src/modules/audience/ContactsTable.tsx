import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, Columns3, Download, ListPlus, Search, Tag as TagIcon, Trash2, Users, X } from 'lucide-react'
import { audienceApi, aqk, useContacts, useLists, useTags, type BulkAction } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows } from '@/components/page'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
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
import { Input, Select } from '@/components/ui/form-controls'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Checkbox, ConsentDots, Pagination, StatusBadge, TagChip } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { downloadFile } from '@/lib/download'
import { countryFlag } from '@/lib/regions'
import { formatDate, timeAgo } from '@/lib/utils'
import type { ContactFilters } from '@/types/audience'
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
  ['created', 'Created'],
  ['activity', 'Last activity'],
] as const
type ColKey = (typeof COLS)[number][0]
const DEFAULT_COLS: ColKey[] = ['email', 'phone', 'company', 'city', 'tags', 'status', 'consent', 'created']

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

interface Props {
  /** Fixed filters, e.g. a list or segment the table is scoped to. */
  scope?: ContactFilters
  showFilters?: boolean
  emptyAction?: React.ReactNode
  extraBulk?: (ids: string[], clear: () => void) => React.ReactNode
}

export function ContactsTable({ scope = {}, showFilters = true, emptyAction, extraBulk }: Props) {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const api = audienceApi(appId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filters, setFilters] = useState<ContactFilters>({})
  const [sort, setSort] = useState('-created_at')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [allMatching, setAllMatching] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [peek, setPeek] = useState<string | null>(null)
  const [cols, setCols] = usePersisted<ColKey[]>('sc-contact-cols', DEFAULT_COLS)
  const [density, setDensity] = usePersisted<'comfortable' | 'compact'>('sc-density', 'comfortable')
  const show = (k: ColKey) => cols.includes(k)
  const tags = useTags(appId)
  const lists = useLists(appId)
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
  useEffect(() => {
    setPage(1)
    setSelected(new Set())
    setAllMatching(false)
  }, [effective, sort])

  const q = useContacts(appId, { ...effective, page, page_size: PAGE_SIZE, sort })
  const rows = q.data?.items ?? []
  const total = q.data?.total ?? 0
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const count = allMatching ? total : selected.size

  const toggleSort = (field: string) => setSort((s) => (s === field ? `-${field}` : s === `-${field}` ? field : `-${field}`))
  const sortIcon = (field: string) =>
    sort === field ? <ArrowUp className="size-3" /> : sort === `-${field}` ? <ArrowDown className="size-3" /> : null
  const clear = () => {
    setSelected(new Set())
    setAllMatching(false)
  }

  const runBulk = async (action: BulkAction, extra: { tag_id?: string; list_id?: string } = {}) => {
    setBusy(true)
    try {
      const r = await api.bulk({ action, ...extra, ...(allMatching ? { filters: effective } : { contact_ids: [...selected] }) })
      await qc.invalidateQueries({ queryKey: aqk.all(appId) })
      toast.success(action === 'delete' ? `Deleted ${r.affected.toLocaleString()} contacts` : `Updated ${r.matched.toLocaleString()} contacts`)
      clear()
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

  return (
    <div className="rounded-lg border bg-card shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="relative w-full min-w-[220px] sm:w-72 sm:flex-none">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, phone, company" className="pl-8 pr-8" aria-label="Search contacts" data-page-search />
          {!search && <kbd className="pointer-events-none absolute right-2 top-2 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">/</kbd>}
        </div>
        {showFilters && (
          <div className="flex flex-1 flex-wrap gap-2">
            <Select aria-label="Status" value={filters.status ?? ''} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as ContactFilters['status'] }))} className="w-36">
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="unsubscribed">Unsubscribed</option>
              <option value="bounced">Bounced</option>
              <option value="blocked">Blocked</option>
            </Select>
            <Select aria-label="Reachable on" value={filters.eligible_for ?? ''} onChange={(e) => setFilters((f) => ({ ...f, eligible_for: e.target.value as ContactFilters['eligible_for'] }))} className="w-40">
              <option value="">Any reachability</option>
              <option value="email">Reachable by email</option>
              <option value="sms">Reachable by SMS</option>
              <option value="voice">Reachable by voice</option>
            </Select>
            {!scope.tag_id && (
              <Select aria-label="Tag" value={filters.tag_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, tag_id: e.target.value }))} className="w-36">
                <option value="">All tags</option>
                {tags.data?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
            {!scope.list_id && (
              <Select aria-label="List" value={filters.list_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, list_id: e.target.value }))} className="w-36">
                <option value="">All lists</option>
                {lists.data?.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
            <Select aria-label="Country" value={filters.country ?? ''} onChange={(e) => setFilters((f) => ({ ...f, country: e.target.value }))} className="w-36">
              <option value="">All countries</option>
              <option value="IN">🇮🇳 India</option>
              <option value="US">🇺🇸 United States</option>
            </Select>
            {Object.values(filters).some(Boolean) && (
              <Button variant="ghost" size="sm" onClick={() => setFilters({})}>
                <X /> Clear
              </Button>
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
            {COLS.map(([k, label]) => (
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
          <div className="ml-auto flex flex-wrap gap-1.5">
            {write && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={busy}>
                    <TagIcon /> Tag
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Add tag</DropdownMenuLabel>
                  {tags.data?.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">Create tags on the Tags page</div>}
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
                <DropdownMenuContent align="end">
                  {lists.data?.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">Create lists on the Lists page</div>}
                  {lists.data?.map((l) => (
                    <DropdownMenuItem key={l.id} onSelect={() => runBulk('add_to_list', { list_id: l.id })}>
                      {l.name}
                    </DropdownMenuItem>
                  ))}
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
          title={debounced || Object.values(filters).some(Boolean) ? 'No contacts match' : 'No contacts yet'}
          description={debounced || Object.values(filters).some(Boolean) ? 'Try different filters.' : 'Import a file or add contacts one by one.'}
          action={emptyAction}
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
    </div>
  )
}
