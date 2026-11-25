/**
 * Public pricing: the fetch hook, money formatting and the cost-calculator math.
 * Every number on the marketing site comes from GET /public/pricing (the same settings billing charges
 * with). Nothing here hard-codes a price; the pure functions below take the API's plans and rates.
 */
import { useQuery } from '@tanstack/react-query'
import { http } from '@/api/client'

export type Currency = 'INR' | 'AED' | 'USD'

export const CURRENCIES: readonly Currency[] = ['INR', 'AED', 'USD']
export const CURRENCY_LABEL: Record<Currency, string> = { INR: '₹ INR', AED: 'AED', USD: '$ USD' }
const LOCALE: Record<Currency, string> = { INR: 'en-IN', AED: 'en-AE', USD: 'en-US' }
/** Where each currency's prices apply, for copy like "Rates for India, in rupees". */
export const MARKET_LABEL: Record<Currency, string> = {
  INR: 'for India, in rupees',
  AED: 'for the UAE, in dirhams',
  USD: 'for the US, in dollars',
}

export type LimitKey =
  | 'applications'
  | 'members'
  | 'contacts'
  | 'lead_forms'
  | 'chatbots'
  | 'chat_seats'
  | 'voice_agents'
  | 'ai_assistant_messages_per_day'
  | 'ai_agent_runs_per_day'
export type RateKey =
  | 'email'
  | 'sms_promotional'
  | 'sms_transactional'
  | 'voice_minute'
  | 'voice_ai_minute'
  | 'chat_reply'
  // AI Team is metered (about 3x the AI model's cost) with a minimum per reply/run; "typical" helps budgeting.
  | 'ai_assistant_message_from'
  | 'ai_assistant_message_typical'
  | 'ai_agent_run_from'
  | 'ai_agent_run_typical'

export interface PublicPlan {
  key: string
  name: string
  tagline: string
  price: number
  usage_discount: number
  /** null = unlimited */
  limits: Partial<Record<LimitKey, number | null>>
  features: string[]
}

export interface PublicPricing {
  currency: Currency
  /** Percent, e.g. 18 (India only; null elsewhere). */
  gst_rate: number | null
  /** UAE: sold to VAT-registered businesses only (TRN), reverse charge, no UAE VAT on the invoice. */
  reverse_charge?: boolean
  /** Channels open in this market; UAE SMS and calls are "coming soon". */
  channels?: { sms: boolean; voice: boolean }
  plans: PublicPlan[]
  rates: Record<RateKey, number> & { ai_markup?: number }
  /** Smallest online top-up in this currency. */
  topup_min?: number
}

export function guessCurrency(): Currency {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'INR'
    if (tz === 'Asia/Dubai') return 'AED'
    return 'USD'
  } catch {
    return 'INR'
  }
}

/** True when SMS or calls are not open yet in this currency's market (the UAE at launch). */
export function channelSoon(p: PublicPricing | undefined, ch: 'sms' | 'voice') {
  return !!p?.channels && p.channels[ch] === false
}

/** SMS is "coming soon" in every market until the API says it is open (channels.sms === true). */
export function smsSoon(p: PublicPricing | undefined) {
  return p?.channels?.sms !== true
}

export function usePublicPricing(currency: Currency) {
  return useQuery({
    queryKey: ['public-pricing', currency],
    queryFn: () => http.get<PublicPricing>('/public/pricing', { params: { currency } }).then((r) => r.data),
    staleTime: 5 * 60_000,
  })
}

/** Removes floating-point dust (2.5 * 0.8 = 2.0000000000000004) so whole numbers stay whole. */
export function tidy(v: number) {
  return Math.round(v * 1e6) / 1e6
}

/**
 * Whole amounts without decimals, fractional ones exactly.
 * @example money(2999, 'INR') // "₹2,999"
 * @example money(1.5, 'INR')  // "₹1.50"
 * @example money(0.05, 'INR') // "₹0.05"
 * @example money(0.001, 'USD') // "$0.001"
 */
export function money(v: number, cur: Currency) {
  const n = tidy(v)
  const whole = Number.isInteger(n)
  return new Intl.NumberFormat(LOCALE[cur], {
    style: 'currency',
    currency: cur,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : n < 0.01 ? 4 : 3,
  }).format(n)
}

/**
 * Totals in the calculator: rounded to whole units above 100, otherwise to cents/paise.
 * @example moneyTotal(14995.2, 'INR') // "₹14,995"
 * @example moneyTotal(12.345, 'USD')  // "$12.35"
 */
