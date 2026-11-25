import type { MouseEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion, useMotionTemplate, useMotionValue } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/** A product card with a cursor-following spotlight glow; the whole card links to the product page. */
export function BentoCard({
  to,
  icon: Icon,
  title,
  text,
  visual,
  className,
  soon,
}: {
  to: string
  icon: React.ComponentType<{ className?: string }>
  title: string
  text: string
  visual?: ReactNode
  className?: string
  /** Not available yet: shows a "Soon" tag next to the title. */
  soon?: boolean
}) {
  const x = useMotionValue(-400)
  const y = useMotionValue(-400)
  const glow = useMotionTemplate`radial-gradient(420px circle at ${x}px ${y}px, rgb(99 102 241 / 0.16), transparent 45%)`
  const edge = useMotionTemplate`radial-gradient(260px circle at ${x}px ${y}px, rgb(129 140 248 / 0.9), transparent 60%)`
  function onMove(e: MouseEvent<HTMLAnchorElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    x.set(e.clientX - r.left)
    y.set(e.clientY - r.top)
  }
  return (
    <Link
      to={to}
      onMouseMove={onMove}
      className={cn(
        'group relative flex min-h-[260px] flex-col overflow-hidden rounded-3xl border bg-card p-6 text-card-foreground shadow-card transition-[transform,box-shadow] duration-300 hover:-translate-y-1 hover:shadow-[0_24px_60px_-24px_rgb(79_70_229/0.35)] sm:p-7',
        className,
      )}
    >
      {/* Spotlight fill and a brighter border that follows the cursor. */}
      <motion.div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100" style={{ background: glow }} aria-hidden />
      <motion.div
        className="pointer-events-none absolute inset-0 rounded-[inherit] p-px opacity-0 transition-opacity duration-300 [mask-composite:exclude] [mask:linear-gradient(#000_0_0)_content-box,linear-gradient(#000_0_0)] group-hover:opacity-100"
        style={{ background: edge }}
        aria-hidden
      />
      <div className="relative flex items-start justify-between gap-4">
        <div className="flex size-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/25">
          <Icon className="size-5" aria-hidden />
        </div>
        <ArrowUpRight className="size-5 text-muted-foreground transition duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
      </div>
      <h3 className="relative mt-5 flex items-center gap-2 text-xl font-semibold tracking-tight">
        {title}
        {soon && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-400/15 dark:text-amber-200" data-testid="soon-tag">
            Soon
          </span>
        )}
      </h3>
      <p className="relative mt-2 max-w-md text-[15px] leading-relaxed text-muted-foreground">{text}</p>
      {visual && <div className="relative mt-6 flex flex-1 items-end">{visual}</div>}
    </Link>
  )
}
