import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'

type Variant = 'primary' | 'white' | 'ghost-dark' | 'outline'

const styles: Record<Variant, string> = {
  primary:
    'bg-gradient-to-b from-indigo-500 to-indigo-600 text-white shadow-[0_1px_0_0_rgb(255_255_255/0.25)_inset,0_8px_24px_-8px_rgb(79_70_229/0.7)] hover:from-indigo-400 hover:to-indigo-600',
  white: 'bg-white text-[#0b0b14] shadow-[0_8px_30px_-10px_rgb(255_255_255/0.45)] hover:bg-white/90',
  'ghost-dark': 'border border-white/15 bg-white/[0.04] text-white backdrop-blur hover:bg-white/10',
  outline: 'border bg-card text-foreground hover:bg-muted',
}

/** A call-to-action link; internal paths use the router, anything else a plain anchor. */
export function CtaLink({
  to,
  children,
  variant = 'primary',
  size = 'lg',
  arrow,
  className,
}: {
  to: string
  children: ReactNode
  variant?: Variant
  size?: 'md' | 'lg'
  arrow?: boolean
  className?: string
}) {
  const cls = cn(
    'group inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium transition duration-200 focus-visible:ring-offset-[#0b0b14]',
    size === 'lg' ? 'h-12 px-6 text-[15px]' : 'h-9 px-4 text-sm',
    styles[variant],
    className,
  )
  const inner = (
    <>
      {children}
      {arrow && <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />}
    </>
  )
  return to.startsWith('/') ? (
    <Link to={to} className={cls}>
      {inner}
    </Link>
  ) : (
    <a href={to} className={cls}>
      {inner}
    </a>
  )
}
