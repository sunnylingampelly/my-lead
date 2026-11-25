import { useCallback, useId, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Bot, Mail, PhoneCall, Sparkles, TrendingDown, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AnimatedNumber } from '../components/AnimatedNumber'
import { channelSoon, comparePlans, findPlan, money, moneyTotal, percent, type Currency, type PublicPricing, type RateKey, type Volumes } from '../pricing'

type Field = { key: keyof Volumes; label: string; unit: string; icon: LucideIcon; max: number; step: number; rate: RateKey }

const FIELDS: Field[] = [
  { key: 'emails', label: 'Emails per month', unit: 'emails', icon: Mail, max: 500_000, step: 1000, rate: 'email' },
  { key: 'voiceMinutes', label: 'Voice call minutes', unit: 'minutes', icon: PhoneCall, max: 20_000, step: 100, rate: 'voice_minute' },
  { key: 'aiMinutes', label: 'AI calling minutes', unit: 'minutes', icon: Sparkles, max: 10_000, step: 50, rate: 'voice_ai_minute' },
  { key: 'chatReplies', label: 'AI chat replies', unit: 'replies', icon: Bot, max: 20_000, step: 100, rate: 'chat_reply' },
]

const PRESETS: { label: string; v: Volumes }[] = [
  { label: 'Just starting', v: { emails: 5000, sms: 0, voiceMinutes: 0, aiMinutes: 100, chatReplies: 300 } },
  { label: 'Growing', v: { emails: 25000, sms: 0, voiceMinutes: 500, aiMinutes: 500, chatReplies: 2000 } },
  { label: 'Scaling', v: { emails: 100000, sms: 0, voiceMinutes: 2000, aiMinutes: 2000, chatReplies: 5000 } },
]

const num = (n: number) => Math.round(n).toLocaleString('en-IN')

function Slider({ f, value, onChange, rateLabel }: { f: Field; value: number; onChange: (n: number) => void; rateLabel: string }) {
  const id = useId()
  const pct = (value / f.max) * 100
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="flex min-w-0 items-center gap-2.5 font-medium">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <f.icon className="size-4" aria-hidden />
          </span>
          <span className="truncate">{f.label}</span>
        </label>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={f.max * 10}
          step={f.step}
          value={value}
          aria-label={`${f.label}, exact number`}
          onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) || 0)))}
          className="h-9 w-28 shrink-0 rounded-lg border bg-background px-2.5 text-right text-sm font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={f.max}
        step={f.step}
        value={Math.min(value, f.max)}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={`${num(value)} ${f.unit}`}
        className="mk-range mt-4 w-full"
        style={{ ['--mk-fill' as string]: `${Math.min(100, pct)}%` }}
      />
      <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
        <span>{rateLabel}</span>
        <span>
          up to {num(f.max)} {f.unit}
        </span>
      </div>
    </div>
  )
}

