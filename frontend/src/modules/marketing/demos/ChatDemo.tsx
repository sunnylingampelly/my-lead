import { AnimatePresence, motion } from 'framer-motion'
import { BookOpen, Bot, Check, UserRoundCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DemoFrame } from './DemoFrame'
import { streamed, useDemoClock } from './useDemoClock'

type Msg = { id: string; who: 'visitor' | 'bot'; text: string; at: number; stream?: boolean }

const SCRIPT: Msg[] = [
  { id: 'v1', who: 'visitor', text: 'Do you deliver to Pune?', at: 400 },
  { id: 'b1', who: 'bot', text: 'Yes! We deliver across Pune in 2 days, and orders over ₹999 ship free. Shall I book a tasting call for your office?', at: 1700, stream: true },
  { id: 'v2', who: 'visitor', text: 'Yes please, tomorrow 11 am works.', at: 4700 },
  { id: 'b2', who: 'bot', text: 'Booked for tomorrow at 11 am. What’s the best number to reach you?', at: 5800, stream: true },
  { id: 'v3', who: 'visitor', text: '98450 12104', at: 7700 },
]

function Dots() {
  return (
    <div className="flex w-fit gap-1 rounded-2xl rounded-bl-sm bg-white/[0.07] px-3 py-2.5">
      {[0, 1, 2].map((i) => (
        <motion.span key={i} className="size-1.5 rounded-full bg-white/60" animate={{ y: [0, -3, 0], opacity: [0.4, 1, 0.4] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }} />
      ))}
    </div>
  )
}

/** A website chat: the visitor types, the AI streams its answer, cites its source and captures the lead. */
export function ChatDemo({ className, title = 'chaiandco.in · Website chat' }: { className?: string; title?: string }) {
  const { ref, t } = useDemoClock(11500, { staticAt: 9500 })
  const visible = SCRIPT.filter((m) => t >= m.at)
  const typing = (t > 900 && t < 1700) || (t > 5100 && t < 5800)
  return (
    <DemoFrame ref={ref} title={title} className={className} testId="demo-chatbot" bodyClassName="p-0 sm:p-0">
      <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
        <span className="relative flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-indigo-400 to-violet-500">
          <Bot className="size-4" />
          <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[#12121c] bg-emerald-400" />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">Maya · AI assistant</div>
          <div className="truncate text-[11px] text-white/45">Trained on 3 pages, 24 FAQs and a price list</div>
        </div>
      </div>
      <div className="flex h-[300px] flex-col justify-end gap-2 overflow-hidden px-4 py-3 text-[13px] leading-snug">
        <AnimatePresence initial={false}>
          {visible.map((m) => {
            const text = m.stream ? streamed(m.text, t, m.at, 70) : m.text
            return (
              <motion.div
                key={m.id}
                layout="position"
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                className={cn(
                  'w-fit max-w-[85%] rounded-2xl px-3 py-2',
                  m.who === 'visitor' ? 'ml-auto rounded-br-sm bg-indigo-500 text-white' : 'rounded-bl-sm bg-white/[0.07] text-white/90',
                )}
              >
                {text}
              </motion.div>
            )
          })}
          {t > 3500 && (
            <motion.div key="src" layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-1.5 text-[11px] text-white/45">
              <BookOpen className="size-3" /> Answered from <span className="text-indigo-200">Delivery FAQ</span>
            </motion.div>
          )}
          {typing && (
            <motion.div key="typing" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Dots />
            </motion.div>
          )}
          {t > 8300 && (
            <motion.div
              key="lead"
              layout="position"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]"
            >
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-1 font-medium text-emerald-300">
                <Check className="size-3" /> Lead captured · Priya
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.07] px-2 py-1 text-white/70">
                <UserRoundCheck className="size-3" /> Call booked · 11:00
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="border-t border-white/[0.07] px-4 py-3">
        <div className="flex h-9 items-center rounded-full border border-white/10 bg-black/20 px-3 text-[12px] text-white/35">Type a message…</div>
      </div>
    </DemoFrame>
  )
}
