import { Fragment, type ReactNode } from 'react'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { findPlan, formatLimit, money, percent, type Currency, type LimitKey, type PublicPricing } from '../pricing'

const LIMITS: { key: LimitKey; label: string }[] = [
  { key: 'applications', label: 'Applications (brands)' },
  { key: 'members', label: 'Team members' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'lead_forms', label: 'Lead forms' },
  { key: 'chatbots', label: 'Website chatbots' },
  { key: 'chat_seats', label: 'Live-chat agents' },
  { key: 'voice_agents', label: 'AI calling agents' },
]

/** AI Team features: pay per use on both plans, with a daily fair-use limit. */
const AI_FEATURES: { key: LimitKey; label: string }[] = [
  { key: 'ai_assistant_messages_per_day', label: 'AI Assistant' },
  { key: 'ai_agent_runs_per_day', label: 'AI agents (runs)' },
]

const BOTH = [
  'Email and voice campaigns (SMS coming soon)',
  'AI chatbot and shared live-chat inbox',
  'CRM, pipelines and tasks',
  'Automation journeys',
  'Analytics for every channel',
  'AI Team: Slack approvals and the automation AI step',
  'Simulation mode before going live',
  'TRAI, TCPA, UAE TDRA, consent and opt-out tools',
  'Two-factor sign-in and audit log',
]

const yes = (
  <>
    <Check className="size-4 text-primary" aria-hidden />
    <span className="sr-only">Included</span>
  </>
)

/** Starter vs Pro, every number from the API. Column headers stick below the site header. */
export function Comparison({ data, currency }: { data: PublicPricing | undefined; currency: Currency }) {
  const starter = findPlan(data, 'starter')
  const pro = findPlan(data, 'pro')
  const branded = (p: typeof pro) => !p?.features.some((f) => /no signalcraft branding/i.test(f))
  const gst = currency === 'INR' && data?.gst_rate ? ' + GST' : ''
  const wait = <span className="inline-block h-4 w-16 animate-pulse rounded bg-muted" />

  const groups: { title: string; rows: { label: string; s: ReactNode; p: ReactNode }[] }[] = [
    {
      title: 'Price',
      rows: [
        {
          label: 'Monthly fee',
          s: starter ? `${money(starter.price, currency)}` : wait,
          p: pro ? `${money(pro.price, currency)}${pro.price > 0 ? gst : ''}` : wait,
        },
        {
          label: 'Discount on all usage',
          s: starter ? (starter.usage_discount > 0 ? percent(starter.usage_discount) : <Minus className="size-4 text-muted-foreground" aria-label="None" />) : wait,
          p: pro ? percent(pro.usage_discount) : wait,
        },
      ],
    },
    {
      title: 'Limits',
      rows: LIMITS.map((l) => ({
        label: l.label,
        s: starter ? formatLimit(starter.limits[l.key]) : wait,
        p: pro ? formatLimit(pro.limits[l.key]) : wait,
      })),
    },
    {
      title: 'AI Team',
      rows: AI_FEATURES.map((l) => {
        const cell = (p: typeof pro) =>
          p ? (
            <span className="flex flex-col">
              <span>Pay per use</span>
              <span className="text-xs text-muted-foreground">Fair-use limit: {formatLimit(p.limits[l.key])}/day</span>
            </span>
          ) : (
            wait
          )
        return { label: l.label, s: cell(starter), p: cell(pro) }
      }),
    },
    {
      title: 'Branding',
      rows: [
        {
          label: 'Signalcraft branding on forms',
          s: starter ? (branded(starter) ? 'Shown' : 'Removed') : wait,
          p: pro ? (branded(pro) ? 'Shown' : 'Removed') : wait,
        },
      ],
    },
    { title: 'Included on both plans', rows: BOTH.map((label) => ({ label, s: yes, p: yes })) },
  ]

  return (
    <div className="rounded-[1.75rem] border bg-card shadow-card" data-testid="comparison-table">
      <table className="w-full table-fixed border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Starter and Pro compared</caption>
        <colgroup>
          <col className="w-[46%] sm:w-1/2" />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="sticky top-16 z-10 rounded-tl-[1.75rem] border-b bg-card/95 px-4 py-5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur sm:px-8">
              Compare plans
            </th>
            {[starter, pro].map((p, i) => (
              <th
                key={i}
                scope="col"
                className={cn('sticky top-16 z-10 border-b bg-card/95 px-3 py-5 text-left backdrop-blur sm:px-6', i === 1 && 'rounded-tr-[1.75rem]')}
              >
                <span className={cn('block text-base font-semibold', i === 1 && 'text-primary')}>{p?.name ?? (i ? 'Pro' : 'Starter')}</span>
                <span className="block text-xs font-normal tabular-nums text-muted-foreground">
                  {p ? `${money(p.price, currency)}/mo${p.price > 0 ? gst : ''}` : '…'}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <Fragment key={g.title}>
              <tr>
                <th colSpan={3} scope="colgroup" className="bg-muted/50 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:px-8">
                  {g.title}
                </th>
              </tr>
              {g.rows.map((r) => (
                <tr key={r.label} className="transition-colors hover:bg-muted/30">
                  <th scope="row" className="border-b px-4 py-3.5 text-left font-normal text-foreground sm:px-8">
                    {r.label}
                  </th>
                  <td className="border-b px-3 py-3.5 tabular-nums sm:px-6">
                    <span className="flex items-center">{r.s}</span>
                  </td>
                  <td className="border-b bg-primary/[0.03] px-3 py-3.5 font-medium tabular-nums sm:px-6">
                    <span className="flex items-center">{r.p}</span>
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}
