import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { http } from './client'
import type { Page } from '@/types/api'

export interface BillingSummary {
  currency: 'INR' | 'AED' | 'USD'
  balance: number
  held: number
  available: number
  low_balance_threshold: number
  low: boolean
  month_usage: { total: number; by_channel: Record<string, number> }
  daily_usage: { date: string; amount: number }[]
  per_application: { application_id: string | null; application: string; spend: number }[]
  holds: { id: string; description: string; amount: number; created_at: string; application_id: string | null }[]
  pricing: { country: string; email: number; sms_promotional: number; sms_transactional: number; voice_minute: number; voice_ai_minute?: number; chat_reply?: number }[]
  /** AI Team: metered (about ai_markup x the model cost) with a minimum per message / run, in the wallet currency. */
  ai_pricing?: { ai_assistant_message_from: number; ai_assistant_message_typical: number; ai_agent_run_from: number; ai_agent_run_typical: number; ai_markup: number }
  /** Real top-ups (Stripe / Razorpay): smallest and largest amount per payment. */
  topup?: { provider: string | null; min: number; max: number }
  test_mode: boolean
  can_manage: boolean
  plan?: PlanBrief
}

export type PlanKey = 'starter' | 'pro'

export interface PlanBrief {
  key: PlanKey
  name: string
  status: 'active' | 'past_due'
  scheduled_plan: PlanKey | null
  current_period_end: string | null
}

export interface PlanCard {
  key: PlanKey
  name: string
  tagline: string
  price: number
  currency: string
  usage_discount: number
  included_numbers: number
  limits: Record<string, number | null>
  features: string[]
}

export interface PlanOverview {
  plan: PlanKey
  name: string
  status: 'active' | 'past_due'
  currency: 'INR' | 'AED' | 'USD'
  current_period_start: string | null
  current_period_end: string | null
  scheduled_plan: PlanKey | null
  scheduled_change_at: string | null
  past_due_since: string | null
  grace_ends_at: string | null
  usage_discount: number
  included_numbers: number
  limits: Record<string, number | null>
  usage: Record<string, number>
  catalogue: PlanCard[]
  next_charge: { date: string | null; plan: number; numbers: number; total: number }
  recurring: { plan: number; numbers: number; total: number }
  available: number
  can_manage: boolean
}

export interface WalletTx {
  id: string
  type: 'trial_credit' | 'test_credit' | 'credit' | 'usage' | 'adjustment' | 'refund' | 'subscription' | 'recurring'
  channel: string | null
  amount: number
  balance_after: number
  description: string
  application_id: string | null
  reference_type: string | null
  reference_id: string | null
  meta: { units?: number; original_amount?: number; original_currency?: string; plan_discount?: number; plan?: string; period_start?: string; period_end?: string; models?: string[]; input_tokens?: number; output_tokens?: number }
  created_at: string
}

export interface AnalyticsPoint {
  date: string
  [metric: string]: number | string
}

export interface Analytics {
  start: string
  end: string
  timezone: string
  currency: string
  metrics: { key: string; label: string }[]
  points: AnalyticsPoint[]
  totals: Record<string, number>
  rates: Record<string, number | null>
  previous_rates?: Record<string, number | null>
  top_campaigns: { channel: 'email' | 'sms' | 'voice'; id: string; name: string; automation: boolean; sent: number; engaged: number; engaged_label: string; rate: number | null }[]
  workflows: { id: string; name: string; status: string; entered: number; completed: number }[]
}

export interface BillingProfile {
  legal_name: string
  gstin: string | null
  address: string
  city: string | null
  state_code: string | null
  state: string | null
  pin_code: string | null
  country: string
  email: string
  /** UAE: Tax Registration Number (15 digits, starts with 100) and emirate. */
  trn?: string | null
  emirate?: string | null
  updated_at: string
}

export interface BillingProfileResponse {
  profile: BillingProfile | null
  currency: 'INR' | 'AED' | 'USD'
  /** INR and AED organizations need billing details before their first top-up. */
  required: boolean
  can_manage: boolean
  states: { code: string; name: string }[]
  /** AED: only VAT-registered UAE businesses (TRN) can buy; invoices are reverse charge. */
  trn_required?: boolean
  emirates?: string[]
}

export type BillingProfileInput = Omit<BillingProfile, 'state' | 'updated_at' | 'country'> & { country?: string | null }

export interface CheckoutQuote {
  currency: 'INR' | 'AED' | 'USD'
  credit: number
  tax: number
  total: number
  treatment: 'intra_state' | 'inter_state' | 'export_lut'
  rate: number
  cgst: number
  sgst: number
  igst: number
  sgst_label: string
  place_of_supply: string
  profile_ready: boolean
  /** AED: no tax lines; the customer accounts for UAE VAT (reverse charge). */
  reverse_charge?: boolean
  trn_required?: boolean
  trn_message?: string | null
}

export interface InvoiceRow {
  id: string
  number: string
  doc_type: 'invoice' | 'credit_note'
  issued_at: string
  currency: string
  taxable_value: number
  tax: number
  cgst: number
  sgst: number
  igst: number
  total: number
  tax_treatment: CheckoutQuote['treatment']
  place_of_supply: string
  payment_id: string | null
  buyer_name: string | null
  buyer_gstin: string | null
  emailed_at: string | null
}

/**
 * Scope: the organization wallet (optionally narrowed to one application's usage with `app`), or one
 * application seen by someone without organization billing access (its usage only).
 */
export type BillingScope = { kind: 'org'; id: string; app?: string } | { kind: 'app'; id: string; orgId: string }

