import { motion } from 'framer-motion'
import { ArrowRight, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MiniVisual as Spec } from '../products'

const EASE = [0.22, 1, 0.36, 1] as const
const list = { hidden: {}, show: { transition: { staggerChildren: 0.09, delayChildren: 0.15 } } }
const pop = { hidden: { opacity: 0, y: 8, scale: 0.96 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.5, ease: EASE } } }

/** Small illustrations for feature blocks; they animate in once when scrolled into view. */
export function MiniVisual({ spec, className }: { spec: Spec; className?: string }) {
  const frame = cn(
    'relative overflow-hidden rounded-3xl border bg-gradient-to-br from-accent/70 via-card to-card p-6 shadow-card sm:p-8',
    className,
  )
  const inView = { initial: 'hidden', whileInView: 'show', viewport: { once: true, margin: '-60px' }, variants: list } as const

  switch (spec.kind) {
    case 'chips':
      return (
        <div className={frame} aria-hidden>
          <div className="mk-grid-soft absolute inset-0 opacity-60" />
          <motion.div {...inView} className="relative flex flex-wrap gap-2">
            {spec.items.map((c, i) => (
              <motion.span
                key={c}
                variants={pop}
                className={cn(
                  'rounded-full border px-3.5 py-1.5 text-sm font-medium shadow-sm',
                  i === 0 ? 'border-primary/30 bg-primary text-primary-foreground' : 'bg-card text-foreground',
                )}
              >
                {c}
              </motion.span>
            ))}
          </motion.div>
        </div>
      )
    case 'checks':
      return (
        <div className={frame} aria-hidden>
          <motion.ul {...inView} className="relative space-y-2.5">
            {spec.items.map((c) => (
              <motion.li key={c} variants={pop} className="flex items-center gap-3 rounded-2xl border bg-card px-4 py-3 text-sm shadow-sm">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success-strong">
                  <Check className="size-3.5" strokeWidth={3} />
                </span>
                <span className="min-w-0 truncate">{c}</span>
              </motion.li>
            ))}
          </motion.ul>
        </div>
      )
    case 'steps':
      return (
        <div className={frame} aria-hidden>
          <motion.ol {...inView} className="relative flex flex-wrap items-center gap-2">
            {spec.items.map((s, i) => (
              <motion.li key={s} variants={pop} className="flex items-center gap-2">
                <span className={cn('rounded-xl border px-3 py-2 text-sm font-medium shadow-sm', i === spec.items.length - 1 ? 'border-primary/30 bg-primary text-primary-foreground' : 'bg-card')}>
                  {s}
                </span>
                {i < spec.items.length - 1 && <ArrowRight className="size-4 text-muted-foreground" />}
              </motion.li>
            ))}
          </motion.ol>
        </div>
      )
    case 'bars':
      return (
        <div className={frame} aria-hidden>
          <motion.div {...inView} className="relative space-y-3.5">
            {spec.items.map((b) => (
              <motion.div key={b.label} variants={pop}>
                <div className="mb-1.5 flex justify-between text-sm">
                  <span className="font-medium">{b.label}</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                  <motion.div
                    className="h-full origin-left rounded-full bg-gradient-to-r from-indigo-500 to-violet-500"
                    initial={{ scaleX: 0 }}
                    whileInView={{ scaleX: b.value }}
                    viewport={{ once: true }}
                    transition={{ duration: 1.1, ease: EASE, delay: 0.25 }}
                  />
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      )
    case 'code':
      return (
        <div className={cn(frame, 'from-[#13131f] via-[#13131f] to-[#191930] text-white')} aria-hidden>
          <motion.pre {...inView} className="relative overflow-hidden font-mono text-[13px] leading-7 text-indigo-100/90">
            {spec.lines.map((l) => (
              <motion.div key={l} variants={pop} className="truncate">
                <span className="mr-3 select-none text-white/25">›</span>
                {l}
              </motion.div>
            ))}
          </motion.pre>
        </div>
      )
    case 'chat':
      return (
        <div className={frame} aria-hidden>
          <motion.div {...inView} className="relative space-y-2.5 text-sm">
            {spec.lines.map((l) => (
              <motion.div
                key={l.text}
                variants={pop}
                className={cn('w-fit max-w-[88%] rounded-2xl px-3.5 py-2 shadow-sm', l.who === 'them' ? 'ml-auto rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm border bg-card')}
              >
                {l.text}
              </motion.div>
            ))}
            {spec.tag && (
              <motion.div variants={pop} className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2.5 py-1 text-xs font-medium text-success-strong">
                <Check className="size-3" /> {spec.tag}
              </motion.div>
            )}
          </motion.div>
        </div>
      )
  }
}
