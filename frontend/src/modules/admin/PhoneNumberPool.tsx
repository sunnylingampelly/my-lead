/** Platform admin: the pool of phone numbers the platform owns and rents to customers. */
import { useEffect, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Phone, Plus, Search } from 'lucide-react'
import { http, errorMessage } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Pagination } from '@/components/audience'
import { useUser } from '@/hooks/useAuth'
import { cn, formatDate } from '@/lib/utils'

interface PoolNumber {
  id: string
  number: string
  country: 'IN' | 'US'
  kind: string
  kind_label: string
  provider: string
  provider_ref: string | null
  status: 'available' | 'assigned' | 'quarantined' | 'retired'
  organization_name: string | null
  application_name: string | null
  assigned_at: string | null
  next_renewal_at: string | null
  available_after: string | null
  created_at: string
}
interface PoolPage {
  items: PoolNumber[]
  total: number
  page: number
  page_size: number
  counts: Record<string, number>
}

const KINDS = { IN: [['series_140', '140-series (promotional)'], ['series_160', '160-series (service)']], US: [['local', 'Local'], ['toll_free', 'Toll-free']] } as const
const STATUS_VARIANT = { available: 'success', assigned: 'default', quarantined: 'warning', retired: 'secondary' } as const

function AddNumbersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const [country, setCountry] = useState<'IN' | 'US'>('IN')
  const [kind, setKind] = useState<string>('series_140')
  const [provider, setProvider] = useState('twilio')
  const [bulk, setBulk] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ added: number; skipped: { number: string; reason: string }[] } | null>(null)
  useEffect(() => {
    if (open) {
      setBulk('')
      setResult(null)
    }
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add numbers to the pool</DialogTitle>
          <DialogDescription>Numbers the platform bought from a provider. One per line; optionally “number, type, provider, provider reference” to override the defaults below.</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Country" htmlFor="pool-country">
              <Select
                id="pool-country"
                value={country}
                onChange={(e) => {
                  const c = e.target.value as 'IN' | 'US'
                  setCountry(c)
                  setKind(KINDS[c][0][0])
                }}
              >
                <option value="IN">India</option>
                <option value="US">United States</option>
              </Select>
            </Field>
            <Field label="Type" htmlFor="pool-kind">
              <Select id="pool-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                {KINDS[country].map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Provider" htmlFor="pool-provider" hint="AI agents need Twilio.">
              <Select id="pool-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="twilio">Twilio</option>
                <option value="exotel">Exotel</option>
                <option value="telnyx">Telnyx</option>
                <option value="simulation">Simulation</option>
              </Select>
            </Field>
          </div>
          <Field label="Numbers" htmlFor="pool-bulk">
            <Textarea id="pool-bulk" rows={8} value={bulk} onChange={(e) => setBulk(e.target.value)} className="font-mono text-xs" placeholder={country === 'IN' ? '+911401234567\n+911401234568, series_140, exotel, EX-123' : '+14155550100\n+18885550100, toll_free, twilio, PN123'} />
          </Field>
          {result && (
            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm" data-testid="pool-result">
              Added {result.added}.{' '}
              {result.skipped.length > 0 && (
                <span className="text-warning-strong">
                  Skipped {result.skipped.length}: {result.skipped.slice(0, 5).map((s) => `${s.number} (${s.reason})`).join('; ')}
                </span>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            loading={busy}
            disabled={!bulk.trim()}
            data-testid="pool-add"
            onClick={async () => {
              setBusy(true)
              try {
                const r = await http.post<{ added: number; skipped: { number: string; reason: string }[] }>('/admin/phone-numbers', { bulk, country, kind, provider })
                setResult(r.data)
                setBulk('')
                await qc.invalidateQueries({ queryKey: ['admin', 'pool'] })
                toast.success(`${r.data.added} number${r.data.added === 1 ? '' : 's'} added`)
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Add numbers
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function PhoneNumberPool() {
  const user = useUser()
  const qc = useQueryClient()
  const [status, setStatus] = useState('')
  const [country, setCountry] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])
  const p = { page, page_size: 25, status, country, search: debounced }
  const q = useQuery({
    queryKey: ['admin', 'pool', p],
    queryFn: async () => (await http.get<PoolPage>('/admin/phone-numbers', { params: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) })).data,
    placeholderData: keepPreviousData,
  })
  const superAdmin = user.platform_role === 'super_admin'
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {(['', 'available', 'assigned', 'quarantined', 'retired'] as const).map((s) => (
          <button
            key={s || 'all'}
            onClick={() => {
              setStatus(s)
              setPage(1)
            }}
            className={cn('rounded-full px-3 py-1.5 text-xs font-medium transition', status === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
          >
            {s ? `${s[0]!.toUpperCase()}${s.slice(1)}` : 'All'}
            {s && q.data?.counts[s] !== undefined ? ` (${q.data.counts[s]})` : ''}
          </button>
        ))}
        <Select className="w-auto" value={country} onChange={(e) => { setCountry(e.target.value); setPage(1) }} aria-label="Country">
          <option value="">All countries</option>
          <option value="IN">India</option>
          <option value="US">United States</option>
        </Select>
        <div className="relative w-full sm:ml-auto sm:w-56">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search number or reference" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search numbers" />
        </div>
        {superAdmin && (
          <Button onClick={() => setAdding(true)} data-testid="pool-add-open">
            <Plus /> Add numbers
          </Button>
        )}
      </div>
      <Card className="min-w-0">
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState icon={Phone} title="No numbers in the pool" description="Add numbers you bought from Twilio, Exotel or Telnyx so customers can rent them. In simulation mode customers get generated test numbers when the pool is empty." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Number</TH>
                    <TH>Type</TH>
                    <TH>Provider</TH>
                    <TH>Status</TH>
                    <TH>Rented by</TH>
                    <TH className="w-10" />
                  </TR>
                </THead>
                <TBody>
                  {q.data.items.map((n) => (
                    <TR key={n.id}>
                      <TD className="font-mono text-sm font-semibold">{n.number}</TD>
                      <TD className="text-xs text-muted-foreground">
                        {n.country} · {n.kind_label}
                      </TD>
                      <TD className="text-xs capitalize">
                        {n.provider}
                        {n.provider_ref && <div className="text-muted-foreground">{n.provider_ref}</div>}
                      </TD>
                      <TD>
                        <Badge variant={STATUS_VARIANT[n.status] ?? 'secondary'}>{n.status}</Badge>
                        {n.available_after && n.status === 'quarantined' && <div className="text-xs text-muted-foreground">until {formatDate(n.available_after)}</div>}
                      </TD>
                      <TD className="text-xs">
                        {n.organization_name ? (
                          <>
                            {n.organization_name}
                            <div className="text-muted-foreground">
                              {n.application_name}
                              {n.next_renewal_at && ` · renews ${formatDate(n.next_renewal_at)}`}
                            </div>
                          </>
                        ) : (
                          '—'
                        )}
                      </TD>
                      <TD>
                        {superAdmin && (n.status === 'available' || n.status === 'quarantined') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              try {
                                await http.post(`/admin/phone-numbers/${n.id}/retire`)
                                await qc.invalidateQueries({ queryKey: ['admin', 'pool'] })
                                toast.success(`${n.number} retired`)
                              } catch (e) {
                                toast.error(errorMessage(e))
                              }
                            }}
                          >
                            Retire
                          </Button>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
            <Pagination page={page} pageSize={25} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <AddNumbersDialog open={adding} onOpenChange={setAdding} />
    </div>
  )
}
