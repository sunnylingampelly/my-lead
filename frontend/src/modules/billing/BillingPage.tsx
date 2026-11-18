import { useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { CheckCircle2, CreditCard, Download, FlaskConical, Loader2, Lock, Plus, TrendingDown, TriangleAlert, Wallet } from 'lucide-react'
import { billingApi, type BillingScope, bqk, useBilling, useTransactions } from '@/api/billing'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Pagination, StatCard } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { downloadFile } from '@/lib/download'
import { cn, formatDateTime } from '@/lib/utils'
import { formatMoney } from '../sms/format'

const TYPE_LABEL: Record<string, string> = {
  trial_credit: 'Trial credit',
  test_credit: 'Test credit',
  credit: 'Credit',
  usage: 'Usage',
  adjustment: 'Adjustment',
  refund: 'Refund',
}
const CHANNEL_LABEL: Record<string, string> = { email: 'Email', sms: 'SMS', voice: 'Voice' }

function TopUpDialog({ scope, currency, open, onOpenChange }: { scope: BillingScope; currency: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient()
  const presets = currency === 'INR' ? [500, 2000, 10000] : [10, 50, 200]
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

function Transactions({ scope, currency }: { scope: BillingScope; currency: string }) {
  const [type, setType] = useState('')
  const [page, setPage] = useState(1)
  const q = useTransactions(scope, { page, page_size: 20, type: type || undefined })
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>Transactions</CardTitle>
          <CardDescription>The complete ledger. Entries are never edited or removed.</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => downloadFile(billingApi.exportUrl(scope), 'wallet-transactions.csv').catch((e) => toast.error(errorMessage(e)))}>
          <Download /> Export CSV
        </Button>
      </CardHeader>
      <div className="flex flex-wrap gap-1 border-y p-3">
        {[['', 'All'], ['usage', 'Usage'], ['test_credit', 'Test credit'], ['trial_credit', 'Trial'], ['credit', 'Credit'], ['adjustment', 'Adjustments']].map(([k, l]) => (
          <button key={k} onClick={() => { setType(k!); setPage(1) }} className={cn('rounded-full px-3 py-1.5 text-xs font-medium transition', type === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
            {l}
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data?.items.length ? (
        <p className="p-6 text-center text-sm text-muted-foreground">No transactions yet.</p>
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
                    {t.meta.units !== undefined && (
                      <div className="text-xs text-muted-foreground">
                        {t.meta.units} {t.channel === 'voice' ? 'calls charged' : t.channel === 'sms' ? 'texts' : 'emails'}
                        {t.meta.original_currency && t.meta.original_currency !== currency && ` · ${formatMoney(t.meta.original_amount, t.meta.original_currency)} converted`}
                      </div>
                    )}
                  </TD>
                  <TD>
                    <Badge variant={t.type === 'usage' ? 'secondary' : 'success'}>{t.channel ? `${TYPE_LABEL[t.type]} · ${CHANNEL_LABEL[t.channel]}` : TYPE_LABEL[t.type]}</Badge>
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

function PayDialog({ scope, currency, min, max, provider, open, onOpenChange }: { scope: BillingScope; currency: string; min: number; max: number; provider: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const presets = currency === 'INR' ? [1000, 5000, 20000] : [25, 100, 500]
  const [amount, setAmount] = useState(String(presets[1]))
  const [busy, setBusy] = useState(false)
  const n = Number(amount)
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
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!(n >= min && n <= max)}
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
          ? `Waiting for the payment of ${formatMoney(p.amount, currency)} to be confirmed…`
          : `The payment was not completed${p.failure_reason ? `: ${p.failure_reason}` : ''}. No credit was added.`}
    </div>
  )
}

export function BillingPage({ scope: forced }: { scope?: 'app' | 'org' }) {
  const { orgId } = useParams()
  const { app, org } = useWorkspace()
  const scope: BillingScope = forced === 'app' && app ? { kind: 'app', id: app.id, orgId: app.organization_id } : { kind: 'org', id: orgId ?? org!.id }
  const q = useBilling(scope)
  const [params] = useSearchParams()
  const paymentId = params.get('payment')
  const options = useQuery({ queryKey: ['billing', 'options', scope.kind === 'org' ? scope.id : scope.orgId], queryFn: () => billingApi.paymentOptions(scope), enabled: !!q.data && !q.data.test_mode })
  const [pay, setPay] = useState(false)
  const [topUp, setTopUp] = useState(false)
  const [threshold, setThreshold] = useState(false)
  const s = q.data
  const cur = s?.currency ?? 'USD'
  const crumbs = scope.kind === 'app' ? [{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${app!.id}` }, { label: 'Billing & usage' }] : [{ label: org?.name ?? '' }, { label: 'Billing' }]
  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={scope.kind === 'app' ? 'Billing & usage' : 'Billing'}
        description={scope.kind === 'app' ? `What ${app!.name} spends from the ${org?.name ?? 'organization'} wallet.` : 'One wallet for every application in this organization.'}
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
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="wallet-kpis">
            <StatCard label="Balance" value={formatMoney(s.balance, cur)} icon={Wallet} hint={`${cur} wallet`} />
            <StatCard label="Available" value={formatMoney(s.available, cur)} icon={Lock} tone={s.available > 0 ? 'success' : undefined} hint={s.held ? `${formatMoney(s.held, cur)} held for running campaigns` : 'Nothing held'} />
            <StatCard label={scope.kind === 'app' ? 'This app this month' : 'Spent this month'} value={formatMoney(s.month_usage.total, cur)} icon={TrendingDown} hint={Object.entries(s.month_usage.by_channel).map(([k, v]) => `${CHANNEL_LABEL[k]} ${formatMoney(v, cur)}`).join(' · ') || 'No usage yet'} />
            <button className="text-left" onClick={() => s.can_manage && setThreshold(true)} disabled={!s.can_manage} aria-label="Low balance alert">
              <StatCard label="Low balance alert" value={formatMoney(s.low_balance_threshold, cur)} icon={TriangleAlert} hint={s.can_manage ? 'Click to change' : 'Set by owners'} />
            </button>
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
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
                <CardTitle>{scope.kind === 'org' ? 'Spend by application' : 'Held for campaigns'}</CardTitle>
                <CardDescription>{scope.kind === 'org' ? 'This month' : 'Released when each campaign ends'}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {scope.kind === 'org' ? (
                  s.per_application.length ? (
                    s.per_application.map((p) => (
                      <div key={p.application_id ?? 'none'} className="flex justify-between gap-2">
                        <span className="truncate">{p.application}</span>
                        <span className="tabular-nums">{formatMoney(p.spend, cur)}</span>
                      </div>
                    ))
                  ) : (
                    <p className="text-muted-foreground">No usage this month.</p>
                  )
                ) : null}
                {(scope.kind === 'app' ? s.holds.filter((h) => h.application_id === scope.id) : s.holds).length > 0 && (
                  <div className={cn(scope.kind === 'org' && 'border-t pt-3')}>
                    {scope.kind === 'org' && <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Held</div>}
                    {(scope.kind === 'app' ? s.holds.filter((h) => h.application_id === scope.id) : s.holds).map((h) => (
                      <div key={h.id} className="flex justify-between gap-2">
                        <span className="truncate text-muted-foreground">{h.description}</span>
                        <span className="tabular-nums">{formatMoney(h.amount, cur)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {scope.kind === 'app' && !s.holds.some((h) => h.application_id === scope.id) && <p className="text-muted-foreground">Nothing held right now.</p>}
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
                  <TH>Recipients in</TH>
                  <TH className="text-right">Email</TH>
                  <TH className="text-right">SMS (promotional, per part)</TH>
                  <TH className="text-right">SMS (transactional, per part)</TH>
                  <TH className="text-right">Voice (per started minute)</TH>
                </TR>
              </THead>
              <TBody>
                {s.pricing.map((p) => (
                  <TR key={p.country}>
                    <TD>{p.country === 'IN' ? '🇮🇳 India' : '🇺🇸 United States'}</TD>
                    <TD className="text-right tabular-nums">{formatMoney(p.email, cur)}</TD>
                    <TD className="text-right tabular-nums">{formatMoney(p.sms_promotional, cur)}</TD>
                    <TD className="text-right tabular-nums">{formatMoney(p.sms_transactional, cur)}</TD>
                    <TD className="text-right tabular-nums">{formatMoney(p.voice_minute, cur)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
          <Transactions scope={scope} currency={cur} />
          <TopUpDialog scope={scope} currency={cur} open={topUp} onOpenChange={setTopUp} />
          {options.data?.provider && <PayDialog scope={scope} currency={cur} min={options.data.min} max={options.data.max} provider={options.data.provider} open={pay} onOpenChange={setPay} />}
          {threshold && <ThresholdDialog scope={scope} currency={cur} value={s.low_balance_threshold} open={threshold} onOpenChange={setThreshold} />}
        </div>
      )}
    </>
  )
}
