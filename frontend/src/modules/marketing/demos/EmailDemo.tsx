import { motion } from 'framer-motion'
import { Check, CheckCheck, Eye, Mail, MousePointerClick } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DemoFrame } from './DemoFrame'
import { progress, useDemoClock } from './useDemoClock'

const TOTAL = 12480
const ROWS = [
  { name: 'Priya Nair', email: 'priya@chaiandco.in', sent: 900, open: 3600, click: 5200 },
  { name: 'Rahul Mehta', email: 'rahul@kitelabs.io', sent: 1500, open: 4300 },
  { name: 'Ananya Rao', email: 'ananya.rao@gmail.com', sent: 2100, open: 5600 },
  { name: 'Vikram Shah', email: 'vikram@northwind.co', sent: 2700 },
  { name: 'Meera Iyer', email: 'meera@bloomsalons.in', sent: 3300, open: 6200 },
]

function Status({ t, row }: { t: number; row: (typeof ROWS)[number] }) {
  const state = row.click && t > row.click ? 'clicked' : row.open && t > row.open ? 'opened' : t > row.sent + 500 ? 'delivered' : t > row.sent ? 'sent' : 'queued'
  const map = {
    queued: { icon: Mail, label: 'Queued', cls: 'text-white/35 bg-white/[0.04]' },
    sent: { icon: Check, label: 'Sent', cls: 'text-white/70 bg-white/[0.06]' },
    delivered: { icon: CheckCheck, label: 'Delivered', cls: 'text-sky-300 bg-sky-400/10' },
    opened: { icon: Eye, label: 'Opened', cls: 'text-emerald-300 bg-emerald-400/10' },
    clicked: { icon: MousePointerClick, label: 'Clicked', cls: 'text-violet-200 bg-violet-400/15' },
  } as const
  const s = map[state]
  return (
    <motion.span key={state} initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium', s.cls)}>
      <s.icon className="size-3" /> {s.label}
    </motion.span>
  )
}

/** A campaign sending: progress, per-recipient ticks and the first results. */
export function EmailDemo({ className }: { className?: string }) {
  const { ref, t } = useDemoClock(10000, { staticAt: 8500 })
  const p = progress(t, 500, 4500)
  const r = progress(t, 4000, 7000)
  const stats = [
    { label: 'Delivered', value: 98.6 * r },
    { label: 'Opened', value: 46.2 * r },
    { label: 'Clicked', value: 11.8 * r },
  ]
  return (
    <DemoFrame ref={ref} title="Email · Diwali hampers campaign" className={className} testId="demo-email">
      <div className="min-h-[340px]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold">Diwali hampers · 20% off</div>
            <div className="truncate text-[11px] text-white/45">To: Pune foodies segment · from hello@chaiandco.in</div>
          </div>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium', p < 1 ? 'bg-indigo-400/15 text-indigo-200' : 'bg-emerald-400/15 text-emerald-300')}>
            {p < 1 ? 'Sending' : 'Sent'}
          </span>
        </div>
        <div className="mt-4">
          <div className="flex justify-between text-[11px] text-white/50">
            <span>{Math.round(TOTAL * p).toLocaleString('en-IN')} of {TOTAL.toLocaleString('en-IN')}</span>
            <span>{Math.round(p * 100)}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
            <div className="h-full origin-left rounded-full bg-gradient-to-r from-indigo-400 to-violet-400 transition-transform duration-100" style={{ transform: `scaleX(${p})` }} />
          </div>
        </div>
        <ul className="mt-4 divide-y divide-white/[0.06] rounded-xl border border-white/[0.07] bg-white/[0.02]">
          {ROWS.map((row) => (
            <li key={row.email} className="flex items-center gap-3 px-3 py-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-[10px] font-semibold text-white/70">
                {row.name.split(' ').map((w) => w[0]).join('')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium">{row.name}</div>
                <div className="truncate text-[10.5px] text-white/40">{row.email}</div>
              </div>
              <Status t={t} row={row} />
            </li>
          ))}
        </ul>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {stats.map((s) => (
            <div key={s.label} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-white/40">{s.label}</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">{s.value.toFixed(1)}%</div>
            </div>
          ))}
        </div>
      </div>
    </DemoFrame>
  )
}
