import { forwardRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The window chrome around every product demo: a dark glass panel with traffic lights, a title and a
 * "Sample data" note (the names and numbers in demos are illustrative).
 */
export const DemoFrame = forwardRef<HTMLDivElement, { title: string; children: ReactNode; className?: string; bodyClassName?: string; testId?: string }>(
  function DemoFrame({ title, children, className, bodyClassName, testId }, ref) {
    return (
      <div
        ref={ref}
        data-testid={testId}
        role="img"
        aria-label={`Animated example: ${title}`}
        className={cn(
          'relative overflow-hidden rounded-2xl border border-white/10 bg-[#12121c]/90 text-white shadow-[0_40px_120px_-30px_rgb(79_70_229/0.55),0_0_0_1px_rgb(255_255_255/0.04)_inset] backdrop-blur-xl',
          className,
        )}
      >
        <div className="flex h-10 items-center gap-3 border-b border-white/[0.07] bg-white/[0.02] px-4">
          <div className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </div>
          <div className="min-w-0 flex-1 truncate text-center text-[11px] font-medium text-white/45">{title}</div>
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white/40">Sample</span>
        </div>
        <div className={cn('relative p-4 sm:p-5', bodyClassName)} aria-hidden>
          {children}
        </div>
      </div>
    )
  },
)
