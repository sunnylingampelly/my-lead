import { AnimatePresence, motion } from 'framer-motion'
import { Check, Sparkles, UserPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DemoFrame } from './DemoFrame'
import { typed, useDemoClock } from './useDemoClock'

const FIELDS = [
  { label: 'Full name', value: 'Priya Nair', start: 600, speed: 60 },
  { label: 'Work email', value: 'priya@chaiandco.in', start: 1500, speed: 40 },
  { label: 'Phone', value: '+91 98450 12104', start: 2500, speed: 45 },
]

function Caret() {
  return <motion.span className="ml-px inline-block h-3.5 w-px translate-y-0.5 bg-indigo-300" animate={{ opacity: [1, 0, 1] }} transition={{ duration: 0.9, repeat: Infinity }} />
}

/** A lead form filling itself in, then a "New lead" toast. */
export function FormDemo({ className }: { className?: string }) {
  const { ref, t } = useDemoClock(9000, { staticAt: 6000 })
  const consent = t > 3900
  const pressed = t > 4300 && t < 4700
  const sent = t > 4700
  return (
    <DemoFrame ref={ref} title="chaiandco.in · Request a demo" className={className} testId="demo-lead-forms">
      <div className="relative min-h-[340px]">
        <div className="mx-auto max-w-[340px] rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <div className="text-[15px] font-semibold">Request a demo</div>
          <div className="mt-0.5 text-xs text-white/45">We reply within one working day.</div>
          <div className="mt-4 space-y-2.5">
            {FIELDS.map((f) => {
              const v = typed(f.value, t, f.start, f.speed)
              const active = t >= f.start - 200 && v.length < f.value.length
              return (
                <div key={f.label}>
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-white/40">{f.label}</div>
                  <div
                    className={cn(
                      'flex h-9 items-center rounded-lg border bg-black/20 px-3 text-[13px] transition-colors duration-200',
                      active ? 'border-indigo-400/70 shadow-[0_0_0_3px_rgb(99_102_241/0.18)]' : 'border-white/10',
                    )}
                  >
                    <span className="truncate">{v}</span>
                    {active && <Caret />}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="mt-3 flex items-center gap-2 text-[11px] text-white/55">
            <span className={cn('flex size-4 items-center justify-center rounded border transition-colors duration-200', consent ? 'border-indigo-400 bg-indigo-500' : 'border-white/25')}>
              {consent && <Check className="size-3" />}
            </span>
            Email me offers and updates
          </div>
          <motion.div
            animate={{ scale: pressed ? 0.97 : 1 }}
            className={cn('mt-4 flex h-9 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors duration-300', sent ? 'bg-emerald-500/90' : 'bg-indigo-500')}
          >
            {sent ? (
              <>
                <Check className="size-4" /> Sent
              </>
            ) : (
              'Request a demo'
            )}
          </motion.div>
        </div>

        <AnimatePresence>
          {t > 4900 && t < 8700 && (
            <motion.div
              initial={{ opacity: 0, x: 40, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40 }}
              transition={{ type: 'spring', stiffness: 260, damping: 24 }}
              className="absolute bottom-0 right-0 w-[min(270px,90%)] rounded-xl border border-white/10 bg-[#1b1b2a]/95 p-3 shadow-2xl shadow-black/50 backdrop-blur"
            >
              <div className="flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
                  <UserPlus className="size-3.5" />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold">New lead · Priya Nair</div>
                  <div className="truncate text-[11px] text-white/45">Request a demo · utm: instagram</div>
                </div>
              </div>
              <div className="mt-2.5 space-y-1.5 text-[11px] text-white/60">
                {['Owner: Arjun (round-robin)', 'Consent recorded', 'Welcome workflow started'].map((s, i) => (
                  <motion.div key={s} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 + i * 0.25 }} className="flex items-center gap-1.5">
                    {i === 2 ? <Sparkles className="size-3 text-indigo-300" /> : <Check className="size-3 text-emerald-300" />} {s}
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </DemoFrame>
  )
}
