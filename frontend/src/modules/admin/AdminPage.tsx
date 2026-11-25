import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Building2, CheckCircle2, Eye, LifeBuoy, Mail, MessageSquare, PhoneCall, Plus, RotateCw, Search, ShieldAlert, Trash2, Users, Wallet, Workflow, XCircle } from 'lucide-react'
import { adminApi, type AdminOrg, type AdminUser, staffApi, useAdminOrg, useAdminOrgs, useAdminOverview, useAdminSettings, useAdminUsers, useAdminWebhooks, useStaff, useSupportSessions } from '@/api/admin'
import { errorMessage } from '@/api/client'
import { qk } from '@/api/queries'
import { orgApi } from '@/api/services'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { Sheet } from '@/components/ui/sheet'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Pagination, StatCard } from '@/components/audience'
import { useUser } from '@/hooks/useAuth'
import { cn, formatDate, formatDateTime, timeAgo } from '@/lib/utils'
import { formatMoney } from '../sms/format'
import { PhoneNumberPool } from './PhoneNumberPool'

const TABS = [
  ['overview', 'Overview'],
  ['organizations', 'Organizations'],
  ['users', 'Users'],
  ['support', 'Support access'],
  ['staff', 'Platform staff'],
  ['numbers', 'Phone numbers'],
  ['webhooks', 'Webhooks'],
  ['settings', 'Settings'],
] as const

const ROLE_LABEL = { super_admin: 'Super admin', support: 'Support (read-only)' } as const
const useIsSuper = () => useUser().platform_role === 'super_admin'

function useDebounced(v: string) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), 300)
    return () => clearTimeout(t)
  }, [v])
  return d
}

