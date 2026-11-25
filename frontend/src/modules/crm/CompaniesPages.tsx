import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, Building2, ChevronDown, Globe, Link2, Mail, MapPin, Pencil, Phone, Plus, Receipt, Search, Sparkles, Trash2, Unlink, UserPlus } from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { cqk, crmApi, useCompanies, useCompany, useCompanyContacts, useDeals } from '@/api/crm'
import { EmptyState, ErrorState, FullPageSpinner, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Pagination } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn } from '@/lib/utils'
import { ALL_COUNTRIES, INDIAN_STATES, US_STATES } from '@/lib/regions'
import type { Company, CompanyInput, DuplicateMatch, Ref } from '@/types/crm'
import { ContactPicker, DealFormDialog, LifecycleBadge, OwnerAvatar, OwnerSelect, QuickContactDialog, SectionTitle } from './components'
import { campaignUrl, QuickActions, ReachChips } from './connect'
import { useDebounced } from './hooks'
import { DealStatusBadge } from './DealsPage'
import { COMPANY_SIZES, GST_TREATMENT_LABEL, money, moneyCompact } from './format'
import { RecordActivity } from './Timeline'

type FormState = Record<keyof Omit<CompanyInput, 'attributes' | 'allow_duplicate'>, string>
const FIELDS: (keyof FormState)[] = ['name', 'domain', 'industry', 'size', 'annual_revenue', 'currency', 'phone', 'website', 'gstin', 'pan', 'gst_treatment', 'country', 'state', 'city', 'address', 'postal_code', 'description', 'owner_id']

function toForm(c?: Company | null, country = 'IN'): FormState {
  const f = Object.fromEntries(FIELDS.map((k) => [k, ''])) as FormState
  if (!c) return { ...f, country, currency: country === 'IN' ? 'INR' : country === 'AE' ? 'AED' : 'USD' }
  for (const k of FIELDS) {
    const v = k === 'owner_id' ? c.owner?.id : (c as unknown as Record<string, unknown>)[k]
    f[k] = v === null || v === undefined ? '' : String(v)
  }
  return f
}

