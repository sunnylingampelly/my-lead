import { useRef, type ReactNode } from 'react'
import { motion, useInView, useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils'

/**
 * An endless, gently scrolling row. Pauses when off-screen; with reduced motion it becomes a static,
 * wrapping row instead.
 */
export function Marquee({ children, className, seconds = 40, reverse }: { children: ReactNode; className?: string; seconds?: number; reverse?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { margin: '100px' })
  const reduce = useReducedMotion()
  if (reduce) return <div className={cn('flex flex-wrap justify-center gap-3', className)}>{children}</div>
  return (
    <div
      ref={ref}
      className={cn('relative flex overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_10%,#000_90%,transparent)]', className)}
    >
      <motion.div
        className="flex w-max shrink-0"
        animate={inView ? { x: reverse ? ['-50%', '0%'] : ['0%', '-50%'] } : undefined}
        transition={{ duration: seconds, ease: 'linear', repeat: Infinity }}
      >
        <div className="flex shrink-0 gap-3 pr-3">{children}</div>
        <div className="flex shrink-0 gap-3 pr-3" aria-hidden>
          {children}
        </div>
      </motion.div>
    </div>
  )
}
