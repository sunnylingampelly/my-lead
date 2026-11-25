import { AnimatePresence, motion } from 'framer-motion'
import { Check, CheckCheck, Inbox, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DemoFrame } from './DemoFrame'
import { useDemoClock } from './useDemoClock'

const CHECKS = [
  { at: 400, text: 'Header AD-CHAICO approved' },
  { at: 900, text: 'DLT template matched' },
  { at: 1400, text: 'Promotional route · 1 part' },
  { at: 1900, text: 'Inside legal hours' },
  { at: 2400, text: 'Opted-out numbers skipped' },
]

const BUBBLES = [
  { id: 'out', at: 2900, mine: true, text: 'Chai & Co: Diwali hampers are here! 20% off till Sunday. chaico.in/d20 Reply STOP to opt out' },
  { id: 'in', at: 5000, mine: false, text: 'Do you deliver to Kothrud?' },
  { id: 'out2', at: 6700, mine: true, text: 'Yes, Kothrud is covered. Delivery in 2 days.' },
]

/** Pre-send DLT checks ticking, then a two-way conversation on a phone. */
export function SmsDemo({ className }: { className?: string }) {
  const { ref, t } = useDemoClock(10000, { staticAt: 8800 })
  return (
    <DemoFrame ref={ref} title="SMS · Festive offer" className={className} testId="demo-sms">
      <div className="grid min-h-[340px] grid-cols-1 gap-4 sm:grid-cols-[1fr_1.05fr]">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-white/45">
            <ShieldCheck className="size-3.5 text-emerald-300" /> Before sending
          </div>
          <ul className="space-y-1.5">
            {CHECKS.map((c) => {
              const ok = t >= c.at
              return (
                <li key={c.text} className={cn('flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[12px] transition-colors duration-300', ok ? 'border-emerald-400/20 bg-emerald-400/[0.06] text-white/85' : 'border-white/[0.06] text-white/35')}>
                  <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full transition-colors duration-300', ok ? 'bg-emerald-400 text-[#0b0b14]' : 'bg-white/10')}>
                    {ok && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  <span className="truncate">{c.text}</span>
                </li>
              )
            })}
          </ul>
          <AnimatePresence>
            {t > 5400 && (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 flex items-center gap-2 rounded-lg bg-indigo-400/10 px-2.5 py-2 text-[11.5px] text-indigo-100">
                <Inbox className="size-3.5 shrink-0" /> Reply in shared inbox · Arjun
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="mx-auto w-full max-w-[240px] rounded-[1.75rem] border border-white/10 bg-black/40 p-2 shadow-inner">
          <div className="rounded-[1.4rem] bg-[#0e0e17] px-3 pb-4 pt-3">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/15" />
            <div className="text-center text-[11px] font-semibold text-white/80">AD-CHAICO</div>
            <div className="mb-3 text-center text-[10px] text-white/35">Text message</div>
            <div className="flex min-h-[220px] flex-col justify-end gap-2 text-[11.5px] leading-snug">
              <AnimatePresence initial={false}>
                {BUBBLES.filter((b) => t >= b.at).map((b) => (
                  <motion.div
                    key={b.id}
                    layout="position"
                    initial={{ opacity: 0, y: 8, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0 }}
                    className={cn('max-w-[88%] rounded-2xl px-2.5 py-1.5', b.mine ? 'self-start rounded-bl-sm bg-white/[0.09]' : 'self-end rounded-br-sm bg-emerald-500 text-white')}
                  >
                    {b.text}
                  </motion.div>
                ))}
                {t > 3500 && t < 5000 && (
                  <motion.div key="dlv" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-1 text-[10px] text-white/40">
                    <CheckCheck className="size-3 text-sky-300" /> Delivered
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </DemoFrame>
  )
}
