import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Gradient-filled text. `tone="dark"` is for ink backgrounds, `"light"` for the light body. */
export function GradientText({ children, tone = 'light', className }: { children: ReactNode; tone?: 'light' | 'dark'; className?: string }) {
  return (
    <span
      className={cn(
        'bg-clip-text text-transparent',
        tone === 'dark'
          ? 'bg-gradient-to-r from-indigo-200 via-violet-200 to-fuchsia-200'
          : 'bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600 dark:from-indigo-300 dark:via-violet-300 dark:to-fuchsia-300',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** An italic serif accent word inside a sans heading, with the brand gradient. */
export function Accent({ children, tone = 'light', wrap }: { children: ReactNode; tone?: 'light' | 'dark'; wrap?: boolean }) {
  return (
    <GradientText tone={tone} className={cn('pr-[0.05em] font-serif font-normal italic tracking-normal', !wrap && 'whitespace-nowrap')}>
      {children}
    </GradientText>
  )
}