/** Asks for a reason before any action that changes another customer's account. */
function ReasonDialog({ title, description, confirm, destructive, onSubmit, onClose }: { title: string; description: string; confirm: string; destructive?: boolean; onSubmit: (reason: string) => Promise<void>; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Field label="Reason (recorded in the audit log)" htmlFor="reason">
          <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            loading={busy}
            disabled={reason.trim().length < 3}
            onClick={async () => {
              setBusy(true)
              try {
                await onSubmit(reason.trim())
                onClose()
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Overview() {
  const q = useAdminOverview()
  if (q.isLoading) return <Skeleton className="h-48 w-full" />
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const d = q.data
  const wh = d.last_24h.webhooks
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Organizations" value={d.organizations.toLocaleString()} icon={Building2} hint={`${d.suspended_organizations} suspended`} />
        <StatCard label="Users" value={d.users.toLocaleString()} icon={Users} hint={`${d.applications} applications · ${d.contacts.toLocaleString()} contacts`} />
        <StatCard label="Wallet balances" value={Object.entries(d.wallet_balances).map(([c, v]) => formatMoney(v, c)).join(' + ') || '—'} icon={Wallet} hint="Across all organizations" />
        <StatCard label="Failed journeys" value={d.failed_runs.toLocaleString()} icon={Workflow} tone={d.failed_runs ? undefined : 'success'} hint="Runs that hit an error" />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Last 24 hours</CardTitle>
          <CardDescription>Platform mode: {d.communication_mode === 'live' ? 'live, real messages are sent' : 'simulation, nothing is sent'}.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 md:grid-cols-5">
          {[
            [Mail, 'Emails', d.last_24h.emails],
            [MessageSquare, 'Texts', d.last_24h.texts],
            [PhoneCall, 'Calls', d.last_24h.calls],
            [Workflow, 'Journeys started', d.last_24h.journeys],
          ].map(([Icon, label, n]) => {
            const I = Icon as typeof Mail
            return (
              <div key={label as string} className="flex items-center gap-3">
                <I className="size-4 text-muted-foreground" />
                <div>
                  <div className="text-lg font-semibold tabular-nums">{(n as number).toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">{label as string}</div>
                </div>
              </div>
            )
          })}
          <div>
            <div className="text-lg font-semibold tabular-nums">{Object.values(wh).reduce((a, b) => a + b, 0).toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">
              Webhooks{wh.failed ? <span className="text-destructive"> · {wh.failed} failed</span> : ''}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function OpenWorkspaceDialog({ orgId, orgName, onClose }: { orgId: string; orgName: string; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [reason, setReason] = useState('')
  const [minutes, setMinutes] = useState('60')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open {orgName} read-only</DialogTitle>
          <DialogDescription>You see their workspace as they do, but cannot change or export anything. The session is recorded in their audit log and their owners are notified.</DialogDescription>
        </DialogHeader>
        <Field label="Reason (shown to the customer)" htmlFor="sup-reason">
          <Input id="sup-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Ticket 4821: import is failing" />
        </Field>
        <Field label="Duration" htmlFor="sup-min">
          <Select id="sup-min" value={minutes} onChange={(e) => setMinutes(e.target.value)}>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="120">2 hours</option>
            <option value="240">4 hours</option>
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={reason.trim().length < 5}
            onClick={async () => {
              setBusy(true)
              try {
                await staffApi.startSession(orgId, reason.trim(), Number(minutes))
                await qc.invalidateQueries()
                // The organizations list isn't on screen here, so invalidating doesn't refetch it. Fetch it now:
                // the workspace must know about the customer's organization before we open it.
                await qc.fetchQuery({ queryKey: qk.orgs, queryFn: orgApi.list, staleTime: 0 })
                navigate(`/orgs/${orgId}/applications`)
              } catch (e) {
                toast.error(errorMessage(e))
                setBusy(false)
              }
            }}
          >
            <Eye /> Open read-only
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function OrgDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useAdminOrg(id)
  const qc = useQueryClient()
  const isSuper = useIsSuper()
  const [openWs, setOpenWs] = useState(false)
  const [action, setAction] = useState<'suspend' | 'reactivate' | null>(null)
  const [adjust, setAdjust] = useState(false)
  const [form, setForm] = useState({ kind: 'credit', amount: '', reason: '' })
  const [busy, setBusy] = useState(false)
  const o = q.data
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] })
  return (
    <Sheet open={!!id} onOpenChange={(open) => { if (!open) onClose() }} title={o?.name ?? 'Organization'} description={o ? `${o.slug} · created ${formatDate(o.created_at)}` : undefined}>
      {!o ? (
        <LoadingRows />
      ) : (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={o.status === 'active' ? 'success' : 'destructive'}>{o.status}</Badge>
            {o.country && <Badge variant="secondary">{o.country}</Badge>}
            <span className="ml-auto flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setOpenWs(true)}>
                <Eye /> Open read-only
              </Button>
              {isSuper && (
                <>
                  <Button size="sm" variant={o.status === 'active' ? 'outline' : 'default'} onClick={() => setAction(o.status === 'active' ? 'suspend' : 'reactivate')}>
                    {o.status === 'active' ? 'Suspend' : 'Reactivate'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setAdjust((v) => !v)}>
                    <Wallet /> Adjust wallet
                  </Button>
                </>
              )}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 rounded-lg border p-3">
            <div>
              <div className="text-xs text-muted-foreground">Balance</div>
              <div className="font-semibold tabular-nums">{formatMoney(o.wallet.balance, o.wallet.currency)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Available</div>
              <div className="font-semibold tabular-nums">{formatMoney(o.wallet.available, o.wallet.currency)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Held</div>
              <div className="font-semibold tabular-nums">{formatMoney(o.wallet.held, o.wallet.currency)}</div>
            </div>
          </div>
          {adjust && (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3" data-testid="adjust-form">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Type" htmlFor="adj-kind">
                  <Select id="adj-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                    <option value="credit">Credit (+)</option>
                    <option value="refund">Refund (+)</option>
                    <option value="adjustment">Adjustment (+ or −)</option>
                  </Select>
                </Field>
                <Field label={`Amount (${o.wallet.currency})`} htmlFor="adj-amount">
                  <Input id="adj-amount" type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                </Field>
              </div>
              <Field label="Reason" htmlFor="adj-reason">
                <Input id="adj-reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} maxLength={200} />
              </Field>
              <Button
                size="sm"
                loading={busy}
                disabled={!Number(form.amount) || form.reason.trim().length < 3}
                onClick={async () => {
                  setBusy(true)
                  try {
                    const r = await adminApi.adjustWallet(o.id, { kind: form.kind, amount: Number(form.amount).toFixed(2), reason: form.reason.trim() })
                    toast.success(`Balance is now ${formatMoney(r.balance, r.currency)}`)
                    setForm({ kind: 'credit', amount: '', reason: '' })
                    setAdjust(false)
                    await refresh()
                  } catch (e) {
                    toast.error(errorMessage(e))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Apply
              </Button>
            </div>
          )}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Members</div>
            <ul className="space-y-1">
              {o.members.map((m) => (
                <li key={m.id} className="flex justify-between gap-2">
                  <span className="truncate">
                    {m.name} <span className="text-muted-foreground">{m.email}</span>
                  </span>
                  <Badge variant="secondary">{m.role.replace('_', ' ')}</Badge>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Applications</div>
            <ul className="space-y-1">
              {o.applications.map((a) => (
                <li key={a.id} className="flex justify-between">
                  <span>{a.name}</span>
                  <span className="text-muted-foreground">{a.country ?? '—'}</span>
                </li>
              ))}
              {!o.applications.length && <li className="text-muted-foreground">None</li>}
            </ul>
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent wallet entries</div>
            <ul className="space-y-1">
              {o.transactions.map((t) => (
                <li key={t.id} className="flex justify-between gap-2">
                  <span className="truncate text-muted-foreground">{t.description}</span>
                  <span className={cn('tabular-nums', t.amount > 0 && 'text-success-strong')}>{t.amount > 0 ? '+' : '−'}{formatMoney(Math.abs(t.amount), o.wallet.currency)}</span>
                </li>
              ))}
            </ul>
          </div>
          {openWs && <OpenWorkspaceDialog orgId={o.id} orgName={o.name} onClose={() => setOpenWs(false)} />}
          {action && (
            <ReasonDialog
              title={action === 'suspend' ? `Suspend ${o.name}?` : `Reactivate ${o.name}?`}
              description={action === 'suspend' ? 'Members lose access straight away and nothing is sent until it is reactivated.' : 'Members regain access immediately.'}
              confirm={action === 'suspend' ? 'Suspend' : 'Reactivate'}
              destructive={action === 'suspend'}
              onClose={() => setAction(null)}
              onSubmit={async (reason) => {
                await adminApi.setOrgStatus(o.id, action, reason)
                await refresh()
                toast.success(action === 'suspend' ? 'Organization suspended' : 'Organization reactivated')
              }}
            />
          )}
        </div>
      )}
    </Sheet>
  )
}

function Organizations() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<string | null>(null)
  const debounced = useDebounced(search)
  const q = useAdminOrgs({ page, page_size: 25, search: debounced || undefined, status: status || undefined })
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        {[['', 'All'], ['active', 'Active'], ['suspended', 'Suspended']].map(([k, l]) => (
          <button key={k} onClick={() => { setStatus(k!); setPage(1) }} className={cn('rounded-full px-3 py-1.5 text-xs font-medium transition', status === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
            {l}
          </button>
        ))}
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search organizations" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} aria-label="Search organizations" />
        </div>
      </div>
      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data?.items.length ? (
        <EmptyState icon={Building2} title="No organizations match" description="Try another search." />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Organization</TH>
                <TH>Status</TH>
                <TH className="text-right">Members</TH>
                <TH className="text-right">Apps</TH>
                <TH className="text-right">Wallet</TH>
                <TH>Created</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((o: AdminOrg) => (
                <TR key={o.id} className="cursor-pointer" onClick={() => setOpen(o.id)} data-testid="admin-org-row">
                  <TD>
                    <div className="font-medium">{o.name}</div>
                    <div className="text-xs text-muted-foreground">{o.slug}</div>
                  </TD>
                  <TD>
                    <Badge variant={o.status === 'active' ? 'success' : 'destructive'}>{o.status}</Badge>
                  </TD>
                  <TD className="text-right tabular-nums">{o.members}</TD>
                  <TD className="text-right tabular-nums">{o.applications}</TD>
                  <TD className="text-right tabular-nums">{o.wallet ? formatMoney(o.wallet.balance, o.wallet.currency) : '—'}</TD>
                  <TD className="text-xs text-muted-foreground">{formatDate(o.created_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={25} total={q.data.total} onPage={setPage} />
        </>
      )}
      <OrgDetail id={open} onClose={() => setOpen(null)} />
    </Card>
  )
}

function UsersTab() {
  const me = useUser()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [target, setTarget] = useState<AdminUser | null>(null)
  const debounced = useDebounced(search)
  const q = useAdminUsers({ page, page_size: 25, search: debounced || undefined })
  return (
    <Card>
      <div className="flex border-b p-3">
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search name or email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} aria-label="Search users" />
        </div>
      </div>
      {q.isLoading ? (
        <LoadingRows />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>User</TH>
                <TH>Status</TH>
                <TH className="text-right">Orgs</TH>
                <TH>Last sign-in</TH>
                <TH className="w-28" />
              </TR>
            </THead>
            <TBody>
              {q.data?.items.map((u) => (
                <TR key={u.id}>
                  <TD>
                    <div className="font-medium">
                      {u.name} {u.is_platform_admin && <Badge variant="default">Admin</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                  </TD>
                  <TD>
                    {u.is_active ? <Badge variant="success">Active</Badge> : <Badge variant="destructive">Suspended</Badge>}
                    {!u.email_verified && <Badge variant="warning" className="ml-1">Unverified</Badge>}
                  </TD>
                  <TD className="text-right tabular-nums">{u.organizations}</TD>
                  <TD className="text-xs text-muted-foreground">{u.last_login_at ? timeAgo(u.last_login_at) : 'Never'}</TD>
                  <TD>
                    {u.id !== me.id && me.platform_role === 'super_admin' && (
                      <Button size="sm" variant="outline" onClick={() => setTarget(u)}>
                        {u.is_active ? 'Suspend' : 'Reactivate'}
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {q.data && <Pagination page={page} pageSize={25} total={q.data.total} onPage={setPage} />}
        </>
      )}
      {target && (
        <ReasonDialog
          title={target.is_active ? `Suspend ${target.name}?` : `Reactivate ${target.name}?`}
          description={target.is_active ? 'They are signed out everywhere immediately and cannot sign in.' : 'They can sign in again.'}
          confirm={target.is_active ? 'Suspend' : 'Reactivate'}
          destructive={target.is_active}
          onClose={() => setTarget(null)}
          onSubmit={async (reason) => {
            await adminApi.setUserActive(target.id, target.is_active ? 'suspend' : 'reactivate', reason)
            await qc.invalidateQueries({ queryKey: ['admin'] })
          }}
        />
      )}
    </Card>
  )
}

function Webhooks() {
  const qc = useQueryClient()
  const isSuper = useIsSuper()
  const [status, setStatus] = useState('failed')
  const [page, setPage] = useState(1)
  const q = useAdminWebhooks({ page, page_size: 25, status: status || undefined })
  return (
    <Card>
      <div className="flex flex-wrap gap-1 border-b p-3">
        {[['failed', 'Failed'], ['ignored', 'Ignored'], ['received', 'Waiting'], ['processed', 'Processed'], ['', 'All']].map(([k, l]) => (
          <button key={k} onClick={() => { setStatus(k!); setPage(1) }} className={cn('rounded-full px-3 py-1.5 text-xs font-medium transition', status === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
            {l}
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data?.items.length ? (
        <EmptyState icon={CheckCircle2} title="Nothing here" description="Provider callbacks with this status appear here." />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Provider</TH>
                <TH>Event</TH>
                <TH>Status</TH>
                <TH>Detail</TH>
                <TH>Received</TH>
                <TH className="w-24" />
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((w) => (
                <TR key={w.id}>
                  <TD className="text-sm">
                    {w.provider} <span className="text-xs text-muted-foreground">({w.channel})</span>
                  </TD>
                  <TD className="text-sm">{w.event_type ?? '—'}</TD>
                  <TD>
                    <Badge variant={w.status === 'processed' ? 'success' : w.status === 'failed' ? 'destructive' : 'secondary'}>{w.status}</Badge>
                  </TD>
                  <TD className="max-w-xs truncate text-xs text-muted-foreground">{w.error ?? ''}</TD>
                  <TD className="text-xs text-muted-foreground">{formatDateTime(w.received_at)}</TD>
                  <TD>
                    {w.status !== 'processed' && isSuper && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            const r = await adminApi.retryWebhook(w.id)
                            toast.success(`Retried: ${r.status}`)
                            await qc.invalidateQueries({ queryKey: ['admin', 'webhooks'] })
                          } catch (e) {
                            toast.error(errorMessage(e))
                          }
                        }}
                      >
                        <RotateCw /> Retry
                      </Button>
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
  )
}

function SupportTab() {
  const q = useSupportSessions()
  const qc = useQueryClient()
  const me = useUser()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Support access</CardTitle>
        <CardDescription>Read-only sessions staff opened into customer workspaces. Start one from an organization’s details.</CardDescription>
      </CardHeader>
      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data?.length ? (
        <EmptyState icon={LifeBuoy} title="No support sessions yet" description="Open an organization and choose “Open read-only” to help a customer." />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Organization</TH>
              <TH>Staff</TH>
              <TH>Reason</TH>
              <TH>Status</TH>
              <TH className="w-24" />
            </TR>
          </THead>
          <TBody>
            {q.data.map((g) => (
              <TR key={g.id}>
                <TD className="font-medium">{g.organization}</TD>
                <TD className="text-sm">{g.user}</TD>
                <TD className="max-w-xs truncate text-sm text-muted-foreground">{g.reason}</TD>
                <TD className="text-xs">{g.active ? <Badge variant="warning">Active until {formatDateTime(g.expires_at)}</Badge> : <span className="text-muted-foreground">Ended · {formatDateTime(g.created_at)}</span>}</TD>
                <TD>
                  {g.active && (me.platform_role === 'super_admin' || g.user === me.full_name) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          await staffApi.endSession(g.id)
                          await qc.invalidateQueries()
                        } catch (e) {
                          toast.error(errorMessage(e))
                        }
                      }}
                    >
                      End
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  )
}

function StaffTab() {
  const q = useStaff()
  const qc = useQueryClient()
  const me = useUser()
  const isSuper = me.platform_role === 'super_admin'
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('support')
  const [busy, setBusy] = useState(false)
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'staff'] })
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn()
      await refresh()
      toast.success(msg)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Platform staff</CardTitle>
          <CardDescription>Super admins run the platform. Support staff can look at everything and open read-only sessions, but cannot change anything.</CardDescription>
        </CardHeader>
        {isSuper && (
          <CardContent className="flex flex-wrap items-end gap-3 border-b pb-5">
            <Field label="Email of an existing account" htmlFor="staff-email" className="min-w-64 flex-1">
              <Input id="staff-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@yourcompany.com" />
            </Field>
            <Field label="Role" htmlFor="staff-role">
              <Select id="staff-role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="support">Support (read-only)</option>
                <option value="super_admin">Super admin</option>
              </Select>
            </Field>
            <Button
              loading={busy}
              disabled={!email.includes('@')}
              onClick={async () => {
                setBusy(true)
                await act(() => staffApi.add(email.trim(), role), `${email} added`)
                setEmail('')
                setBusy(false)
              }}
            >
              <Plus /> Add staff
            </Button>
          </CardContent>
        )}
        {q.isLoading ? (
          <LoadingRows />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Person</TH>
                <TH>Role</TH>
                <TH>Last sign-in</TH>
                <TH className="w-56" />
              </TR>
            </THead>
            <TBody>
              {q.data?.map((m) => (
                <TR key={m.id} data-testid="staff-row">
                  <TD>
                    <div className="font-medium">
                      {m.name} {m.id === me.id && <span className="text-xs text-muted-foreground">(you)</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">{m.email}</div>
                  </TD>
                  <TD>
                    <Badge variant={m.role === 'super_admin' ? 'default' : 'secondary'}>{ROLE_LABEL[m.role]}</Badge>
                  </TD>
                  <TD className="text-xs text-muted-foreground">{m.last_login_at ? timeAgo(m.last_login_at) : 'Never'}</TD>
                  <TD>
                    {isSuper && m.id !== me.id && (
                      <span className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => act(() => staffApi.change(m.id, m.role === 'super_admin' ? 'support' : 'super_admin'), 'Role updated')}>
                          Make {m.role === 'super_admin' ? 'support' : 'super admin'}
                        </Button>
                        <Button size="icon" variant="ghost" aria-label={`Remove ${m.name}`} onClick={() => act(() => staffApi.remove(m.id), `${m.name} removed`)}>
                          <Trash2 />
                        </Button>
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">The platform always keeps at least one super admin. To create the first one on a new server, run <code className="rounded bg-muted px-1">python -m app.cli create-superadmin you@example.com &quot;Your Name&quot;</code>.</p>
    </div>
  )
}

function SettingsTab() {
  const q = useAdminSettings()
  if (q.isLoading) return <Skeleton className="h-48 w-full" />
  if (!q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const d = q.data
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Platform</CardTitle>
          <CardDescription>Set through environment variables. Secrets are never shown here.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(['environment', 'communication_mode', 'queue', 'storage', 'public_url'] as const).map((k) => (
            <div key={k} className="flex justify-between gap-3">
              <span className="text-muted-foreground">{k.replace('_', ' ')}</span>
              <span className="font-mono text-xs">{String(d[k])}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Providers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {Object.entries(d.providers).map(([group, items]) => (
            <div key={group}>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(items).map(([name, ok]) => (
                  <span key={name} className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs" data-testid={`provider-${group}-${name}`}>
                    {ok ? <CheckCircle2 className="size-3.5 text-success-strong" /> : <XCircle className="size-3.5 text-muted-foreground" />}
                    {name.replace('_', ' ')}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      {d.backups && (
        <Card data-testid="backup-status">
          <CardHeader>
            <CardTitle>Database backups</CardTitle>
            <CardDescription>Written by scripts/backup_db.py (see docs/operations.md).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              {d.backups.stale
                ? <XCircle className="size-4 shrink-0 text-danger-strong" />
                : <CheckCircle2 className="size-4 shrink-0 text-success-strong" />}
              <span>
                {d.backups.last_backup_at
                  ? <>Last backup {formatDateTime(d.backups.last_backup_at)} ({d.backups.age_hours}h ago){d.backups.stale && ' — older than a day'}</>
                  : 'No backups found'}
              </span>
            </div>
            {d.backups.last_backup_file && (
              <div className="truncate font-mono text-xs text-muted-foreground">
                {d.backups.last_backup_file} · {((d.backups.last_backup_bytes ?? 0) / 1048576).toFixed(1)} MB · {d.backups.count} kept
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export function AdminPage() {
  const user = useUser()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as (typeof TABS)[number][0]) || 'overview'
  if (!user.platform_role) return <Navigate to="/" replace />
  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Platform admin' }]} title="Platform admin" description="Every organization on this platform. All changes are recorded in the audit log." />
      <div className="mb-6 flex items-center gap-2 rounded-lg border border-warning-border bg-warning-soft px-4 py-2 text-sm text-warning-strong" data-testid="platform-role">
        <ShieldAlert className="size-4" /> Signed in as {ROLE_LABEL[user.platform_role]}.
        {user.platform_role === 'support' && ' You can view everything and open read-only sessions, but not make changes.'}
      </div>
      <nav className="mb-6 flex flex-wrap gap-1 rounded-lg border bg-card p-1" aria-label="Admin sections">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setParams(k === 'overview' ? {} : { tab: k })} className={cn('rounded-md px-3 py-1.5 text-sm font-medium transition', tab === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'overview' && <Overview />}
      {tab === 'organizations' && <Organizations />}
      {tab === 'users' && <UsersTab />}
      {tab === 'support' && <SupportTab />}
      {tab === 'staff' && <StaffTab />}
      {tab === 'numbers' && <PhoneNumberPool />}
      {tab === 'webhooks' && <Webhooks />}
      {tab === 'settings' && <SettingsTab />}
    </>
  )
}
