import { useEffect, useRef } from 'react'
import { animate, useReducedMotion } from 'framer-motion'

/**
 * A number that ticks smoothly to its new value. It writes straight to the DOM node, so the tick-up never
 * re-renders React. With reduced motion it jumps.
 */
export function AnimatedNumber({ value, format, className, testId }: { value: number; format: (n: number) => string; className?: string; testId?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const from = useRef(value)
  const reduce = useReducedMotion()
  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (reduce) {
      node.textContent = format(value)
      from.current = value
      return
    }
    const controls = animate(from.current, value, {
      duration: 0.6,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (n) => {
        node.textContent = format(n)
        from.current = n
      },
      onComplete: () => {
        node.textContent = format(value)
      },
    })
    return () => controls.stop()
  }, [value, format, reduce])
  return (
    <span ref={ref} className={className} data-testid={testId} data-value={value}>
      {format(value)}
    </span>
  )
}
