import { CalendarClock, CheckSquare, Mail, MessageCircle, MessageSquare, Phone, PhoneCall, type LucideIcon, MapPin, MoreHorizontal, Users, StickyNote, Cog, ListTodo } from 'lucide-react'
import type { ActivityType, Lifecycle, Money, Priority, TaskType } from '@/types/crm'
import { currencyLocale } from '@/lib/regions'
import { formatMoney } from '../sms/format'

const num = (v: Money | null | undefined) => (v === null || v === undefined || v === '' ? 0 : Number(v))

/** Amount in whole units: ₹12,34,567 (Indian grouping) or $1,234,567. `exact` keeps paise/cents. */
export function money(v: Money | null | undefined, currency: string = 'INR', exact = false) {
  const n = num(v)
  return new Intl.NumberFormat(currencyLocale(currency), {
    style: 'currency',
    currency,
    maximumFractionDigits: exact && !Number.isInteger(n) ? 2 : 0,
    minimumFractionDigits: exact && !Number.isInteger(n) ? 2 : 0,
  }).format(n)
}

/** Short amount for headers and cards: ₹12.3 L / ₹1.2 Cr, $1.2M / $45K. Small values stay exact. */
export function moneyCompact(v: Money | null | undefined, currency: string = 'INR') {
  const n = num(v)
  const abs = Math.abs(n)
  const trim = (x: number) => (Math.round(x * 10) / 10).toLocaleString('en-IN', { maximumFractionDigits: 1 })
  if (currency === 'INR') {
    if (abs >= 1e7) return `₹${trim(n / 1e7)} Cr`
    if (abs >= 1e5) return `₹${trim(n / 1e5)} L`
    return money(n, 'INR')
  }
  if (abs >= 1e4)
    return new Intl.NumberFormat(currencyLocale(currency), { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(n)
  return money(n, currency)
}

export { formatMoney, num }

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  subscriber: 'Subscriber',
  lead: 'Lead',
  mql: 'Marketing qualified',
  sql: 'Sales qualified',
  opportunity: 'Opportunity',
  customer: 'Customer',
  other: 'Other',
}
export const LIFECYCLES = Object.keys(LIFECYCLE_LABEL) as Lifecycle[]

export const TASK_TYPE_META: Record<TaskType, { label: string; icon: LucideIcon }> = {
  call: { label: 'Call', icon: Phone },
  email: { label: 'Email', icon: Mail },
  meeting: { label: 'Meeting', icon: Users },
  follow_up: { label: 'Follow up', icon: CalendarClock },
  todo: { label: 'To-do', icon: ListTodo },
}

export const PRIORITY_META: Record<Priority, { label: string; className: string }> = {
  high: { label: 'High', className: 'text-danger-strong' },
  normal: { label: 'Normal', className: 'text-muted-foreground' },
  low: { label: 'Low', className: 'text-muted-foreground/70' },
}

export const ACTIVITY_META: Record<ActivityType, { label: string; icon: LucideIcon }> = {
  call: { label: 'Call', icon: Phone },
  meeting: { label: 'Meeting', icon: Users },
  email: { label: 'Email', icon: Mail },
  whatsapp: { label: 'WhatsApp', icon: MessageCircle },
  sms: { label: 'SMS', icon: MessageSquare },
  visit: { label: 'Visit', icon: MapPin },
  other: { label: 'Other', icon: MoreHorizontal },
}

/** Icon and chip colour per timeline kind. */
export const KIND_META: Record<string, { label: string; icon: LucideIcon; tone: string }> = {
  activity: { label: 'Activities', icon: PhoneCall, tone: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300' },
  note: { label: 'Notes', icon: StickyNote, tone: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' },
  task: { label: 'Tasks', icon: CheckSquare, tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  system: { label: 'System', icon: Cog, tone: 'bg-slate-100 text-slate-600 dark:bg-slate-500/20 dark:text-slate-300' },
  email: { label: 'Email', icon: Mail, tone: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300' },
  sms: { label: 'SMS', icon: MessageSquare, tone: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300' },
  sms_reply: { label: 'SMS', icon: MessageSquare, tone: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300' },
  call: { label: 'Calls', icon: PhoneCall, tone: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300' },
  profile: { label: 'Profile', icon: Users, tone: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' },
}

/** Human labels for lead-scoring fit fields (backend FIT_FIELDS). */
export const FIT_FIELD_LABEL: Record<string, string> = {
  country: 'Country',
  state: 'State',
  city: 'City',
  source: 'Source',
  lifecycle_stage: 'Lifecycle stage',
  company: 'Company name (text)',
  email: 'Email',
  phone: 'Phone',
  phone_type: 'Phone type',
  timezone: 'Time zone',
  'company.industry': 'Company industry',
  'company.size': 'Company size',
  'company.country': 'Company country',
  'company.state': 'Company state',
}

export const GST_TREATMENT_LABEL: Record<string, string> = {
  registered_regular: 'Registered (regular)',
  registered_composition: 'Registered (composition)',
  unregistered: 'Unregistered business',
  consumer: 'Consumer',
  overseas: 'Overseas',
  sez: 'SEZ',
}

export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const

/** "in 3h", "2d overdue" style countdown for SLA and due dates. */
export function countdown(iso: string) {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
  const abs = Math.abs(mins)
  const txt = abs < 60 ? `${abs}m` : abs < 60 * 48 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`
  return mins >= 0 ? `in ${txt}` : `${txt} ago`
}

/** Local datetime-input value (YYYY-MM-DDTHH:mm) for a Date. */
export function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const isoDate = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function shortDate(iso: string) {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}
