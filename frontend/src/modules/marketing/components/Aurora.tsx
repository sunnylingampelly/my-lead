import { cn } from '@/lib/utils'

/**
 * The dark hero backdrop: drifting indigo/violet light, fine grid lines that fade out, and film grain.
 * Purely decorative; place it as the first child of a `relative overflow-hidden mk-ink` element.
 */
export function Aurora({ className, intensity = 1, grid = true }: { className?: string; intensity?: number; grid?: boolean }) {
  return (
    <div className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)} aria-hidden>
      <div
        className="mk-blob left-1/2 top-[-30%] h-[70vh] w-[90vw] max-w-[1100px] -translate-x-1/2"
        style={{ background: `radial-gradient(closest-side, rgb(79 70 229 / ${0.55 * intensity}), transparent)` }}
      />
      <div
        className="mk-blob mk-blob-2 left-[-10%] top-[10%] h-[55vh] w-[55vw] max-w-[720px]"
        style={{ background: `radial-gradient(closest-side, rgb(139 92 246 / ${0.38 * intensity}), transparent)` }}
      />
      <div
        className="mk-blob mk-blob-3 right-[-12%] top-[25%] h-[50vh] w-[50vw] max-w-[680px]"
        style={{ background: `radial-gradient(closest-side, rgb(14 165 233 / ${0.18 * intensity}), transparent)` }}
      />
      {grid && <div className="mk-grid absolute inset-0" />}
      <div className="mk-noise absolute inset-0" />
      {/* A soft fade into whatever follows the dark section. */}
      <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-[#0b0b14]" />
    </div>
  )
}
