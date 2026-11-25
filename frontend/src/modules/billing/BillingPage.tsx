import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { CalendarClock, Check, CheckCircle2, CreditCard, Download, FlaskConical, Loader2, Lock, Plus, Sparkles, TrendingDown, TriangleAlert, Undo2, Wallet } from 'lucide-react'
import { billingApi, type BillingScope, bqk, type PlanKey, useBilling, useBillingProfile, usePlan, useTransactions } from '@/api/billing'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BillingDetailsCard, GstBreakdown, InvoicesCard, StatementsCard } from './TaxDocuments'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Pagination, StatCard } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { downloadFile } from '@/lib/download'
import { cn, formatDateTime } from '@/lib/utils'
import { formatMoney } from '../sms/format'
import { CountryFlag } from '@/components/CountryFlag'
import { countryName } from '@/lib/regions'

const TYPE_LABEL: Record<string, string> = {
  trial_credit: 'Trial credit',
  test_credit: 'Test credit',
  credit: 'Credit',
  usage: 'Usage',
  adjustment: 'Adjustment',
  refund: 'Refund',
  subscription: 'Plan',
  recurring: 'Recurring',
}
const DEBIT_TYPES = new Set(['usage', 'subscription', 'recurring'])
const LIMIT_LABEL: Record<string, string> = {
  applications: 'Applications',
  members: 'Team members',
  contacts: 'Contacts',
  voice_agents: 'AI calling agents',
  lead_forms: 'Lead forms',
  chatbots: 'Website chatbots',
  chat_seats: 'Live-chat agents',
  ai_assistant_messages_per_day: 'AI Assistant messages today',
  ai_agent_runs_per_day: 'AI agent runs today',
}
const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const full = limit !== null && used >= limit
  return (
    <div className="min-w-0" data-testid={`meter-${label}`}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="truncate">{label}</span>
        <span className={cn('shrink-0 tabular-nums text-xs', full ? 'font-medium text-danger-strong' : 'text-muted-foreground')}>
          {used.toLocaleString()} / {limit === null ? 'Unlimited' : limit.toLocaleString()}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', full ? 'bg-destructive' : pct >= 80 ? 'bg-warning' : 'bg-primary')} style={{ width: limit === null ? '0%' : `${pct}%` }} />
      </div>
    </div>
  )
}

