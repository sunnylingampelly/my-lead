import { useId, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FaqItem {
  q: string
  a: string
}

/** An accordion of questions; each is a real button with aria-expanded, so it works from the keyboard. */
export function FAQ({ items, className }: { items: FaqItem[]; className?: string }) {
  const [open, setOpen] = useState<number | null>(0)
  const base = useId()
  return (
    <div className={cn('divide-y rounded-3xl border bg-card shadow-card', className)}>
      {items.map((it, i) => {
        const isOpen = open === i
        const panelId = `${base}-p${i}`
        const btnId = `${base}-b${i}`
        return (
          <div key={it.q}>
            <h3>
              <button
                id={btnId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : i)}
                className="flex w-full items-center justify-between gap-6 rounded-3xl px-6 py-5 text-left text-[15px] font-medium transition hover:text-primary sm:px-7 sm:text-base"
              >
                {it.q}
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-full border text-muted-foreground transition-transform duration-300',
                    isOpen && 'rotate-45 border-primary/40 text-primary',
                  )}
                  aria-hidden
                >
                  <Plus className="size-3.5" />
                </span>
              </button>
            </h3>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  id={panelId}
                  role="region"
                  aria-labelledby={btnId}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <p className="px-6 pb-6 pr-14 leading-relaxed text-muted-foreground sm:px-7">{it.a}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}
    </div>
  )
}
