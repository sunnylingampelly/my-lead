import { motion } from 'framer-motion'
import { ClipboardList, Clock, GitBranch, Mail, PhoneCall, type LucideIcon } from 'lucide-react'
import { DemoFrame } from './DemoFrame'
import { useDemoClock } from './useDemoClock'

type Node = { id: string; x: number; y: number; w: number; label: string; sub: string; icon: LucideIcon; tone?: 'trigger' | 'branch' }

const NODES: Node[] = [
  { id: 'a', x: 95, y: 10, w: 170, label: 'Form submitted', sub: 'Request a demo', icon: ClipboardList, tone: 'trigger' },
  { id: 'b', x: 95, y: 74, w: 170, label: 'Wait 5 minutes', sub: 'Then continue', icon: Clock },
  { id: 'c', x: 95, y: 138, w: 170, label: 'Send email', sub: 'Welcome + menu', icon: Mail },
  { id: 'd', x: 95, y: 202, w: 170, label: 'Opened in 1 day?', sub: 'Branch', icon: GitBranch, tone: 'branch' },
  { id: 'e', x: 8, y: 280, w: 160, label: 'AI call', sub: 'Yes · Maya calls', icon: PhoneCall },
  { id: 'f', x: 192, y: 280, w: 160, label: 'Send email', sub: 'No · reminder', icon: Mail },
]
const H = 44

const EDGES = [
  { id: 'ab', d: 'M180 54 L180 74' },
  { id: 'bc', d: 'M180 118 L180 138' },
  { id: 'cd', d: 'M180 182 L180 202' },
  { id: 'de', d: 'M180 246 C180 266 88 258 88 280' },
  { id: 'df', d: 'M180 246 C180 266 272 258 272 280' },
]

/** The order nodes light up in; the loop alternates the branch taken. */
const PATH = ['a', 'ab', 'b', 'bc', 'c', 'cd', 'd']
const STEP_MS = 650

/** A workflow running: nodes light up in turn and the edges flow toward the branch taken. */
export function AutomationDemo({ className }: { className?: string }) {
  const { ref, t } = useDemoClock(2 * (PATH.length + 3) * STEP_MS, { staticAt: (PATH.length + 2) * STEP_MS })
  const loopHalf = (PATH.length + 3) * STEP_MS
  const branch = t < loopHalf ? 'e' : 'f'
  const local = t % loopHalf
  const path = [...PATH, `d${branch}`, branch]
  const step = Math.min(path.length, Math.floor(local / STEP_MS) + 1)
  const lit = new Set(path.slice(0, step))
  return (
    <DemoFrame ref={ref} title="Automation · New lead journey" className={className} testId="demo-automation">
      <svg viewBox="0 0 360 346" className="mx-auto block h-auto w-full max-w-[460px]" role="presentation">
        <defs>
          <linearGradient id="mk-edge" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#818cf8" />
            <stop offset="1" stopColor="#c084fc" />
          </linearGradient>
        </defs>
        {EDGES.map((e) => (
          <g key={e.id}>
            <path d={e.d} fill="none" stroke="rgb(255 255 255 / 0.14)" strokeWidth="1.5" className="mk-flow" />
            {lit.has(e.id) && <motion.path d={e.d} fill="none" stroke="url(#mk-edge)" strokeWidth="2.2" strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.5, ease: 'easeOut' }} />}
          </g>
        ))}
        {NODES.map((n) => {
          const on = lit.has(n.id)
          const Icon = n.icon
          return (
            <motion.g key={n.id} animate={{ opacity: on ? 1 : 0.55 }} transition={{ duration: 0.3 }}>
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={H}
                rx={12}
                fill={on ? (n.tone === 'trigger' ? '#2a2550' : '#1e1e33') : '#16161f'}
                stroke={on ? (n.tone === 'branch' ? '#c084fc' : '#818cf8') : 'rgb(255 255 255 / 0.1)'}
                strokeWidth={on ? 1.4 : 1}
              />
              <rect x={n.x + 10} y={n.y + 10} width={24} height={24} rx={7} fill={on ? '#4f46e5' : 'rgb(255 255 255 / 0.08)'} />
              <Icon x={n.x + 16} y={n.y + 16} width={12} height={12} color="#fff" />
              <text x={n.x + 44} y={n.y + 20} fill="#fff" fontSize="11.5" fontWeight="600">
                {n.label}
              </text>
              <text x={n.x + 44} y={n.y + 34} fill="rgb(255 255 255 / 0.5)" fontSize="9.5">
                {n.sub}
              </text>
            </motion.g>
          )
        })}
        {step >= path.length && (
          <motion.text initial={{ opacity: 0 }} animate={{ opacity: 1 }} x={180} y={342} textAnchor="middle" fill="rgb(167 243 208)" fontSize="10">
            ✓ Priya completed the journey
          </motion.text>
        )}
      </svg>
    </DemoFrame>
  )
}