export function moneyTotal(v: number, cur: Currency) {
  const big = Math.abs(v) >= 100
  return new Intl.NumberFormat(LOCALE[cur], {
    style: 'currency',
    currency: cur,
    minimumFractionDigits: big || Number.isInteger(tidy(v)) ? 0 : 2,
    maximumFractionDigits: big ? 0 : 2,
  }).format(v)
}

/** A rate after a plan's usage discount. @example discounted(1.5, 0.2) // 1.2 */
export function discounted(rate: number, discount: number) {
  return tidy(rate * (1 - discount))
}

export const percent = (fraction: number) => `${Math.round(fraction * 100)}%`

/** A plan limit for display. @example formatLimit(null) // "Unlimited"; formatLimit(10000) // "10,000" */
export function formatLimit(v: number | null | undefined) {
  if (v === null) return 'Unlimited'
  if (v === undefined) return '—'
  return v.toLocaleString('en-IN')
}

export function findPlan(p: PublicPricing | undefined, key: 'starter' | 'pro') {
  return p?.plans.find((x) => x.key === key)
}

// ------------------------------------------------------------------ calculator

export interface Volumes {
  emails: number
  sms: number
  voiceMinutes: number
  aiMinutes: number
  chatReplies: number
  /** AI Assistant questions and AI agent runs, at typical metered prices. */
  aiQuestions: number
  agentRuns: number
}

export type SmsKind = 'promotional' | 'transactional'

/**
 * Monthly usage at list (Starter) rates.
 * @example
 * usageAtListRates({ emails: 10000, sms: 0, voiceMinutes: 0, aiMinutes: 100, chatReplies: 0 },
 *   { email: 0.05, voice_ai_minute: 6, ... }, 'promotional') // 500 + 600 = 1100
 */
export function usageAtListRates(v: Volumes, rates: Record<RateKey, number>, sms: SmsKind = 'promotional') {
  const smsRate = sms === 'promotional' ? rates.sms_promotional : rates.sms_transactional
  return tidy(
    v.emails * rates.email +
      v.sms * smsRate +
      v.voiceMinutes * rates.voice_minute +
      v.aiMinutes * rates.voice_ai_minute +
      v.chatReplies * rates.chat_reply +
      (v.aiQuestions ?? 0) * (rates.ai_assistant_message_typical ?? 0) +
      (v.agentRuns ?? 0) * (rates.ai_agent_run_typical ?? 0),
  )
}

/**
 * What a plan costs for a month: its fee plus usage after its discount.
 * @example planMonthlyCost({ price: 2999, usage_discount: 0.2 }, 20000) // 2999 + 16000 = 18999
 */
export function planMonthlyCost(plan: Pick<PublicPlan, 'price' | 'usage_discount'>, listUsage: number) {
  return tidy(plan.price + listUsage * (1 - plan.usage_discount))
}

/**
 * Usage (at list rates) where two plans cost the same; null when the pricier plan never catches up.
 * @example breakEvenUsage({ price: 0, usage_discount: 0 }, { price: 2999, usage_discount: 0.2 }) // 14995
 * @example breakEvenUsage({ price: 0, usage_discount: 0 }, { price: 49, usage_discount: 0.2 })   // 245
 */
export function breakEvenUsage(a: Pick<PublicPlan, 'price' | 'usage_discount'>, b: Pick<PublicPlan, 'price' | 'usage_discount'>) {
  const discountGap = b.usage_discount - a.usage_discount
  if (discountGap <= 0) return null
  return tidy((b.price - a.price) / discountGap)
}

export interface PlanComparison {
  listUsage: number
  starter: number
  pro: number
  cheaper: 'starter' | 'pro' | 'equal'
  /** How much the cheaper plan saves a month. */
  savings: number
  breakEven: number | null
}

/**
 * Starter vs Pro for a month of usage.
 * @example
 * comparePlans(starter, pro, rates, volumes) // { starter: 1100, pro: 3879, cheaper: 'starter', savings: 2779, ... }
 */
export function comparePlans(
  starter: Pick<PublicPlan, 'price' | 'usage_discount'>,
  pro: Pick<PublicPlan, 'price' | 'usage_discount'>,
  rates: Record<RateKey, number>,
  v: Volumes,
  sms: SmsKind = 'promotional',
): PlanComparison {
  const listUsage = usageAtListRates(v, rates, sms)
  const s = planMonthlyCost(starter, listUsage)
  const p = planMonthlyCost(pro, listUsage)
  const diff = tidy(s - p)
  return {
    listUsage,
    starter: s,
    pro: p,
    cheaper: Math.abs(diff) < 0.005 ? 'equal' : diff > 0 ? 'pro' : 'starter',
    savings: Math.abs(diff),
    breakEven: breakEvenUsage(starter, pro),
  }
}
