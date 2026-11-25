import { AnimatePresence, motion } from 'framer-motion'
import { CalendarClock, Check, PhoneCall, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DemoFrame } from './DemoFrame'
import { useDemoClock } from './useDemoClock'

const LINES = [
  { at: 1500, end: 3600, who: 'agent', text: 'Hi Priya, this is Maya from Chai & Co. You asked about office catering. Is now a good time?' },
  { at: 3800, end: 5300, who: 'lead', text: 'Yes. We’re about 40 people, three days a week.' },
  { at: 5600, end: 7300, who: 'agent', text: 'Lovely. Our team can send a quote today. When should someone call you back?' },
  { at: 7600, end: 8600, who: 'lead', text: 'Thursday at 11 works.' },
] as const

const BARS = 36

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** An AI agent on a live call: waveform, transcript lines and the outcome written back. */
export function VoiceDemo({ className, compact }: { className?: string; compact?: boolean }) {
  const { ref, t } = useDemoClock(12500, { staticAt: 10500 })
  const connected = t > 1200
  const speaking = LINES.find((l) => t >= l.at && t < l.end)
  const shown = LINES.filter((l) => t >= l.at)
  return (
    <DemoFrame ref={ref} title="AI call · Catering enquiry" className={className} testId="demo-voice">
      <div className={cn('flex flex-col', compact ? 'min-h-[300px]' : 'min-h-[340px]')}>
        <div className="flex items-center gap-3">
          <span className="relative flex size-10 items-center justify-center rounded-full bg-gradient-to-br from-indigo-400 to-violet-500">
            <PhoneCall className="size-4" />
            {!connected && <motion.span className="absolute inset-0 rounded-full border border-indigo-300" animate={{ scale: [1, 1.5], opacity: [0.8, 0] }} transition={{ duration: 1.1, repeat: Infinity }} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold">Maya (AI) → Priya Nair</div>
            <div className="truncate text-[11px] text-white/45">Managed number · 160 series · English (India)</div>
          </div>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums', connected ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/[0.07] text-white/60')}>
            {connected ? clock(t - 1200) : 'Ringing'}
          </span>
        </div>

        {/* Waveform: bar heights follow whoever is speaking. */}
        <div className="mt-4 flex h-14 items-center justify-center gap-[3px] rounded-xl border border-white/[0.06] bg-white/[0.02] px-3">
          {Array.from({ length: BARS }, (_, i) => {
            const amp = speaking ? 0.25 + 0.75 * Math.abs(Math.sin(t / 140 + i * 0.7) * Math.cos(t / 330 + i * 0.3)) : 0.08
            return (
              <span
                key={i}
                className={cn('h-10 w-[3px] rounded-full transition-transform duration-100 ease-linear', speaking?.who === 'lead' ? 'bg-emerald-300/80' : 'bg-indigo-300/90')}
                style={{ transform: `scaleY(${amp})` }}
              />
            )
          })}
        </div>

        <div className="mt-3 flex flex-1 flex-col justify-end gap-2 overflow-hidden text-[12.5px] leading-snug">
          <AnimatePresence initial={false}>
            {shown.slice(compact ? -2 : -3).map((l) => (
              <motion.div key={l.at} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} className="flex gap-2">
                <span className={cn('mt-0.5 shrink-0 text-[10px] font-semibold uppercase tracking-wider', l.who === 'agent' ? 'text-indigo-300' : 'text-emerald-300')}>
                  {l.who === 'agent' ? 'Maya' : 'Priya'}
                </span>
                <span className="text-white/80">{l.text}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <div className="mt-3 flex min-h-[28px] flex-wrap gap-1.5 text-[11px]">
          <AnimatePresence>
            {t > 9000 &&
              [
                { icon: Sparkles, text: 'Interested', cls: 'bg-indigo-400/15 text-indigo-100' },
                { icon: CalendarClock, text: 'Callback Thu 11:00', cls: 'bg-white/[0.07] text-white/75' },
                { icon: Check, text: 'Task for Arjun', cls: 'bg-emerald-400/15 text-emerald-300' },
              ].map((c, i) => (
                <motion.span key={c.text} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ delay: i * 0.2 }} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-1 font-medium', c.cls)}>
                  <c.icon className="size-3" /> {c.text}
                </motion.span>
              ))}
          </AnimatePresence>
        </div>
      </div>
    </DemoFrame>
  )
}
