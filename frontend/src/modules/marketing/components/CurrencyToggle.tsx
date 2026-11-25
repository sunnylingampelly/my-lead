import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { CURRENCIES, CURRENCY_LABEL, type Currency } from '../pricing'

/** INR/AED/USD switch, a radio group with a sliding highlight. */
export function CurrencyToggle({ value, onChange, tone = 'light', className }: { value: Currency; onChange: (c: Currency) => void; tone?: 'light' | 'dark'; className?: string }) {
  return (
    <div
      role="radiogroup"
      aria-label="Currency"
      className={cn('inline-flex rounded-full p-1', tone === 'dark' ? 'border border-white/10 bg-white/[0.05]' : 'border bg-card', className)}
      onKeyDown={(e) => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault()
          const group = e.currentTarget
          const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1
          const i = CURRENCIES.indexOf(value)
          const next = CURRENCIES[(i + step + CURRENCIES.length) % CURRENCIES.length]
          onChange(next)
          requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-cur="${next}"]`)?.focus())
        }
      }}
    >
      {CURRENCIES.map((c) => {
        const on = value === c
        return (
          <button
            key={c}
            type="button"
            role="radio"
            data-cur={c}
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(c)}
            className={cn(
              'relative rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
              on ? (tone === 'dark' ? 'text-[#0b0b14]' : 'text-primary-foreground') : tone === 'dark' ? 'text-white/65 hover:text-white' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {on && (
              <motion.span
                layoutId={`cur-pill-${tone}`}
                className={cn('absolute inset-0 rounded-full', tone === 'dark' ? 'bg-white' : 'bg-primary')}
                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
              />
            )}
            <span className="relative">{CURRENCY_LABEL[c]}</span>
          </button>
        )
      })}
    </div>
  )
}
