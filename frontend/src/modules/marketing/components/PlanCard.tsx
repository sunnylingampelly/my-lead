import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { money, percent, type Currency, type PublicPlan } from '../pricing'
import { CtaLink } from './Buttons'

/** A plan card with live price. Pro gets the animated gradient ring and the "Best value" badge. */
export function PlanCard({ plan, currency, gst, compact }: { plan: PublicPlan; currency: Currency; gst: boolean; compact?: boolean }) {
  const pro = plan.key === 'pro'
  return (
    <div
      data-testid={`plan-${plan.key}`}
      className={cn('relative flex flex-col rounded-[1.75rem] border bg-card p-7 text-card-foreground shadow-card sm:p-8', pro && 'mk-ring border-transparent')}
    >
      {pro && (
        <span className="absolute -top-3 left-7 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 px-3 py-1 text-xs font-semibold text-white shadow-lg shadow-indigo-500/30">
          Best value
        </span>
      )}
      <h3 className="text-lg font-semibold">{plan.name}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
      <div className="mt-6 flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-5xl font-semibold tracking-[-0.03em] tabular-nums">{money(plan.price, currency)}</span>
        <span className="whitespace-nowrap text-sm text-muted-foreground">
          /month{plan.price > 0 && gst ? ' + GST' : ''}
        </span>
      </div>
      <p className={cn('mt-2 text-sm font-medium', plan.usage_discount > 0 ? 'text-primary' : 'text-muted-foreground')}>
        {plan.usage_discount > 0 ? `${percent(plan.usage_discount)} off all usage` : 'Usage at standard rates'}
      </p>
      {!compact && (
        <ul className="mt-7 flex-1 space-y-3 text-sm">
          {plan.features.map((f) => (
            <li key={f} className="flex gap-2.5">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      )}
      <CtaLink to="/register" variant={pro ? 'primary' : 'outline'} className={cn('w-full', compact ? 'mt-6' : 'mt-8')} arrow={pro}>
        {pro ? 'Start free, upgrade anytime' : 'Start free'}
      </CtaLink>
    </div>
  )
}

export function PlanCardSkeleton() {
  return <div className="h-[420px] animate-pulse rounded-[1.75rem] border bg-muted/60" aria-hidden />
}
