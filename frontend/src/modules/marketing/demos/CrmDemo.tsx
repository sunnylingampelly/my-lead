import { AnimatePresence, LayoutGroup, motion } from 'framer-motion'
import { MousePointer2, PartyPopper } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DemoFrame } from './DemoFrame'
import { useDemoClock } from './useDemoClock'

type Deal = { id: string; name: string; value: number; owner: string }

const NEW: Deal[] = [
  { id: 'bloom', name: 'Bloom Salons', value: 18000, owner: 'MI' },
  { id: 'kite', name: 'Kite Labs', value: 62000, owner: 'RM' },
]
const PROPOSAL_REST: Deal[] = [{ id: 'aroma', name: 'Aroma Cafe', value: 24000, owner: 'AR' }]
const WON_REST: Deal[] = [{ id: 'north', name: 'Northwind', value: 120000, owner: 'VS' }]
const HERO: Deal = { id: 'chai', name: 'Chai & Co · 3 outlets', value: 45000, owner: 'AR' }

const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`

function Card({ d, hero, lifted }: { d: Deal; hero?: boolean; lifted?: boolean }) {
  return (
    <motion.div
      layoutId={d.id}
      transition={{ type: 'spring', stiffness: 220, damping: 26 }}
      animate={{ scale: lifted ? 1.04 : 1, rotate: lifted ? 2 : 0 }}
      className={cn(
        'relative rounded-lg border p-2 text-left',
        hero ? 'border-indigo-400/50 bg-[#22223a] shadow-[0_10px_30px_-10px_rgb(99_102_241/0.6)]' : 'border-white/[0.07] bg-white/[0.04]',
        lifted && 'z-10 shadow-2xl shadow-black/60',
      )}
    >
      <div className="truncate text-[11.5px] font-medium">{d.name}</div>
      <div className="mt-1 flex items-center justify-between gap-1">
        <span className="text-[11px] tabular-nums text-white/55">{inr(d.value)}</span>
        <span className="flex size-4 items-center justify-center rounded-full bg-white/10 text-[8px] font-semibold text-white/70">{d.owner}</span>
      </div>
      {lifted && (
        <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute -bottom-3 right-2 text-white">
          <MousePointer2 className="size-4 fill-white" />
        </motion.span>
      )}
    </motion.div>
  )
}

/** A deal card dragged from Proposal to Won, with totals updating and a "Deal won" note. */
export function CrmDemo({ className }: { className?: string }) {
  const { ref, t } = useDemoClock(8500, { staticAt: 6000 })
  const won = t > 2700
  const lifted = t > 1800 && t <= 2700
  const cols = [
    { name: 'New', deals: NEW },
    { name: 'Proposal', deals: won ? PROPOSAL_REST : [HERO, ...PROPOSAL_REST] },
    { name: 'Won', deals: won ? [HERO, ...WON_REST] : WON_REST },
  ]
  return (
    <DemoFrame ref={ref} title="CRM · Sales pipeline" className={className} testId="demo-crm">
      <div className="relative min-h-[250px]">
        <LayoutGroup>
          <div className="grid grid-cols-3 gap-2">
            {cols.map((c) => {
              const total = c.deals.reduce((s, d) => s + d.value, 0)
              return (
                <div key={c.name} className={cn('min-w-0 rounded-xl border p-1.5 transition-colors duration-500', c.name === 'Won' && won ? 'border-emerald-400/25 bg-emerald-400/[0.04]' : 'border-white/[0.06] bg-white/[0.02]')}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-1 px-1">
                    <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-white/50">{c.name}</span>
                    <span className="text-[10px] tabular-nums text-white/35">{c.deals.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {c.deals.map((d) => (
                      <Card key={d.id} d={d} hero={d.id === HERO.id} lifted={d.id === HERO.id && lifted} />
                    ))}
                  </div>
                  <div className="mt-2 truncate px-1 text-[10px] tabular-nums text-white/40">{inr(total)}</div>
                </div>
              )
            })}
          </div>
        </LayoutGroup>
        <AnimatePresence>
          {t > 3200 && t < 8000 && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="absolute inset-x-0 bottom-0 mx-auto flex w-fit max-w-full items-center gap-2 rounded-full border border-emerald-400/25 bg-[#132a24]/95 px-3 py-1.5 text-[12px] text-emerald-100 shadow-xl"
            >
              <PartyPopper className="size-3.5 shrink-0 text-emerald-300" />
              <span className="truncate">Deal won · {inr(HERO.value)} · thank-you email queued</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </DemoFrame>
  )
}
