import * as React from 'react'
import { Mail, MessageSquare, PhoneCall } from 'lucide-react'
import { Badge } from '@/components/ui/misc'
import { Input, Select } from '@/components/ui/form-controls'
import { PRIMARY_COUNTRIES, OTHER_COUNTRIES } from '@/lib/regions'
import { cn } from '@/lib/utils'
import type { Channel, ContactListItem, ContactStatus } from '@/types/audience'

export const CHANNEL_META: Record<Channel, { label: string; icon: typeof Mail }> = {
  email: { label: 'Email', icon: Mail },
  sms: { label: 'SMS', icon: MessageSquare },
  voice: { label: 'Voice', icon: PhoneCall },
}

export function StatusBadge({ status }: { status: ContactStatus }) {
  const variant = { active: 'success', unsubscribed: 'warning', bounced: 'destructive', blocked: 'destructive' } as const
  return (
    <Badge variant={variant[status]} className="capitalize">
      {status}
    </Badge>
  )
}

/** One dot per channel: green = consented, amber = unsubscribed, grey = no consent. */
export function ConsentDots({ c }: { c: ContactListItem }) {
  return (
    <div className="flex items-center gap-1.5">
      {(['email', 'sms', 'voice'] as Channel[]).map((ch) => {
        const unsub = c[`${ch}_unsubscribed`]
        const ok = c[`${ch}_consent`] && !unsub
        const Icon = CHANNEL_META[ch].icon
        const label = `${CHANNEL_META[ch].label}: ${unsub ? 'unsubscribed' : ok ? 'consented' : 'no consent'}`
        return (
          <span
            key={ch}
            title={label}
            aria-label={label}
            className={cn(
              'flex size-6 items-center justify-center rounded-full',
              ok ? 'bg-success-soft text-success-strong' : unsub ? 'bg-warning-soft text-warning-strong' : 'bg-muted text-muted-foreground/50',
            )}
          >
            <Icon className="size-3.5" />
          </span>
        )
      })}
    </div>
  )
}

export function Checkbox({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn('size-4 cursor-pointer rounded border-input accent-[hsl(var(--primary))]', className)}
      {...props}
    />
  )
}

/** Country code picker + number. India and the US first. The server parses and validates to E.164. */
export function PhoneInput({
  country,
  onCountry,
  id,
  ...props
}: { country: string; onCountry: (c: string) => void } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex gap-2">
      <Select value={country} onChange={(e) => onCountry(e.target.value)} aria-label="Phone country" className="w-28">
        <optgroup label="Primary markets">
          {PRIMARY_COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.flag} {c.dial}
            </option>
          ))}
        </optgroup>
        <optgroup label="Other">
          {OTHER_COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.flag} {c.dial}
            </option>
          ))}
        </optgroup>
      </Select>
      <Input id={id} type="tel" inputMode="tel" placeholder={country === 'IN' ? '98765 43210' : '(415) 555-2671'} {...props} />
    </div>
  )
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
  tone?: 'default' | 'success' | 'warning'
}) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-card">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {Icon && (
          <span
            className={cn(
              'flex size-7 items-center justify-center rounded-md',
              tone === 'success' ? 'bg-success-soft text-success-strong' : tone === 'warning' ? 'bg-warning-soft text-warning-strong' : 'bg-accent text-primary',
            )}
          >
            <Icon className="size-4" />
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

export const TAG_COLORS: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-500/15 dark:text-slate-300',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-500/20 dark:bg-indigo-500/15 dark:text-indigo-300',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-500/20 dark:bg-emerald-500/15 dark:text-emerald-300',
  amber: 'bg-amber-50 text-amber-800 ring-amber-500/20 dark:bg-amber-500/15 dark:text-amber-300',
  rose: 'bg-rose-50 text-rose-700 ring-rose-500/20 dark:bg-rose-500/15 dark:text-rose-300',
  sky: 'bg-sky-50 text-sky-700 ring-sky-500/20 dark:bg-sky-500/15 dark:text-sky-300',
  violet: 'bg-violet-50 text-violet-700 ring-violet-500/20 dark:bg-violet-500/15 dark:text-violet-300',
}

export function TagChip({ name, color, onRemove }: { name: string; color?: string; onRemove?: () => void }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TAG_COLORS[color ?? 'slate'] ?? TAG_COLORS.slate)}>
      {name}
      {onRemove && (
        <button type="button" onClick={onRemove} className="-mr-0.5 rounded-full px-0.5 hover:bg-black/10" aria-label={`Remove tag ${name}`}>
          ×
        </button>
      )}
    </span>
  )
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
      <span className="text-muted-foreground">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        <button className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-40" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span className="text-xs text-muted-foreground">
          {page} / {pages}
        </span>
        <button className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-40" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  )
}
