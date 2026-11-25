import { useEffect, useRef, useState } from 'react'
import { useInView, useReducedMotion } from 'framer-motion'

/**
 * A looping timeline for the product demos. Returns a ref for the demo's root and the elapsed time (ms)
 * within the loop. The clock runs only while the demo is on screen (and the tab is visible), so demos
 * cost nothing off-screen. With reduced motion it returns `staticAt` (default: the end of the loop),
 * so each demo shows a finished, static state.
 */
export function useDemoClock(loopMs: number, opts: { staticAt?: number; tick?: number; paused?: boolean } = {}) {
  const { staticAt = loopMs - 1, tick = 60, paused = false } = opts
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { amount: 0.25 })
  const reduce = useReducedMotion()
  const [t, setT] = useState(0)
  const running = inView && !reduce && !paused

  useEffect(() => {
    if (!running) return
    let last = performance.now()
    const id = window.setInterval(() => {
      if (document.hidden) {
        last = performance.now()
        return
      }
      const now = performance.now()
      const dt = now - last
      last = now
      setT((prev) => (prev + dt) % loopMs)
    }, tick)
    return () => window.clearInterval(id)
  }, [running, loopMs, tick])

  return { ref, t: reduce ? staticAt : t, reduce: !!reduce }
}

/** Characters of `text` typed by time `t`, starting at `start`, `speed` ms per character. */
export function typed(text: string, t: number, start: number, speed = 45) {
  if (t < start) return ''
  return text.slice(0, Math.floor((t - start) / speed))
}

/** Words of `text` streamed by time `t` (like an AI reply), `speed` ms per word. */
export function streamed(text: string, t: number, start: number, speed = 90) {
  if (t < start) return ''
  const words = text.split(' ')
  return words.slice(0, Math.floor((t - start) / speed) + 1).join(' ')
}

/** 0..1 progress of `t` between `start` and `end`. */
export function progress(t: number, start: number, end: number) {
  return Math.min(1, Math.max(0, (t - start) / (end - start)))
}
