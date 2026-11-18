import { cn } from '@/lib/utils'

export function Logo({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="#4f46e5" />
        <path d="M8 19c3-6 6-6 8 0s5 6 8 0" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      </svg>
      <span className={cn('text-[15px] font-semibold tracking-tight', inverted ? 'text-white' : 'text-foreground')}>
        Signalcraft
      </span>
    </div>
  )
}
