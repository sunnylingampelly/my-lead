import type { SenderKind, SmsCategory } from '@/types/sms'

export const CATEGORY_LABEL: Record<SmsCategory, string> = {
  promotional: 'Promotional',
  transactional: 'Transactional',
  service: 'Service',
}

export const KIND_LABEL: Record<SenderKind, string> = {
  promotional: 'Promotional header (numeric)',
  service: 'Service header',
  transactional: 'Transactional header',
  long_code: '10DLC long code',
  toll_free: 'Toll-free number',
  short_code: 'Short code',
}

export const COUNTRY_FLAG: Record<string, string> = { IN: '🇮🇳', US: '🇺🇸' }

export function formatMoney(amount: number | string | null | undefined, currency: string | null | undefined) {
  if (amount === null || amount === undefined || !currency) return '—'
  const n = typeof amount === 'string' ? Number(amount) : amount
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, maximumFractionDigits: n < 1 ? 4 : 2 }).format(n)
}
