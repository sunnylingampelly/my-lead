import { motion } from 'framer-motion'
import { DemoFrame } from './DemoFrame'
import { progress, useDemoClock } from './useDemoClock'

const LEADS = [22, 28, 25, 34, 31, 42, 39, 47, 52, 49, 61, 68]
const WON = [3, 4, 4, 6, 5, 7, 8, 8, 10, 9, 12, 14]
const W = 320
const H = 120

/** A smooth SVG path through the points (Catmull-Rom converted to cubic Béziers). */
function smooth(values: number[], max: number) {
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - (v / max) * (H - 10) - 4] as const)
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
  }
  return d
}

const LEAD_PATH = smooth(LEADS, 70)
const WON_PATH = smooth(WON, 70)

const CHANNELS = [
  { label: 'Forms', value: 0.82, color: 'from-indigo-400 to-indigo-300' },
  { label: 'Chat', value: 0.64, color: 'from-violet-400 to-violet-300' },
  { label: 'Email', value: 0.51, color: 'from-sky-400 to-sky-300' },
  { label: 'AI calls', value: 0.38, color: 'from-emerald-400 to-emerald-300' },
]

/** A cross-channel report: KPIs tick up, the chart draws in and channel bars grow. */
export function AnalyticsDemo({ className }: { className?: string }) {
  const { ref, t } = useDemoClock(10000, { staticAt: 6000 })
  const draw = progress(t, 300, 2600)
  const kp = progress(t, 300, 2000)
  const bars = progress(t, 1800, 3200)
  const fade = t > 9300 ? 0 : 1
  const kpis = [
    { label: 'Leads', value: Math.round(498 * kp).toLocaleString('en-IN') },
    { label: 'Won deals', value: Math.round(90 * kp).toString() },
    { label: 'Win rate', value: `${(18.1 * kp).toFixed(1)}%` },
  ]
  return (
    <DemoFrame ref={ref} title="Analytics · Last 12 weeks" className={className} testId="demo-analytics">
      <motion.div className="min-h-[320px]" animate={{ opacity: fade }} transition={{ duration: 0.5 }}>
        <div className="grid grid-cols-3 gap-2">
          {kpis.map((k) => (
            <div key={k.label} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
              <div className="truncate text-[10px] uppercase tracking-wider text-white/40">{k.label}</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">{k.value}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
          <div className="mb-2 flex items-center gap-3 text-[10.5px] text-white/50">
            <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded bg-indigo-300" /> Leads</span>
            <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded bg-emerald-300" /> Won</span>
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full overflow-visible" role="presentation">
            <defs>
              <linearGradient id="mk-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#818cf8" stopOpacity="0.35" />
                <stop offset="1" stopColor="#818cf8" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((g) => (
              <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} stroke="rgb(255 255 255 / 0.06)" strokeDasharray="3 4" />
            ))}
            <motion.path d={`${LEAD_PATH} L${W},${H} L0,${H} Z`} fill="url(#mk-area)" animate={{ opacity: draw }} transition={{ duration: 0.2 }} />
            <motion.path d={LEAD_PATH} fill="none" stroke="#a5b4fc" strokeWidth="2.2" strokeLinecap="round" animate={{ pathLength: draw }} transition={{ duration: 0.12, ease: 'linear' }} />
            <motion.path d={WON_PATH} fill="none" stroke="#6ee7b7" strokeWidth="2" strokeLinecap="round" animate={{ pathLength: draw }} transition={{ duration: 0.12, ease: 'linear' }} />
          </svg>
        </div>
        <div className="mt-3 space-y-1.5">
          {CHANNELS.map((c) => (
            <div key={c.label} className="flex items-center gap-2 text-[11px]">
              <span className="w-14 shrink-0 text-white/55">{c.label}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div className={`h-full origin-left rounded-full bg-gradient-to-r ${c.color} transition-transform duration-150`} style={{ transform: `scaleX(${c.value * bars})` }} />
              </div>
              <span className="w-8 shrink-0 text-right tabular-nums text-white/45">{Math.round(c.value * bars * 100)}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </DemoFrame>
  )
}