function PlanSection({ orgId, onAddCredit }: { orgId: string; onAddCredit: (() => void) | null }) {
  const qc = useQueryClient()
  const scope: BillingScope = { kind: 'org', id: orgId }
  const q = usePlan(orgId)
  const [confirm, setConfirm] = useState<PlanKey | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (q.data && window.location.hash === '#plan') document.getElementById('plan')?.scrollIntoView({ block: 'start' })
  }, [q.data])
  const p = q.data
  if (q.isLoading) return <Skeleton className="h-72 w-full" />
  if (!p) return null
  const cur = p.currency
  const pro = p.catalogue.find((c) => c.key === 'pro')!
  const periodEnd = p.current_period_end ? formatDate(p.current_period_end) : null
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: bqk.all })
      toast.success(done)
      setConfirm(null)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const proStarts = new Date()
  const proEnds = new Date(proStarts)
  proEnds.setMonth(proEnds.getMonth() + 1)
  return (
    <section id="plan" className="scroll-mt-20 space-y-4" data-testid="plan-section">
      {p.status === 'past_due' && (
        <div className="flex flex-col gap-3 rounded-lg border border-warning-border bg-warning-soft px-4 py-3 text-sm text-warning-strong sm:flex-row sm:items-center" data-testid="plan-past-due">
          <TriangleAlert className="hidden size-4 shrink-0 sm:block" />
          <div className="min-w-0 flex-1">
            <strong>Pro renewal is past due.</strong> Your wallet could not cover {formatMoney(pro.price, cur)}. We retry automatically
            {p.grace_ends_at ? `; add credit before ${formatDate(p.grace_ends_at)} to stay on Pro.` : '.'}
          </div>
          {onAddCredit && (
            <Button size="sm" onClick={onAddCredit}>
              <Plus /> Add credit
            </Button>
          )}
        </div>
      )}
      {p.scheduled_plan && (
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 px-4 py-3 text-sm sm:flex-row sm:items-center" data-testid="plan-scheduled">
          <CalendarClock className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
          <div className="min-w-0 flex-1">
            You switch to <strong>Starter</strong> on {p.scheduled_change_at ? formatDate(p.scheduled_change_at) : 'the end of this period'}. Pro stays active until then.
          </div>
          {p.can_manage && (
            <Button size="sm" variant="outline" loading={busy} onClick={() => run(() => billingApi.cancelPlanChange(scope), 'You stay on Pro')}>
              <Undo2 /> Keep Pro
            </Button>
          )}
        </div>
      )}
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              Plan
              <Badge variant={p.plan === 'pro' ? 'default' : 'secondary'} data-testid="current-plan">
                {p.plan === 'pro' && <Sparkles className="size-3" />} {p.name}
              </Badge>
              <Badge variant={p.status === 'past_due' ? 'warning' : 'success'}>{p.status === 'past_due' ? 'Past due' : 'Active'}</Badge>
            </CardTitle>
            <CardDescription>Plan fees and every charge come from your {cur} wallet. No card on file, no surprises.</CardDescription>
          </div>
          <div className="text-sm sm:text-right" data-testid="next-charge">
            {p.next_charge.date ? (
              <>
                <div className="text-muted-foreground">Next renewal</div>
                <div className="font-medium tabular-nums">
                  {formatMoney(p.next_charge.total, cur)} on {formatDate(p.next_charge.date)}
                </div>
              </>
            ) : p.scheduled_plan && periodEnd ? (
              <div className="text-muted-foreground">No renewal: Pro ends {periodEnd}</div>
            ) : (
              <div className="text-muted-foreground">No monthly plan fee</div>
            )}
            {p.recurring.numbers > 0 && <div className="text-xs text-muted-foreground">Includes {formatMoney(p.recurring.numbers, cur)} phone number rental (last 30 days)</div>}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="plan-compare">
            {p.catalogue.map((c) => {
              const current = c.key === p.plan
              return (
                <div key={c.key} className={cn('flex min-w-0 flex-col rounded-xl border p-4', current && 'border-primary ring-1 ring-primary/30')} data-testid={`plan-card-${c.key}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-semibold">
                        {c.name}
                        {current && <Badge variant="outline">Current</Badge>}
                      </div>
                      <p className="text-sm text-muted-foreground">{c.tagline}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xl font-semibold tabular-nums" data-testid={`plan-price-${c.key}`}>
                        {c.price ? formatMoney(c.price, cur) : 'Free'}
                        {c.price > 0 && <span className="text-sm font-normal text-muted-foreground">/month{cur === 'INR' ? ' + GST' : ''}</span>}
                      </div>
                      {c.price > 0 && cur === 'INR' && <div className="text-xs text-muted-foreground">GST is charged when you add credit</div>}
                      {c.price > 0 && cur === 'AED' && <div className="text-xs text-muted-foreground">No UAE VAT charged (reverse charge)</div>}
                    </div>
                  </div>
                  <ul className="mt-3 flex-1 space-y-1.5 text-sm">
                    {c.features.map((f) => (
                      <li key={f} className="flex gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-success-strong" />
                        <span className="min-w-0">{f}</span>
                      </li>
                    ))}
                  </ul>
                  {p.can_manage && c.key === 'pro' && (p.plan === 'starter' || p.status === 'past_due') && (
                    <Button className="mt-4 w-full" onClick={() => setConfirm('pro')} data-testid="upgrade-pro">
                      <Sparkles /> {p.status === 'past_due' ? 'Pay and stay on Pro' : 'Upgrade to Pro'}
                    </Button>
                  )}
                  {p.can_manage && c.key === 'starter' && p.plan === 'pro' && !p.scheduled_plan && (
                    <Button variant="outline" className="mt-4 w-full" onClick={() => setConfirm('starter')} data-testid="switch-starter">
                      Switch to Starter
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
          <div>
            <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Usage and limits</div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="plan-usage">
              {Object.keys(p.limits)
                .filter((k) => k in p.usage)
                .map((k) => (
                  <UsageMeter key={k} label={LIMIT_LABEL[k] ?? k} used={p.usage[k]} limit={p.limits[k]} />
                ))}
            </div>
          </div>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirm === 'pro'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={p.status === 'past_due' ? 'Pay the Pro renewal' : 'Upgrade to Pro'}
        description={
          <>
            <strong>{formatMoney(pro.price, cur)}</strong> will be charged from your wallet now
            {p.status === 'past_due' ? ' for the overdue month' : ` for ${formatDate(proStarts.toISOString())} – ${formatDate(proEnds.toISOString())}`}. Pro then renews monthly from the wallet; you can switch back to
            Starter any time. Available now: {formatMoney(p.available, cur)}.
          </>
        }
        confirmLabel={`Pay ${formatMoney(pro.price, cur)}`}
        loading={busy}
        onConfirm={() => run(() => billingApi.changePlan(scope, 'pro'), 'You are on Pro')}
      >
        {p.available < pro.price && (
          <p className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-strong">
            Your available balance is too low. Add credit first.
          </p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'starter'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Switch to Starter"
        description={
          p.status === 'past_due'
            ? 'Nothing is charged. You move to Starter now, with standard usage rates and Starter limits.'
            : `Nothing is charged now. You keep Pro until ${periodEnd ?? 'the end of this period'}, then move to Starter with standard usage rates and Starter limits. You can undo this until then.`
        }
        confirmLabel="Switch to Starter"
        loading={busy}
        onConfirm={() => run(() => billingApi.changePlan(scope, 'starter'), p.status === 'past_due' ? 'You are on Starter' : 'Switch to Starter scheduled')}
      />
    </section>
  )
}
const CHANNEL_LABEL: Record<string, string> = { email: 'Email', sms: 'SMS', voice: 'Voice', chat: 'Chatbot' }

function TopUpDialog({ scope, currency, open, onOpenChange }: { scope: BillingScope; currency: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const presets = currency === 'INR' ? [500, 2000, 10000] : currency === 'AED' ? [50, 200, 700] : [10, 50, 200]
  const [amount, setAmount] = useState(String(presets[1]))
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add test credit</DialogTitle>
          <DialogDescription>Simulation mode: this credit is not real money and nothing is charged. Live payments are added when the platform goes live.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          {presets.map((p) => (
            <Button key={p} variant={Number(amount) === p ? 'default' : 'outline'} size="sm" onClick={() => setAmount(String(p))}>
              {formatMoney(p, currency)}
            </Button>
          ))}
        </div>
        <Field label={`Amount (${currency})`} htmlFor="tu-amount">
          <Input id="tu-amount" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!(Number(amount) > 0)}
            onClick={async () => {
              setBusy(true)
              try {
                await billingApi.testCredit(scope, Number(amount))
                await qc.invalidateQueries({ queryKey: bqk.all })
                toast.success(`${formatMoney(Number(amount), currency)} test credit added`)
                onOpenChange(false)
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Add credit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ThresholdDialog({ scope, currency, value, open, onOpenChange }: { scope: BillingScope; currency: string; value: number; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState(String(value))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Low balance alert</DialogTitle>
          <DialogDescription>Owners and admins are notified when the balance drops below this amount (at most once a day).</DialogDescription>
        </DialogHeader>
        <Field label={`Alert below (${currency})`} htmlFor="th">
          <Input id="th" type="number" min={0} value={v} onChange={(e) => setV(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button
            onClick={async () => {
              try {
                await billingApi.threshold(scope, Number(v))
                await qc.invalidateQueries({ queryKey: bqk.all })
                onOpenChange(false)
              } catch (e) {
                toast.error(errorMessage(e))
              }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Transactions({ scope, currency, appName }: { scope: BillingScope; currency: string; appName?: string }) {
  const [type, setType] = useState('')
  const [page, setPage] = useState(1)
  const filterKey = scope.kind === 'org' ? scope.app : scope.id
  // A new application filter starts again from the first page.
  useEffect(() => setPage(1), [filterKey])
  const q = useTransactions(scope, { page, page_size: 20, type: type || undefined })
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Transactions</CardTitle>
          <CardDescription>{appName ? `Charges made by ${appName}.` : 'The complete ledger. Entries are never edited or removed.'}</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => downloadFile(billingApi.exportUrl(scope), 'wallet-transactions.csv').catch((e) => toast.error(errorMessage(e)))}>
          <Download /> Export CSV
        </Button>
      </CardHeader>
      <div className="flex flex-wrap gap-1 border-y p-3">
        {[['', 'All'], ['usage', 'Usage'], ['subscription', 'Plan'], ['recurring', 'Recurring'], ['test_credit', 'Test credit'], ['trial_credit', 'Trial'], ['credit', 'Credit'], ['adjustment', 'Adjustments']].map(([k, l]) => (
          <button key={k} onClick={() => { setType(k!); setPage(1) }} className={cn('rounded-full px-3 py-1.5 text-xs font-medium transition', type === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
            {l}
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data?.items.length ? (
        <p className="p-6 text-center text-sm text-muted-foreground" data-testid="tx-empty">{appName ? `No charges by ${appName} yet.` : 'No transactions yet.'}</p>
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                <TH>Description</TH>
                <TH>Type</TH>
                <TH className="text-right">Amount</TH>
                <TH className="text-right">Balance</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((t) => (
                <TR key={t.id} data-testid="tx-row">
                  <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(t.created_at)}</TD>
                  <TD>
                    <div className="text-sm">{t.description}</div>
                    {t.type === 'subscription' && t.meta.period_end && <div className="text-xs text-muted-foreground">Monthly plan fee · renews {formatDate(t.meta.period_end)}</div>}
                    {t.type === 'recurring' && <div className="text-xs text-muted-foreground">Monthly fee{t.meta.original_currency && t.meta.original_currency !== currency ? ` · ${formatMoney(t.meta.original_amount, t.meta.original_currency)} converted` : ''}</div>}
                    {t.meta.units !== undefined && (
                      <div className="text-xs text-muted-foreground">
                        {t.meta.units} {t.channel === 'voice' ? 'calls charged' : t.channel === 'sms' ? 'texts' : 'emails'}
                        {t.meta.original_currency && t.meta.original_currency !== currency && ` · ${formatMoney(t.meta.original_amount, t.meta.original_currency)} converted`}
                        {t.meta.plan_discount ? ` · ${Math.round(t.meta.plan_discount * 100)}% plan discount` : ''}
                      </div>
                    )}
                  </TD>
                  <TD>
                    <Badge variant={DEBIT_TYPES.has(t.type) ? 'secondary' : 'success'}>
                      {t.channel ? `${TYPE_LABEL[t.type] ?? t.type} · ${CHANNEL_LABEL[t.channel] ?? t.channel}` : t.type === 'recurring' && t.reference_type ? `${TYPE_LABEL.recurring} · ${t.reference_type.replace(/_/g, ' ')}` : (TYPE_LABEL[t.type] ?? t.type)}
                    </Badge>
                  </TD>
                  <TD className={cn('text-right tabular-nums', t.amount < 0 ? '' : 'text-success-strong')}>
                    {t.amount < 0 ? '−' : '+'}
                    {formatMoney(Math.abs(t.amount), currency)}
                  </TD>
                  <TD className="text-right tabular-nums text-muted-foreground">{formatMoney(t.balance_after, currency)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={20} total={q.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  )
}

function PayDialog({ scope, currency, min, max, provider, open, onOpenChange, onNeedDetails }: { scope: BillingScope; currency: string; min: number; max: number; provider: string; open: boolean; onOpenChange: (o: boolean) => void; onNeedDetails: () => void }) {
  const presets = currency === 'INR' ? [1000, 5000, 20000] : currency === 'AED' ? [100, 500, 2000] : [25, 100, 500]
  const [amount, setAmount] = useState(String(presets[1]))
  const [busy, setBusy] = useState(false)
  const n = Number(amount)
  const orgId = scope.kind === 'org' ? scope.id : scope.orgId
  const profile = useBillingProfile(orgId, open)
  // AED: only VAT-registered UAE businesses can pay, so a TRN is required too.
  const needsDetails = !!profile.data?.required && (!profile.data.profile || (!!profile.data.trn_required && !profile.data.profile.trn))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add credit</DialogTitle>
          <DialogDescription>You pay on the secure {provider === 'stripe' ? 'Stripe' : 'Razorpay'} page. Credit is added as soon as the payment is confirmed.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          {presets.map((p) => (
            <Button key={p} variant={n === p ? 'default' : 'outline'} size="sm" onClick={() => setAmount(String(p))}>
              {formatMoney(p, currency)}
            </Button>
          ))}
        </div>
        <Field label={`Amount (${currency})`} htmlFor="pay-amount" hint={`Between ${formatMoney(min, currency)} and ${formatMoney(max, currency)}.`}>
          <Input id="pay-amount" type="number" min={min} max={max} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {n >= min && n <= max && (
          <GstBreakdown
            orgId={orgId}
            amount={n}
            onNeedDetails={() => {
              onOpenChange(false)
              onNeedDetails()
            }}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!(n >= min && n <= max) || needsDetails || profile.isLoading}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await billingApi.checkout(scope, n)
                window.location.assign(r.checkout_url)
              } catch (e) {
                toast.error(errorMessage(e))
                setBusy(false)
              }
            }}
          >
            <CreditCard /> Continue to payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** After returning from the payment page: wait for the provider's confirmation (the webhook credits the wallet). */
function PaymentStatus({ scope, id, currency }: { scope: BillingScope; id: string; currency: string }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['billing', 'payment', id],
    queryFn: async () => {
      const p = await billingApi.payment(scope, id)
      if (p.status === 'paid') qc.invalidateQueries({ queryKey: bqk.all })
      return p
    },
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3000 : false),
  })
  const p = q.data
  if (!p) return null
  const tone = p.status === 'paid' ? 'border-success-border bg-success-soft text-success-strong' : p.status === 'pending' ? 'bg-accent/40' : 'border-danger-border bg-danger-soft text-danger-strong'
  return (
    <div className={cn('flex items-center gap-3 rounded-lg border px-4 py-3 text-sm', tone)} data-testid="payment-status">
      {p.status === 'paid' ? <CheckCircle2 className="size-4" /> : p.status === 'pending' ? <Loader2 className="size-4 animate-spin" /> : <TriangleAlert className="size-4" />}
      {p.status === 'paid'
        ? `${formatMoney(p.amount, currency)} was added to your wallet.`
        : p.status === 'pending'
          ? `Waiting for the payment of ${formatMoney(p.gross_amount ?? p.amount, currency)} to be confirmed…`
          : `The payment was not completed${p.failure_reason ? `: ${p.failure_reason}` : ''}. No credit was added.`}
    </div>
  )
}

/** The one Billing page: the organization's wallet and plan, with an optional "show one application" filter. */
export function BillingPage() {
  const { orgId } = useParams()
  const { org, apps } = useWorkspace()
  const [params, setParams] = useSearchParams()
  const orgKey = orgId ?? org!.id
  // Wallet actions (top-up, plan, alert level) always act on the organization.
  const scope: BillingScope = { kind: 'org', id: orgKey }
  // ?app=<id> narrows usage figures and the ledger to one application.
  const appFilter = apps.some((a) => a.id === params.get('app')) ? params.get('app')! : undefined
  const filteredApp = apps.find((a) => a.id === appFilter)
  const view: BillingScope = { kind: 'org', id: orgKey, app: appFilter }
  const setAppFilter = (id: string) => {
    const next = new URLSearchParams(params)
    if (id) next.set('app', id)
    else next.delete('app')
    setParams(next, { replace: true })
  }
  const q = useBilling(view)
  const paymentId = params.get('payment')
  const wantsTopUp = params.get('topup') === '1'
  const options = useQuery({ queryKey: ['billing', 'options', orgKey], queryFn: () => billingApi.paymentOptions(scope), enabled: !!q.data && !q.data.test_mode })
  const [pay, setPay] = useState(false)
  const [topUp, setTopUp] = useState(false)
  const [threshold, setThreshold] = useState(false)
  const s = q.data
  const cur = s?.currency ?? 'USD'
  // ?tab=invoices|statements|details opens a tab (the invoice email links to Invoices).
  const tab = ['invoices', 'statements', 'details'].includes(params.get('tab') ?? '') ? params.get('tab')! : 'transactions'
  const setTab = (t: string) => {
    const next = new URLSearchParams(params)
    if (t === 'transactions') next.delete('tab')
    else next.set('tab', t)
    setParams(next, { replace: true })
  }
  const openDetails = () => {
    setTab('details')
    window.setTimeout(() => document.getElementById('billing-tabs')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50)
  }
  // INR wallets need billing details (for GST invoices) before the first online top-up; AED wallets need them
  // with a TRN (UAE VAT-registered businesses only). The billing details tab shows the TRN even in test mode.
  const uaeWallet = s?.currency === 'AED'
  const profile = useBillingProfile(orgKey, !!s && (uaeWallet || (!s.test_mode && s.currency === 'INR')) && s.can_manage)
  const needsDetails = !!profile.data?.required && (!profile.data.profile || (uaeWallet && !profile.data.profile.trn))
  // ?topup=1 (from "Add credit" on an out-of-credit toast or the low-balance chip) opens the right dialog.
  useEffect(() => {
    if (!wantsTopUp || !s) return
    if (!s.can_manage) return
    if (s.test_mode) setTopUp(true)
    else if (options.data?.provider) setPay(true)
    else if (!options.data) return
    const next = new URLSearchParams(params)
    next.delete('topup')
    setParams(next, { replace: true })
  }, [wantsTopUp, s, options.data, params, setParams])
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: 'Billing' }]}
        title="Billing"
        description="Your wallet, plan and every charge. One wallet pays for all applications in this organization."
        actions={
          s?.can_manage &&
          (s.test_mode ? (
            <Button onClick={() => setTopUp(true)}>
              <Plus /> Add test credit
            </Button>
          ) : options.data?.provider ? (
            <Button onClick={() => setPay(true)}>
              <CreditCard /> Add credit
            </Button>
          ) : options.data ? (
            <span className="max-w-xs text-right text-xs text-muted-foreground">Online payment is not set up for {s.currency} wallets yet. Contact support to add credit.</span>
          ) : null)
        }
      />
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError || !s ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-6">
          {paymentId && <PaymentStatus scope={scope} id={paymentId} currency={cur} />}
          {needsDetails && (
            <div className="flex flex-col gap-3 rounded-lg border border-warning-border bg-warning-soft px-4 py-3 text-sm text-warning-strong sm:flex-row sm:items-center" data-testid="billing-details-prompt">
              <TriangleAlert className="hidden size-4 shrink-0 sm:block" />
              <div className="min-w-0 flex-1">
                {uaeWallet ? (
                  <>
                    <strong>Add your UAE TRN before your first top-up.</strong> Signalcraft currently sells to VAT-registered UAE businesses. Invoices show your TRN and charge no UAE VAT (reverse charge).
                  </>
                ) : (
                  <>
                    <strong>Add your billing details before your first top-up.</strong> Prices exclude GST; GST is added to each top-up and we email you a tax invoice made out to these details.
                  </>
                )}
              </div>
              <Button size="sm" variant="outline" onClick={openDetails}>
                {uaeWallet ? 'Add your TRN' : 'Add billing details'}
              </Button>
            </div>
          )}
          <PlanSection orgId={orgKey} onAddCredit={!s.can_manage ? null : s.test_mode ? () => setTopUp(true) : options.data?.provider ? () => setPay(true) : null} />
          {wantsTopUp && !s.can_manage && (
            <p className="rounded-lg border border-warning-border bg-warning-soft px-4 py-3 text-sm text-warning-strong">Only owners and admins can add credit. Ask one of them to top up the wallet.</p>
          )}
          {s.test_mode && (
            <div className="flex items-start gap-3 rounded-lg border border-warning-border bg-warning-soft px-4 py-3 text-sm text-warning-strong">
              <FlaskConical className="mt-0.5 size-4 shrink-0" />
              <div>
                <strong>Simulation mode.</strong> Trial and test credit are not real money, and usage is charged at platform prices so you can see what campaigns would cost.
              </div>
            </div>
          )}
          {s.low && (
            <div className="flex items-start gap-3 rounded-lg border border-danger-border bg-danger-soft px-4 py-3 text-sm text-danger-strong" data-testid="low-balance">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <div>The balance is below your alert level of {formatMoney(s.low_balance_threshold, cur)}. Campaigns that need more than the available credit will not start.</div>
            </div>
          )}
          {(apps.length > 1 || appFilter) && (
            <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-4 py-3 sm:flex-row sm:items-center" data-testid="billing-app-filter">
              <label htmlFor="billing-app" className="text-sm font-medium">
                Show usage for
              </label>
              <Select id="billing-app" value={appFilter ?? ''} onChange={(e) => setAppFilter(e.target.value)} className="w-full sm:w-64">
                <option value="">All applications</option>
                {apps.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
              {filteredApp && <span className="text-xs text-muted-foreground">Balance and plan are shared by every application.</span>}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="wallet-kpis">
            <StatCard label="Balance" value={formatMoney(s.balance, cur)} icon={Wallet} hint={`${cur} wallet`} />
            <StatCard label="Available" value={formatMoney(s.available, cur)} icon={Lock} tone={s.available > 0 ? 'success' : undefined} hint={s.held ? `${formatMoney(s.held, cur)} held for running campaigns` : 'Nothing held'} />
            <StatCard label={filteredApp ? `${filteredApp.name} this month` : 'Spent this month'} value={formatMoney(s.month_usage.total, cur)} icon={TrendingDown} hint={Object.entries(s.month_usage.by_channel).map(([k, v]) => `${CHANNEL_LABEL[k]} ${formatMoney(v, cur)}`).join(' · ') || 'No usage yet'} />
            <button className="text-left" onClick={() => s.can_manage && setThreshold(true)} disabled={!s.can_manage} aria-label="Low balance alert">
              <StatCard label="Low balance alert" value={formatMoney(s.low_balance_threshold, cur)} icon={TriangleAlert} hint={s.can_manage ? 'Click to change' : 'Set by owners'} />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Daily usage</CardTitle>
                <CardDescription>Last 30 days, in {cur}.</CardDescription>
              </CardHeader>
              <CardContent className="h-60">
                {s.daily_usage.some((d) => d.amount > 0) ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={s.daily_usage.map((d) => ({ ...d, label: new Date(d.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }))}>
                      <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
                      <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={48} />
                      <ChartTooltip formatter={(v: number) => formatMoney(v, cur)} contentStyle={{ borderRadius: 8, fontSize: 12, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }} cursor={{ fill: 'hsl(var(--muted))' }} />
                      <Bar dataKey="amount" name="Usage" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={18} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyState icon={TrendingDown} title="No usage yet" description="Charges appear here as campaigns and workflows send." />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Spend by application</CardTitle>
                <CardDescription>This month. Select one to see only its usage.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {s.per_application.length ? (
                  s.per_application.map((p) => (
                    <button
                      key={p.application_id ?? 'none'}
                      type="button"
                      disabled={!p.application_id}
                      onClick={() => p.application_id && setAppFilter(p.application_id === appFilter ? '' : p.application_id)}
                      className={cn(
                        '-mx-2 flex w-[calc(100%+1rem)] justify-between gap-2 rounded-md px-2 py-1 text-left transition hover:bg-muted/60',
                        p.application_id === appFilter && 'bg-accent text-accent-foreground',
                      )}
                    >
                      <span className="truncate">{p.application}</span>
                      <span className="tabular-nums">{formatMoney(p.spend, cur)}</span>
                    </button>
                  ))
                ) : (
                  <p className="text-muted-foreground">No usage this month.</p>
                )}
                {(appFilter ? s.holds.filter((h) => h.application_id === appFilter) : s.holds).length > 0 && (
                  <div className="border-t pt-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Held for running campaigns</div>
                    {(appFilter ? s.holds.filter((h) => h.application_id === appFilter) : s.holds).map((h) => (
                      <div key={h.id} className="flex justify-between gap-2">
                        <span className="truncate text-muted-foreground">{h.description}</span>
                        <span className="tabular-nums">{formatMoney(h.amount, cur)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Prices</CardTitle>
              <CardDescription>Platform prices in your wallet currency. Usage in another currency is converted at the platform rate.</CardDescription>
            </CardHeader>
            <Table>
              <THead>
                <TR>
                  <TH>Recipients / app in</TH>
                  <TH className="text-right">Email</TH>
                  <TH className="text-right">SMS (promotional, per part)</TH>
                  <TH className="text-right">SMS (transactional, per part)</TH>
                  <TH className="text-right">Voice (per started minute)</TH>
                  <TH className="text-right">Chatbot (per AI reply)</TH>
                </TR>
              </THead>
              <TBody>
                {s.pricing.map((p) => (
                  <TR key={p.country}>
                    <TD>
                      <span className="inline-flex items-center gap-2">
                        <CountryFlag code={p.country} /> {countryName(p.country)}
                      </span>
                    </TD>
                    <TD className="text-right tabular-nums">{formatMoney(p.email, cur)}</TD>
                    {/* SMS is coming soon in every market. */}
                    <TD className="text-right text-muted-foreground">Coming soon</TD>
                    <TD className="text-right text-muted-foreground">Coming soon</TD>
                    <TD className="text-right tabular-nums">{formatMoney(p.voice_minute, cur)}</TD>
                    <TD className="text-right tabular-nums">{p.chat_reply != null ? formatMoney(p.chat_reply, cur) : '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
          <Tabs value={tab} onValueChange={setTab} id="billing-tabs" className="scroll-mt-20">
            <div className="-mx-1 overflow-x-auto px-1">
              <TabsList>
                <TabsTrigger value="transactions">Transactions</TabsTrigger>
                <TabsTrigger value="invoices" data-testid="tab-invoices">Invoices</TabsTrigger>
                <TabsTrigger value="statements" data-testid="tab-statements">Statements</TabsTrigger>
                <TabsTrigger value="details" data-testid="tab-billing-details">Billing details</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="transactions">
              <Transactions scope={view} currency={cur} appName={filteredApp?.name} />
            </TabsContent>
            <TabsContent value="invoices">
              <InvoicesCard orgId={orgKey} />
            </TabsContent>
            <TabsContent value="statements">
              <StatementsCard orgId={orgKey} />
            </TabsContent>
            <TabsContent value="details">
              <BillingDetailsCard orgId={orgKey} />
            </TabsContent>
          </Tabs>
          <TopUpDialog scope={scope} currency={cur} open={topUp} onOpenChange={setTopUp} />
          {options.data?.provider && (
            <PayDialog scope={scope} currency={cur} min={options.data.min} max={options.data.max} provider={options.data.provider} open={pay} onOpenChange={setPay} onNeedDetails={openDetails} />
          )}
          {threshold && <ThresholdDialog scope={scope} currency={cur} value={s.low_balance_threshold} open={threshold} onOpenChange={setThreshold} />}
        </div>
      )}
    </>
  )
}