/** Monthly cost on Starter vs Pro for the visitor's volumes, with the break-even point. */
export function Calculator({ data, currency }: { data: PublicPricing | undefined; currency: Currency }) {
  const [v, setV] = useState<Volumes>(PRESETS[0].v)
  const starter = findPlan(data, 'starter')
  const pro = findPlan(data, 'pro')
  const fmt = useCallback((n: number) => moneyTotal(n, currency), [currency])
  const result = useMemo(() => (data && starter && pro ? comparePlans(starter, pro, data.rates, v) : null), [data, starter, pro, v])
  const gst = currency === 'INR' && data?.gst_rate ? data.gst_rate : null

  const plans = result && starter && pro
    ? [
        { key: 'starter' as const, name: starter.name, total: result.starter, sub: 'Usage at standard rates, no monthly fee' },
        { key: 'pro' as const, name: pro.name, total: result.pro, sub: `${money(pro.price, currency)} fee + usage at ${percent(pro.usage_discount)} off` },
      ]
    : []
  const be = result?.breakEven ?? null
  const fill = be ? Math.min(1, result!.listUsage / be) : 0

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.25fr_1fr]" data-testid="calculator">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm text-muted-foreground">Try a preset:</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setV(p.v)}
              className={cn('rounded-full border px-3.5 py-1.5 text-sm font-medium transition', JSON.stringify(p.v) === JSON.stringify(v) ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:border-primary/40')}
            >
              {p.label}
            </button>
          ))}
        </div>
        {FIELDS.map((f) => (
          <div key={f.key}>
            <Slider
              f={f}
              value={v[f.key]}
              onChange={(n) => setV((cur) => ({ ...cur, [f.key]: n }))}
              rateLabel={
                data
                  ? `${money(data.rates[f.rate], currency)} each on Starter${
                      (f.key === 'voiceMinutes' || f.key === 'aiMinutes') && channelSoon(data, 'voice')
                        ? ' · coming soon in the UAE'
                        : ''
                    }`
                  : '…'
              }
            />
          </div>
        ))}
      </div>

      <div className="min-w-0">
        <div className="mk-ink relative overflow-hidden rounded-[1.75rem] p-6 shadow-[0_40px_100px_-40px_rgb(79_70_229/0.6)] sm:p-8 lg:sticky lg:top-24" data-cheaper={result?.cheaper ?? ''} data-testid="calc-result">
          <div className="pointer-events-none absolute -right-20 -top-20 size-72 rounded-full bg-[radial-gradient(closest-side,rgb(99_102_241/0.45),transparent)]" aria-hidden />
          <p className="relative text-xs font-semibold uppercase tracking-[0.16em] text-indigo-200/80">Your estimated month</p>
          <div className="relative mt-5 space-y-3" aria-live="polite">
            {plans.length === 0 && <div className="h-48 animate-pulse rounded-2xl bg-white/[0.06]" />}
            {plans.map((p) => {
              const best = result?.cheaper === p.key
              return (
                <motion.div
                  key={p.key}
                  layout
                  className={cn('relative rounded-2xl border p-4 transition-colors duration-300', best ? 'border-indigo-300/60 bg-white/[0.08]' : 'border-white/10 bg-white/[0.02]')}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-white">{p.name}</span>
                    {best && (
                      <motion.span initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300" data-testid={`calc-cheaper-${p.key}`}>
                        Cheaper
                      </motion.span>
                    )}
                  </div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <AnimatedNumber value={p.total} format={fmt} className="text-3xl font-semibold tracking-tight tabular-nums text-white sm:text-4xl" testId={`calc-${p.key}-total`} />
                    <span className="text-sm text-white/50">/month</span>
                  </div>
                  <p className="mt-1 text-xs text-white/50">{p.sub}</p>
                </motion.div>
              )
            })}
          </div>
          {result && (
            <div className="relative mt-6 space-y-4 text-sm">
              {result.cheaper !== 'equal' && result.savings > 0 && (
                <p className="flex items-center gap-2 text-white/80">
                  <TrendingDown className="size-4 shrink-0 text-emerald-300" aria-hidden />
                  {result.cheaper === 'pro' ? 'Pro' : 'Starter'} saves you {moneyTotal(result.savings, currency)} a month.
                </p>
              )}
              {be !== null && (
                <div>
                  <div className="flex justify-between text-xs text-white/55">
                    <span>Usage at Starter rates: {moneyTotal(result.listUsage, currency)}</span>
                    <span>Break-even {moneyTotal(be, currency)}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                    <motion.div className="h-full origin-left rounded-full bg-gradient-to-r from-indigo-400 via-violet-400 to-emerald-300" animate={{ scaleX: fill }} transition={{ type: 'spring', stiffness: 120, damping: 24 }} />
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-white/55" data-testid="calc-break-even">
                    Pro pays for itself once your usage passes {moneyTotal(be, currency)} a month at Starter rates.
                  </p>
                </div>
              )}
              <p className="border-t border-white/10 pt-4 text-xs text-white/45">
                {gst ? `+ ${gst}% GST on top-ups. ` : ''}Estimates only; you are charged for what you actually send. AI calls and voice are billed per started minute.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