export function CompanyFormDialog({ appId, open, onOpenChange, company, onSaved }: { appId: string; open: boolean; onOpenChange: (o: boolean) => void; company?: Company | null; onSaved?: (c: Company) => void }) {
  const qc = useQueryClient()
  const { org } = useWorkspace()
  const [f, setF] = useState<FormState>(() => toForm(company))
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [confirmDupes, setConfirmDupes] = useState<DuplicateMatch[] | null>(null)
  useEffect(() => {
    if (open) {
      setF(toForm(company, org?.country ?? 'IN'))
      setErrors({})
      setConfirmDupes(null)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof FormState, v: string) => setF((x) => ({ ...x, [k]: v }))
  const probe = useDebounced({ name: f.name.trim(), domain: f.domain.trim(), gstin: f.gstin.trim() }, 400)
  const dupes = useQuery({
    queryKey: ['crm', appId, 'dupes', probe, company?.id],
    queryFn: () => crmApi(appId).duplicates({ ...probe, exclude_id: company?.id }),
    enabled: open && (probe.name.length >= 2 || probe.domain.length >= 3 || probe.gstin.length >= 15),
  })
  const india = f.country === 'IN'

  const save = async (allowDuplicate = false) => {
    if (!f.name.trim()) return setErrors({ name: 'Enter a company name' })
    setBusy(true)
    setErrors({})
    const body: CompanyInput = Object.fromEntries(FIELDS.map((k) => [k, f[k].trim() === '' ? null : f[k].trim()])) as CompanyInput
    try {
      const saved = company ? await crmApi(appId).updateCompany(company.id, body) : await crmApi(appId).createCompany({ ...body, allow_duplicate: allowDuplicate })
      await qc.invalidateQueries({ queryKey: cqk.all(appId) })
      toast.success(company ? 'Company saved' : 'Company created')
      setConfirmDupes(null)
      onOpenChange(false)
      onSaved?.(saved)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE' && !company) {
        setConfirmDupes(((e.details as { duplicates?: DuplicateMatch[] })?.duplicates) ?? [])
      } else if (e instanceof ApiError) {
        const field = (e.details as { field?: string } | null)?.field
        setErrors(field ? { [field]: e.message } : e.fieldErrors())
        toast.error(e.message)
      } else toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const base = `/apps/${appId}/crm/companies`
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{company ? 'Edit company' : 'New company'}</DialogTitle>
          <DialogDescription>Companies group contacts and deals. We warn you about likely duplicates as you type.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Field label="Company name" htmlFor="co-name" error={errors.name}>
            <Input id="co-name" autoFocus value={f.name} maxLength={200} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Domain" htmlFor="co-domain" error={errors.domain} hint="e.g. acme.com">
            <Input id="co-domain" value={f.domain} onChange={(e) => set('domain', e.target.value)} />
          </Field>
          {!!dupes.data?.length && (
            <div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-soft p-3 text-sm text-warning-strong sm:col-span-2" role="status" data-testid="dupe-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div>
                Possible duplicate:{' '}
                {dupes.data.map((d, i) => (
                  <span key={d.id}>
                    {i > 0 && ', '}
                    <Link to={`${base}/${d.id}`} className="font-medium underline" onClick={() => onOpenChange(false)}>
                      {d.name}
                    </Link>{' '}
                    (same {d.matched_on})
                  </span>
                ))}
              </div>
            </div>
          )}
          <Field label="Industry" htmlFor="co-industry">
            <Input id="co-industry" value={f.industry} onChange={(e) => set('industry', e.target.value)} />
          </Field>
          <Field label="Size" htmlFor="co-size">
            <Select id="co-size" value={f.size} onChange={(e) => set('size', e.target.value)}>
              <option value="">—</option>
              {COMPANY_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s} employees
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Annual revenue" htmlFor="co-revenue" error={errors.annual_revenue}>
            <div className="flex gap-2">
              <Select aria-label="Currency" value={f.currency} onChange={(e) => set('currency', e.target.value)} className="w-24">
                <option value="INR">INR</option>
                <option value="AED">AED</option>
                <option value="USD">USD</option>
              </Select>
              <Input id="co-revenue" type="number" min={0} value={f.annual_revenue} onChange={(e) => set('annual_revenue', e.target.value)} />
            </div>
          </Field>
          <Field label="Phone" htmlFor="co-phone" error={errors.phone}>
            <Input id="co-phone" type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="Website" htmlFor="co-website">
            <Input id="co-website" value={f.website} onChange={(e) => set('website', e.target.value)} />
          </Field>
          <Field label="Owner" htmlFor="co-owner" hint={company ? undefined : 'Defaults to you.'}>
            <OwnerSelect appId={appId} id="co-owner" value={f.owner_id} onChange={(v) => set('owner_id', v)} noneLabel={company ? 'Unassigned' : 'Me'} />
          </Field>
          <Field label="Country" htmlFor="co-country">
            <Select id="co-country" value={f.country} onChange={(e) => (set('country', e.target.value), set('state', ''))}>
              <option value="">—</option>
              {ALL_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.flag} {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="State" htmlFor="co-state">
            {india || f.country === 'US' ? (
              <Select id="co-state" value={f.state} onChange={(e) => set('state', e.target.value)}>
                <option value="">—</option>
                {(india ? INDIAN_STATES.map((s) => [s, s] as const) : US_STATES).map(([v, l]) => (
                  <option key={v} value={india ? v : l}>
                    {l}
                  </option>
                ))}
              </Select>
            ) : (
              <Input id="co-state" value={f.state} onChange={(e) => set('state', e.target.value)} />
            )}
          </Field>
          <Field label="City" htmlFor="co-city">
            <Input id="co-city" value={f.city} onChange={(e) => set('city', e.target.value)} />
          </Field>
          <Field label="Postal code" htmlFor="co-postal">
            <Input id="co-postal" value={f.postal_code} onChange={(e) => set('postal_code', e.target.value)} />
          </Field>
          <Field label="Address" htmlFor="co-address" className="sm:col-span-2">
            <Input id="co-address" value={f.address} onChange={(e) => set('address', e.target.value)} />
          </Field>
          <fieldset className="grid gap-3 rounded-lg border p-3 sm:col-span-2 sm:grid-cols-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">India tax details</legend>
            <Field label="GSTIN" htmlFor="co-gstin" error={errors.gstin} hint="15 characters">
              <Input id="co-gstin" value={f.gstin} maxLength={15} onChange={(e) => set('gstin', e.target.value.toUpperCase())} placeholder="27AAPFU0939F1ZV" />
            </Field>
            <Field label="PAN" htmlFor="co-pan" error={errors.pan}>
              <Input id="co-pan" value={f.pan} maxLength={10} onChange={(e) => set('pan', e.target.value.toUpperCase())} placeholder="AAPFU0939F" />
            </Field>
            <Field label="GST treatment" htmlFor="co-gst">
              <Select id="co-gst" value={f.gst_treatment} onChange={(e) => set('gst_treatment', e.target.value)}>
                <option value="">—</option>
                {Object.entries(GST_TREATMENT_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
          </fieldset>
          <Field label="Description" htmlFor="co-desc" className="sm:col-span-2">
            <Textarea id="co-desc" rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              {company ? 'Save' : 'Create company'}
            </Button>
          </DialogFooter>
        </form>
        <ConfirmDialog
          open={!!confirmDupes}
          onOpenChange={(o) => !o && setConfirmDupes(null)}
          title="This company may already exist"
          description={
            <span>
              Similar: {confirmDupes?.map((d) => `${d.name} (same ${d.matched_on})`).join(', ') || 'another company'}. Create it anyway?
            </span>
          }
          confirmLabel="Create anyway"
          loading={busy}
          onConfirm={() => void save(true)}
        />
      </DialogContent>
    </Dialog>
  )
}

/** Offers to turn contacts' free-text company names into company records. */
function FromContactsOffer({ appId, compact }: { appId: string; compact?: boolean }) {
  const qc = useQueryClient()
  const { can } = useWorkspace()
  const preview = useQuery({ queryKey: ['crm', appId, 'companies', 'from-contacts'], queryFn: () => crmApi(appId).companiesFromContactsPreview() })
  const [busy, setBusy] = useState(false)
  const n = preview.data?.companies ?? 0
  if (!can('crm.write') || !n) return null
  const run = async () => {
    setBusy(true)
    try {
      const r = await crmApi(appId).companiesFromContacts()
      toast.success(`Created ${r.created} companies and linked ${r.linked} contacts`)
      await Promise.all([qc.invalidateQueries({ queryKey: cqk.all(appId) }), qc.invalidateQueries({ queryKey: ['aud', appId] })])
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={cn('flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm', compact ? 'm-3' : 'mx-auto mt-4 max-w-lg')} data-testid="companies-from-contacts">
      <Sparkles className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        {n} company name{n === 1 ? '' : 's'} on your contacts {n === 1 ? "isn't" : "aren't"} a company record yet.
      </span>
      <Button size="sm" loading={busy} onClick={() => void run()}>
        Create {n} {n === 1 ? 'company' : 'companies'} from your contacts&apos; company names
      </Button>
    </div>
  )
}

export function CompaniesPage() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [searchText, setSearchText] = useState('')
  const search = useDebounced(searchText.trim()) || undefined
  const [sort, setSort] = useState('name')
  const [create, setCreate] = useState(false)
  const q = useCompanies(appId, { search, sort, page, page_size: 25 })
  return (
    <>
      <PageHeader
        title="Companies"
        description="Organizations your contacts work for, with their open deals."
        actions={
          can('crm.write') && (
            <Button onClick={() => setCreate(true)}>
              <Plus /> New company
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative w-full sm:w-auto">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input aria-label="Search companies" placeholder="Search name, domain, GSTIN" value={searchText} onChange={(e) => (setSearchText(e.target.value), setPage(1))} className="w-full pl-8 sm:w-72" />
          </div>
          <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} className="w-full sm:ml-auto sm:w-44">
            <option value="name">Name A–Z</option>
            <option value="-created_at">Newest</option>
            <option value="-annual_revenue">Largest revenue</option>
          </Select>
        </div>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <>
            <EmptyState
              icon={Building2}
              title={search ? 'No companies match' : 'No companies yet'}
              description="Add the businesses you sell to. Link contacts and deals to them."
              action={can('crm.write') && !search && <Button onClick={() => setCreate(true)}><Plus /> New company</Button>}
            />
            {!search && (
              <div className="px-4 pb-6">
                <FromContactsOffer appId={appId} />
              </div>
            )}
          </>
        ) : (
          <>
            {!search && page === 1 && <FromContactsOffer appId={appId} compact />}
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Domain</TH>
                  <TH>Industry</TH>
                  <TH>City</TH>
                  <TH>Owner</TH>
                  <TH className="text-right">Contacts</TH>
                  <TH className="text-right">Open deals</TH>
                </TR>
              </THead>
              <TBody>
                {q.data.items.map((c) => (
                  <TR key={c.id} className="cursor-pointer" onClick={() => navigate(`/apps/${appId}/crm/companies/${c.id}`)}>
                    <TD className="font-medium">
                      <Link to={`/apps/${appId}/crm/companies/${c.id}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                        {c.name}
                      </Link>
                    </TD>
                    <TD className="text-muted-foreground">{c.domain ?? '—'}</TD>
                    <TD className="text-muted-foreground">{c.industry ?? '—'}</TD>
                    <TD className="text-muted-foreground">{c.city ?? '—'}</TD>
                    <TD>
                      <OwnerAvatar owner={c.owner} />
                    </TD>
                    <TD className="text-right tabular-nums">{c.contact_count}</TD>
                    <TD className="text-right tabular-nums">
                      {c.open_deal_count > 0 ? (
                        <span title={money(c.open_deal_value, c.currency)}>
                          {moneyCompact(c.open_deal_value, c.currency)} <span className="text-muted-foreground">· {c.open_deal_count}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={25} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <CompanyFormDialog appId={appId} open={create} onOpenChange={setCreate} onSaved={(c) => navigate(`/apps/${appId}/crm/companies/${c.id}`)} />
    </>
  )
}

function Info({ icon: Icon, label, children }: { icon: typeof Globe; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="break-words text-sm">{children || '—'}</div>
      </div>
    </div>
  )
}

export function CompanyDetailPage() {
  const { companyId } = useParams()
  const { app, can } = useWorkspace()
  const appId = app!.id
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useCompany(appId, companyId!)
  const contacts = useCompanyContacts(appId, companyId!)
  const deals = useDeals(appId, { company_id: companyId, page: 1, page_size: 50 })
  const [edit, setEdit] = useState(false)
  const [del, setDel] = useState(false)
  const [newDeal, setNewDeal] = useState(false)
  const [link, setLink] = useState<Ref | null>(null)
  const [createHere, setCreateHere] = useState<string | null>(null)
  const [openPerson, setOpenPerson] = useState<string | null>(null)
  const suggested = useQuery({ queryKey: [...cqk.companyContacts(appId, companyId!), 'suggested'], queryFn: () => crmApi(appId).suggestedContacts(companyId!) })
  const base = `/apps/${appId}`
  const writable = can('crm.write')
  const audienceWrite = can('audience.write')
  const refreshPeople = () => Promise.all([qc.invalidateQueries({ queryKey: cqk.all(appId) }), qc.invalidateQueries({ queryKey: ['aud', appId] })])
  const linkIds = async (ids: string[], msg = 'Contact linked') => {
    try {
      await crmApi(appId).linkCompanyContacts(companyId!, ids)
      await refreshPeople()
      toast.success(msg)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  if (q.isLoading) return <FullPageSpinner />
  if (q.isError)
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <EmptyState title="Company not found" action={<Button asChild><Link to={`${base}/crm/companies`}>Back to companies</Link></Button>} />
    ) : (
      <ErrorState error={q.error} onRetry={() => q.refetch()} />
    )
  const c = q.data!
  const people = contacts.data ?? []
  const emailable = people.filter((p) => p.reach?.email).map((p) => p.id)

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Companies', to: `${base}/crm/companies` }, { label: c.name }]}
        title={c.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {c.industry && <Badge variant="secondary">{c.industry}</Badge>}
            {c.open_deal_count > 0 && <span>{c.open_deal_count} open deals · {money(c.open_deal_value, c.currency)}</span>}
          </span>
        }
        actions={
          writable && (
            <>
              <Button variant="outline" onClick={() => setEdit(true)}>
                <Pencil /> Edit
              </Button>
              <Button variant="ghost" size="icon" aria-label="Delete company" onClick={() => setDel(true)}>
                <Trash2 />
              </Button>
            </>
          )
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>About</CardTitle>
            </CardHeader>
            <CardContent className="divide-y">
              <Info icon={Globe} label="Domain / website">{[c.domain, c.website].filter(Boolean).join(' · ')}</Info>
              <Info icon={Phone} label="Phone">{c.phone}</Info>
              <Info icon={MapPin} label="Location">{[c.address, c.city, c.state, c.postal_code, c.country].filter(Boolean).join(', ')}</Info>
              <Info icon={Building2} label="Size · revenue">
                {[c.size && `${c.size} employees`, c.annual_revenue !== null && money(c.annual_revenue, c.currency)].filter(Boolean).join(' · ')}
              </Info>
              <Info icon={Receipt} label="GSTIN · PAN · GST treatment">
                {[c.gstin, c.pan, c.gst_treatment && GST_TREATMENT_LABEL[c.gst_treatment]].filter(Boolean).join(' · ')}
              </Info>
              <div className="flex items-center gap-2 py-2 text-sm">
                <OwnerAvatar owner={c.owner} /> {c.owner?.full_name ?? 'Unassigned'}
              </div>
              {c.description && <p className="whitespace-pre-wrap py-2 text-sm text-muted-foreground">{c.description}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <SectionTitle
                action={
                  writable && (
                    <Button size="sm" variant="ghost" onClick={() => setCreateHere('')}>
                      <UserPlus /> Create contact here
                    </Button>
                  )
                }
              >
                Contacts ({people.length})
              </SectionTitle>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {emailable.length ? (
                  <Button size="sm" variant="outline" asChild>
                    <Link to={campaignUrl(appId, 'email', { contact_ids: emailable })} data-testid="email-all-contacts">
                      <Mail /> Email all contacts ({emailable.length})
                    </Link>
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" disabled data-testid="email-all-contacts">
                      <Mail /> Email all contacts
                    </Button>
                    <Badge variant="secondary" className="text-[10px]">
                      {people.length ? 'No one here has email consent' : 'No contacts yet'}
                    </Badge>
                  </>
                )}
              </div>
              {writable && (
                <div className="mb-3 flex gap-2">
                  <div className="min-w-0 flex-1">
                    <ContactPicker appId={appId} value={link} onChange={setLink} placeholder="Link or create a contact" createDefaults={{ company_id: c.id }} />
                  </div>
                  <Button
                    size="sm"
                    className="h-9"
                    disabled={!link}
                    onClick={async () => {
                      await linkIds([link!.id])
                      setLink(null)
                    }}
                  >
                    <Link2 /> Link
                  </Button>
                </div>
              )}
              {!people.length ? (
                <p className="text-sm text-muted-foreground">No contacts linked.</p>
              ) : (
                <ul className="space-y-2" data-testid="company-contacts">
                  {people.map((p) => (
                    <li key={p.id} className="rounded-lg border p-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <Link to={`${base}/audience/contacts/${p.id}`} className="block truncate text-sm font-medium hover:underline">
                            {p.name}
                          </Link>
                          <span className="block truncate text-xs text-muted-foreground">{p.email ?? p.phone ?? ''}</span>
                          <ReachChips reach={p.reach} className="mt-1" />
                        </div>
                        {p.lifecycle_stage && <LifecycleBadge stage={p.lifecycle_stage} />}
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-muted"
                          aria-expanded={openPerson === p.id}
                          aria-label={`Actions for ${p.name}`}
                          onClick={() => setOpenPerson(openPerson === p.id ? null : p.id)}
                        >
                          <ChevronDown className={cn('size-4 transition', openPerson === p.id && 'rotate-180')} />
                        </button>
                        {writable && (
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground hover:bg-muted"
                            aria-label={`Unlink ${p.name}`}
                            title="Unlink from this company"
                            onClick={async () => {
                              try {
                                await crmApi(appId).unlinkCompanyContacts(c.id, [p.id])
                                await refreshPeople()
                                toast.success(`${p.name} unlinked`)
                              } catch (e) {
                                toast.error(errorMessage(e))
                              }
                            }}
                          >
                            <Unlink className="size-3.5" />
                          </button>
                        )}
                      </div>
                      {openPerson === p.id && (
                        <QuickActions
                          className="mt-2"
                          appId={appId}
                          companyId={c.id}
                          company={{ id: c.id, name: c.name }}
                          contact={{ id: p.id, name: p.name, email: p.email, phone: p.phone, reach: p.reach }}
                          crm={writable}
                          write={audienceWrite}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!!suggested.data?.length && (
                <div className="mt-4 border-t pt-3" data-testid="suggested-contacts">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Suggested contacts</h4>
                    {writable && suggested.data.length > 1 && (
                      <Button size="sm" variant="ghost" onClick={() => void linkIds(suggested.data!.map((x) => x.id), `Linked ${suggested.data!.length} contacts`)}>
                        Link all
                      </Button>
                    )}
                  </div>
                  <ul className="space-y-2">
                    {suggested.data.map((x) => (
                      <li key={x.id} className="flex items-center justify-between gap-2 text-sm">
                        <div className="min-w-0">
                          <Link to={`${base}/audience/contacts/${x.id}`} className="block truncate font-medium hover:underline">
                            {x.name}
                          </Link>
                          <span className="block truncate text-xs text-muted-foreground">
                            {x.matched_on === 'domain' ? `Email at ${c.domain}` : `Company: ${x.company ?? c.name}`}
                          </span>
                        </div>
                        {writable && (
                          <Button size="sm" variant="outline" onClick={() => void linkIds([x.id])}>
                            <Link2 /> Link
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <SectionTitle
                action={
                  writable && (
                    <Button size="sm" variant="ghost" onClick={() => setNewDeal(true)}>
                      <Plus /> New deal
                    </Button>
                  )
                }
              >
                Deals
              </SectionTitle>
              {!deals.data?.items.length ? (
                <p className="text-sm text-muted-foreground">No deals yet.</p>
              ) : (
                <ul className="space-y-2">
                  {deals.data.items.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                      <Link to={`${base}/crm/deals/${d.id}`} className="min-w-0 truncate font-medium hover:underline">
                        {d.title}
                      </Link>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="tabular-nums">{moneyCompact(d.amount, d.currency)}</span>
                        <DealStatusBadge status={d.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="min-w-0 lg:col-span-2">
          <RecordActivity appId={appId} target={{ company_id: c.id }} />
        </div>
      </div>
      <CompanyFormDialog appId={appId} open={edit} onOpenChange={setEdit} company={c} />
      <QuickContactDialog
        appId={appId}
        draft={createHere}
        defaults={{ company_id: c.id }}
        onDone={(r) => {
          setCreateHere(null)
          if (r) void refreshPeople()
        }}
      />
      <DealFormDialog appId={appId} open={newDeal} onOpenChange={setNewDeal} defaults={{ company: { id: c.id, name: c.name } }} />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title="Delete this company?"
        description="Contacts and deals stay, but are unlinked from it."
        confirmLabel="Delete company"
        destructive
        onConfirm={async () => {
          try {
            await crmApi(appId).deleteCompany(c.id)
            await qc.invalidateQueries({ queryKey: cqk.all(appId) })
            toast.success('Company deleted')
            navigate(`${base}/crm/companies`, { replace: true })
          } catch (e) {
            toast.error(errorMessage(e))
          }
        }}
      />
    </>
  )
}
