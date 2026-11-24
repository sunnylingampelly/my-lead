import {
  AtSign,
  Calendar,
  CheckSquare,
  ChevronDownSquare,
  CircleDot,
  EyeOff,
  Hash,
  type LucideIcon,
  Phone,
  ShieldCheck,
  Type,
  TextQuote,
  User,
  UserRound,
} from 'lucide-react'
import type { Channel, ConditionOp, FieldType, FormDefinition, FormField, FormOut, FormsMeta, FormStatus, HiddenKind } from '@/types/forms'

/** What every editing tab of the form page receives. */
export interface TabProps {
  appId: string
  form: FormOut
  def: FormDefinition
  patch: (p: Partial<FormDefinition>) => void
  meta?: FormsMeta
  write: boolean
}

export const FIELD_META: Record<FieldType, { label: string; icon: LucideIcon; group: 'Contact' | 'Input' | 'Choice' | 'Other' }> = {
  first_name: { label: 'First name', icon: User, group: 'Contact' },
  last_name: { label: 'Last name', icon: UserRound, group: 'Contact' },
  email: { label: 'Email', icon: AtSign, group: 'Contact' },
  phone: { label: 'Phone', icon: Phone, group: 'Contact' },
  text: { label: 'Short text', icon: Type, group: 'Input' },
  textarea: { label: 'Long text', icon: TextQuote, group: 'Input' },
  number: { label: 'Number', icon: Hash, group: 'Input' },
  date: { label: 'Date', icon: Calendar, group: 'Input' },
  select: { label: 'Dropdown', icon: ChevronDownSquare, group: 'Choice' },
  radio: { label: 'Radio buttons', icon: CircleDot, group: 'Choice' },
  checkboxes: { label: 'Checkboxes', icon: CheckSquare, group: 'Choice' },
  consent: { label: 'Consent', icon: ShieldCheck, group: 'Other' },
  hidden: { label: 'Hidden field', icon: EyeOff, group: 'Other' },
}

export const CHOICE_TYPES: FieldType[] = ['select', 'radio', 'checkboxes']
export const CONTACT_TYPES: FieldType[] = ['first_name', 'last_name', 'email', 'phone']

export const CONDITION_OPS: Record<ConditionOp, string> = {
  equals: 'equals',
  not_equals: 'does not equal',
  contains: 'contains',
  is_set: 'is filled in',
  is_not_set: 'is empty',
}

export const HIDDEN_KINDS: Record<HiddenKind, string> = {
  fixed: 'Fixed value',
  url_param: 'URL parameter',
  page_url: 'Page URL',
  referrer: 'Referrer',
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  utm_term: 'utm_term',
  utm_content: 'utm_content',
}

export const CHANNEL_LABEL: Record<Channel, string> = { email: 'Email', sms: 'SMS', voice: 'Calls' }

export const STATUS_META: Record<FormStatus, { label: string; variant: 'secondary' | 'success' | 'warning' }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  published: { label: 'Published', variant: 'success' },
  paused: { label: 'Paused', variant: 'warning' },
}

export const SUBMISSION_STATUS: Record<string, { label: string; variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' }> = {
  new: { label: 'New', variant: 'default' },
  confirmed: { label: 'Confirmed', variant: 'success' },
  pending_confirmation: { label: 'Awaiting confirmation', variant: 'warning' },
  spam: { label: 'Spam', variant: 'destructive' },
}

/** A unique id matching ^[a-z0-9_]{1,40}$: the type plus a counter. */
export function nextId(prefix: string, taken: string[]): string {
  const base = prefix.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 34) || 'field'
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) {
    const id = `${base}_${i}`
    if (!taken.includes(id)) return id
  }
}

export function newField(type: FieldType, taken: string[], step: number): FormField {
  const contact = CONTACT_TYPES.includes(type)
  const f: FormField = {
    id: nextId(type, taken),
    type,
    label: type === 'consent' ? 'I agree to receive updates and accept the privacy policy.' : type === 'hidden' ? 'Hidden field' : FIELD_META[type].label,
    placeholder: '',
    help: '',
    required: type === 'email',
    default: '',
    width: type === 'first_name' || type === 'last_name' ? 'half' : 'full',
    step,
    options: CHOICE_TYPES.includes(type)
      ? [
          { label: 'Option 1', value: 'Option 1' },
          { label: 'Option 2', value: 'Option 2' },
        ]
      : [],
    map_to: contact ? { kind: 'standard', key: type } : { kind: 'none', key: '' },
    condition: null,
    hidden: type === 'hidden' ? { kind: 'utm_source', value: '' } : null,
    privacy_url: null,
    consent_channels: ['email'],
    default_country: null,
    min: null,
    max: null,
    max_length: null,
  }
  return f
}

/** Does a field's condition pass for the current values? */
export function conditionPasses(f: FormField, values: Record<string, unknown>): boolean {
  const c = f.condition
  if (!c || !c.field) return true
  const raw = values[c.field]
  const v = Array.isArray(raw) ? raw.map(String) : raw === true ? ['yes'] : raw ? [String(raw)] : []
  const target = c.value.trim().toLowerCase()
  const set = v.some((x) => x.trim() !== '')
  switch (c.op) {
    case 'is_set':
      return set
    case 'is_not_set':
      return !set
    case 'equals':
      return v.some((x) => x.trim().toLowerCase() === target)
    case 'not_equals':
      return !v.some((x) => x.trim().toLowerCase() === target)
    case 'contains':
      return v.some((x) => x.toLowerCase().includes(target))
  }
  return true
}

export const isHttpUrl = (v: string) => {
  try {
    const u = new URL(v)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.host && !/[\s<>"']/.test(v)
  } catch {
    return false
  }
}

/** Google Fonts stylesheet for a non-system font. */
export const googleFontUrl = (font: string) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap`

export const fontStack = (font: string) =>
  font === 'system' || !font ? 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' : `"${font}", system-ui, sans-serif`

/** Minimal shape check so a half-loaded draft never crashes the builder. */
export function withDefaults(d: FormDefinition): FormDefinition {
  return { ...d, fields: d.fields ?? [], steps: d.steps?.length ? d.steps : [{ id: 'step_1', title: '' }] }
}

const ALLOWED_TAGS = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'A', 'UL', 'OL', 'LI', 'H2', 'H3', 'H4', 'SPAN', 'DIV'])

/** Keep simple formatting only (the server sanitises again on save and on render). */
export function sanitizeHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return ''
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''
  root.querySelectorAll('script,style,iframe,object,embed,template,svg,math,link,meta').forEach((n) => n.remove())
  // Children before parents, so unwrapping a parent keeps its already-cleaned children.
  for (const el of Array.from(root.querySelectorAll('*')).reverse()) {
    if (!ALLOWED_TAGS.has(el.tagName)) {
      el.replaceWith(...Array.from(el.childNodes))
      continue
    }
    for (const attr of Array.from(el.attributes)) {
      const keep = el.tagName === 'A' && attr.name === 'href' && /^(https?:|mailto:)/i.test(attr.value.trim())
      if (!keep) el.removeAttribute(attr.name)
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    }
  }
  return root.innerHTML
}
