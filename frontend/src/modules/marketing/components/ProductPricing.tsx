import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Sparkles } from 'lucide-react'
import type { Product } from '../products'
import { channelSoon, discounted, findPlan, formatLimit, guessCurrency, money, percent, usePublicPricing, type Currency } from '../pricing'
import { CurrencyToggle } from './CurrencyToggle'

/** The channel's live rates (and plan limits) on a product page. */
export function ProductPricing({ product }: { product: Product }) {
  const [currency, setCurrency] = useState<Currency>(guessCurrency)
  const q = usePublicPricing(currency)
  const d = q.data
  const starter = findPlan(d, 'starter')
  const pro = findPlan(d, 'pro')
  const { rates = [], limits = [], note } = product.pricing
  const hasRows = rates.length + limits.length > 0
  if (product.soon)
    return (
      <div className="overflow-hidden rounded-[1.75rem] border bg-card p-6 shadow-card sm:p-8" data-testid="product-pricing">
        <h3 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
          {product.name} pricing
          <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-400/15 dark:text-amber-200">Coming soon</span>
        </h3>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">{note}</p>
        <Link to="/pricing" className="group mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary">
          Prices for what's live today <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </Link>
      </div>
    )
  return (
    <div className="overflow-hidden rounded-[1.75rem] border bg-card shadow-card" data-testid="product-pricing">
      <div className="flex flex-col gap-4 border-b p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
        <div className="min-w-0">
          <h3 className="text-xl font-semibold tracking-tight">{product.name} pricing</h3>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">{note}</p>
        </div>
        <CurrencyToggle value={currency} onChange={setCurrency} className="shrink-0 self-start sm:self-auto" />
      </div>
      {hasRows && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[440px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="px-6 py-3 font-medium sm:px-8"> </th>
                <th scope="col" className="px-4 py-3 font-medium">{starter?.name ?? 'Starter'}</th>
                <th scope="col" className="px-4 py-3 font-medium text-primary sm:pr-8">
                  {pro?.name ?? 'Pro'}
                  {pro && pro.usage_discount > 0 && rates.length > 0 && <span className="ml-1.5 normal-case tracking-normal">({percent(pro.usage_discount)} off)</span>}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rates.map((r) => (
                <tr key={r.key}>
                  <th scope="row" className="px-6 py-4 text-left font-medium sm:px-8">
                    {r.label}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {r.unit}
                      {r.key.startsWith('voice') && channelSoon(d, 'voice') && ' · coming soon in the UAE'}
                    </span>
                  </th>
                  <td className="px-4 py-4 tabular-nums">{d ? money(d.rates[r.key], currency) : <span className="inline-block h-4 w-14 animate-pulse rounded bg-muted" />}</td>
                  <td className="px-4 py-4 font-semibold tabular-nums text-primary sm:pr-8">
                    {d && pro ? money(discounted(d.rates[r.key], pro.usage_discount), currency) : <span className="inline-block h-4 w-14 animate-pulse rounded bg-muted" />}
                  </td>
                </tr>
              ))}
              {limits.map((l) => (
                <tr key={l.key}>
                  <th scope="row" className="px-6 py-4 text-left font-medium sm:px-8">{l.label}</th>
                  <td className="px-4 py-4 tabular-nums">{starter ? formatLimit(starter.limits[l.key]) : '…'}</td>
                  <td className="px-4 py-4 font-semibold tabular-nums sm:pr-8">{pro ? formatLimit(pro.limits[l.key]) : '…'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-col gap-3 bg-muted/40 px-6 py-4 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
          {pro ? `Pro is ${money(pro.price, currency)}/month${d?.gst_rate ? ' + GST' : ''}.` : 'Starter has no monthly fee.'}
          {d?.gst_rate ? ` Wallet top-ups add ${d.gst_rate}% GST.` : ''}
          {d?.reverse_charge ? ' No UAE VAT is charged (reverse charge; TRN required).' : ''}
        </span>
        <Link to="/pricing" className="group inline-flex shrink-0 items-center gap-1 font-semibold text-primary">
          All prices <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </Link>
      </div>
      {q.isError && <p className="px-6 pb-4 text-sm text-muted-foreground sm:px-8">Prices couldn’t load right now.</p>}
    </div>
  )
}