const base = (s: BillingScope) => (s.kind === 'org' ? `/organizations/${s.id}/billing` : `/apps/${s.id}/billing`)
const orgBase = (s: BillingScope) => `/organizations/${s.kind === 'org' ? s.id : s.orgId}/billing`
const appFilter = (s: BillingScope) => (s.kind === 'org' && s.app ? s.app : s.kind === 'app' ? s.id : undefined)
const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)

export const billingApi = {
  summary: (s: BillingScope) =>
    data(http.get<BillingSummary>(base(s), { params: s.kind === 'org' && s.app ? { application_id: s.app } : undefined })),
  transactions: (s: BillingScope, p: { page: number; page_size: number; type?: string }) =>
    data(
      http.get<Page<WalletTx>>(`${base(s)}/transactions`, {
        params: { ...Object.fromEntries(Object.entries(p).filter(([, v]) => v)), ...(s.kind === 'org' && s.app ? { application_id: s.app } : {}) },
      }),
    ),
  exportUrl: (s: BillingScope) => `${orgBase(s)}/transactions.csv${appFilter(s) ? `?application_id=${appFilter(s)}` : ''}`,
  testCredit: (s: BillingScope, amount: number) =>
    data(http.post<{ added: boolean; balance: number }>(`${orgBase(s)}/test-credit`, { amount: amount.toFixed(2), idempotency_key: crypto.randomUUID() })),
  paymentOptions: (s: BillingScope) => data(http.get<{ currency: string; provider: 'stripe' | 'razorpay' | null; min: number; max: number }>(`${orgBase(s)}/payments/options`)),
  checkout: (s: BillingScope, amount: number) => data(http.post<{ id: string; checkout_url: string }>(`${orgBase(s)}/checkout`, { amount: amount.toFixed(2) })),
  payment: (s: BillingScope, id: string) =>
    data(
      http.get<{ id: string; status: 'pending' | 'paid' | 'failed' | 'expired'; amount: number; tax_amount?: number; gross_amount?: number; currency: string; failure_reason: string | null; invoice_id?: string | null }>(
        `${orgBase(s)}/payments/${id}`,
      ),
    ),
  threshold: (s: BillingScope, value: number) => data(http.put<BillingSummary>(`${orgBase(s)}/threshold`, { low_balance_threshold: value.toFixed(2) })),
  plan: (s: BillingScope) => data(http.get<PlanOverview>(`${orgBase(s)}/plan`)),
  changePlan: (s: BillingScope, plan: PlanKey) => data(http.post<PlanOverview>(`${orgBase(s)}/plan`, { plan })),
  cancelPlanChange: (s: BillingScope) => data(http.post<PlanOverview>(`${orgBase(s)}/plan/cancel-change`)),
  profile: (orgId: string) => data(http.get<BillingProfileResponse>(`/organizations/${orgId}/billing/profile`)),
  saveProfile: (orgId: string, body: BillingProfileInput) => data(http.put<BillingProfile>(`/organizations/${orgId}/billing/profile`, body)),
  quote: (orgId: string, amount: number) => data(http.get<CheckoutQuote>(`/organizations/${orgId}/billing/quote`, { params: { amount: amount.toFixed(2) } })),
  invoices: (orgId: string, p: { page: number; page_size: number }) => data(http.get<Page<InvoiceRow>>(`/organizations/${orgId}/billing/invoices`, { params: p })),
  invoicePdfUrl: (orgId: string, id: string) => `/organizations/${orgId}/billing/invoices/${id}.pdf`,
  statementUrl: (orgId: string, month: string, format: 'csv' | 'pdf') => `/organizations/${orgId}/billing/statements/${month}.${format}`,
}

export const analyticsApi = {
  get: (appId: string, start?: string, end?: string) => data(http.get<Analytics>(`/apps/${appId}/analytics`, { params: { start, end } })),
  exportUrl: (appId: string, start?: string, end?: string) =>
    `/apps/${appId}/analytics/export.csv?${new URLSearchParams(Object.entries({ start, end }).filter(([, v]) => v) as [string, string][])}`,
}

export const bqk = {
  all: ['billing'] as const,
  // The unfiltered key is a prefix of the filtered ones, so invalidating it refreshes every view.
  summary: (s: BillingScope) => (s.kind === 'org' && s.app ? ['billing', s.kind, s.id, 'summary', s.app] : ['billing', s.kind, s.id, 'summary']) as readonly unknown[],
  tx: (s: BillingScope, p: object) => ['billing', s.kind, s.id, 'tx', s.kind === 'org' ? (s.app ?? null) : null, p] as const,
  plan: (orgId: string) => ['billing', 'org', orgId, 'plan'] as const,
  profile: (orgId: string) => ['billing', 'org', orgId, 'profile'] as const,
  invoices: (orgId: string, page: number) => ['billing', 'org', orgId, 'invoices', page] as const,
}

export const useBillingProfile = (orgId: string, enabled = true) =>
  useQuery({ queryKey: bqk.profile(orgId), queryFn: () => billingApi.profile(orgId), enabled })

export const usePlan = (orgId: string, enabled = true) =>
  useQuery({ queryKey: bqk.plan(orgId), queryFn: () => billingApi.plan({ kind: 'org', id: orgId }), enabled, refetchOnMount: 'always' })

export const useBilling = (s: BillingScope) => useQuery({ queryKey: bqk.summary(s), queryFn: () => billingApi.summary(s), refetchOnMount: 'always' })
export const useTransactions = (s: BillingScope, p: { page: number; page_size: number; type?: string }) =>
  useQuery({ queryKey: bqk.tx(s, p), queryFn: () => billingApi.transactions(s, p), placeholderData: keepPreviousData })
export const useAnalytics = (appId: string, start?: string, end?: string) =>
  useQuery({ queryKey: ['analytics', appId, start, end], queryFn: () => analyticsApi.get(appId, start, end), placeholderData: keepPreviousData })
