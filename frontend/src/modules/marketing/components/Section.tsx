import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Section({ id, className, inner, children, labelledBy }: { id?: string; className?: string; inner?: string; children: ReactNode; labelledBy?: string }) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn('relative scroll-mt-20 px-4 py-20 sm:px-6 sm:py-28', className)}>
      <div className={cn('mx-auto max-w-6xl', inner)}>{children}</div>
    </section>
  )
}

export function Eyebrow({ children, tone = 'light', className }: { children: ReactNode; tone?: 'light' | 'dark'; className?: string }) {
  return (
    <p
      className={cn(
        'mb-4 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em]',
        tone === 'dark' ? 'text-indigo-200/90' : 'text-primary',
        className,
      )}
    >
      <span className={cn('h-px w-6', tone === 'dark' ? 'bg-indigo-300/60' : 'bg-primary/60')} aria-hidden />
      {children}
    </p>
  )
}

/** Section heading block: eyebrow, h2 and an optional lead paragraph. */
export function SectionHeading({
  eyebrow,
  title,
  lead,
  id,
  tone = 'light',
  align = 'center',
  className,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  lead?: ReactNode
  id?: string
  tone?: 'light' | 'dark'
  align?: 'center' | 'left'
  className?: string
}) {
  return (
    <div className={cn(align === 'center' ? 'mx-auto max-w-3xl text-center' : 'max-w-2xl', className)}>
      {eyebrow && <Eyebrow tone={tone}>{eyebrow}</Eyebrow>}
      <h2 id={id} className={cn('text-balance text-4xl font-semibold leading-[1.05] tracking-[-0.03em] sm:text-5xl', tone === 'dark' ? 'text-white' : 'text-foreground')}>
        {title}
      </h2>
      {lead && <p className={cn('mt-5 text-pretty text-lg leading-relaxed', tone === 'dark' ? 'text-white/65' : 'text-muted-foreground')}>{lead}</p>}
    </div>
  )
}
