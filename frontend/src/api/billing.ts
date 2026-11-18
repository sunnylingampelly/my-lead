import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { http } from './client'
import type { Page } from '@/types/api'

export interface BillingSummary {
  currency: 'INR' | 'USD'
  balance: number
  held: number
  available: number
  low_balance_threshold: number
  low: boolean
  month_usage: { total: number; by_channel: Record<string, number> }
  daily_usage: { date: string; amount: number }[]
  per_application: { application_id: string | null; application: string; spend: number }[]
  holds: { id: string; description: string; amount: number; created_at: string; application_id: string | null }[]
  pricing: { country: string; email: number; sms_promotional: number; sms_transactional: number; voice_minute: number }[]
  test_mode: boolean
  can_manage: boolean
}

export interface WalletTx {
  id: string
  type: 'trial_credit' | 'test_credit' | 'credit' | 'usage' | 'adjustment' | 'refund'
  channel: string | null
  amount: number
  balance_after: number
  description: string
  application_id: string | null
  reference_type: string | null
  reference_id: string | null
  meta: { units?: number; original_amount?: number; original_currency?: string }
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
  top_campaigns: { channel: 'email' | 'sms' | 'voice'; id: string; name: string; automation: boolean; sent: number; engaged: number; engaged_label: string; rate: number | null }[]
  workflows: { id: string; name: string; status: string; entered: number; completed: number }[]
}

/** Scope: an organization (whole wallet) or one application (its usage only). */
export type BillingScope = { kind: 'org'; id: string } | { kind: 'app'; id: string; orgId: string }

const base = (s: BillingScope) => (s.kind === 'org' ? `/organizations/${s.id}/billing` : `/apps/${s.id}/billing`)
const orgBase = (s: BillingScope) => `/organizations/${s.kind === 'org' ? s.id : s.orgId}/billing`
const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)

export const billingApi = {
  summary: (s: BillingScope) => data(http.get<BillingSummary>(base(s))),
  transactions: (s: BillingScope, p: { page: number; page_size: number; type?: string }) =>
    data(http.get<Page<WalletTx>>(`${base(s)}/transactions`, { params: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) })),
  exportUrl: (s: BillingScope) => `${orgBase(s)}/transactions.csv${s.kind === 'app' ? `?application_id=${s.id}` : ''}`,
  testCredit: (s: BillingScope, amount: number) =>
    data(http.post<{ added: boolean; balance: number }>(`${orgBase(s)}/test-credit`, { amount: amount.toFixed(2), idempotency_key: crypto.randomUUID() })),
  paymentOptions: (s: BillingScope) => data(http.get<{ currency: string; provider: 'stripe' | 'razorpay' | null; min: number; max: number }>(`${orgBase(s)}/payments/options`)),
  checkout: (s: BillingScope, amount: number) => data(http.post<{ id: string; checkout_url: string }>(`${orgBase(s)}/checkout`, { amount: amount.toFixed(2) })),
  payment: (s: BillingScope, id: string) =>
    data(http.get<{ id: string; status: 'pending' | 'paid' | 'failed' | 'expired'; amount: number; currency: string; failure_reason: string | null }>(`${orgBase(s)}/payments/${id}`)),
  threshold: (s: BillingScope, value: number) => data(http.put<BillingSummary>(`${orgBase(s)}/threshold`, { low_balance_threshold: value.toFixed(2) })),
}

export const analyticsApi = {
  get: (appId: string, start?: string, end?: string) => data(http.get<Analytics>(`/apps/${appId}/analytics`, { params: { start, end } })),
  exportUrl: (appId: string, start?: string, end?: string) =>
    `/apps/${appId}/analytics/export.csv?${new URLSearchParams(Object.entries({ start, end }).filter(([, v]) => v) as [string, string][])}`,
}

export const bqk = {
  all: ['billing'] as const,
  summary: (s: BillingScope) => ['billing', s.kind, s.id, 'summary'] as const,
  tx: (s: BillingScope, p: object) => ['billing', s.kind, s.id, 'tx', p] as const,
}

export const useBilling = (s: BillingScope) => useQuery({ queryKey: bqk.summary(s), queryFn: () => billingApi.summary(s), refetchOnMount: 'always' })
export const useTransactions = (s: BillingScope, p: { page: number; page_size: number; type?: string }) =>
  useQuery({ queryKey: bqk.tx(s, p), queryFn: () => billingApi.transactions(s, p), placeholderData: keepPreviousData })
export const useAnalytics = (appId: string, start?: string, end?: string) =>
  useQuery({ queryKey: ['analytics', appId, start, end], queryFn: () => analyticsApi.get(appId, start, end), placeholderData: keepPreviousData })
