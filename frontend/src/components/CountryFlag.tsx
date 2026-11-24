import { cn } from '@/lib/utils'

/**
 * Small inline flag. Emoji flags render as plain letters on Windows, so the primary markets get
 * an SVG and every other country a neutral code label.
 */
export function CountryFlag({ code, className }: { code?: string | null; className?: string }) {
  const c = (code ?? '').toUpperCase()
  if (c === 'IN')
    return (
      <svg viewBox="0 0 30 20" className={cn('h-3 w-[18px] shrink-0 rounded-[2px] ring-1 ring-border', className)} role="img" aria-label="India">
        <rect width="30" height="20" fill="#fff" />
        <rect width="30" height="6.67" fill="#FF9933" />
        <rect y="13.33" width="30" height="6.67" fill="#138808" />
        <circle cx="15" cy="10" r="2.6" fill="none" stroke="#000080" strokeWidth="0.8" />
      </svg>
    )
  if (c === 'US')
    return (
      <svg viewBox="0 0 38 20" className={cn('h-3 w-[18px] shrink-0 rounded-[2px] ring-1 ring-border', className)} role="img" aria-label="United States">
        <rect width="38" height="20" fill="#fff" />
        {[0, 2, 4, 6, 8, 10, 12].map((i) => (
          <rect key={i} y={(i * 20) / 13} width="38" height={20 / 13} fill="#B22234" />
        ))}
        <rect width="15.2" height={(20 * 7) / 13} fill="#3C3B6E" />
      </svg>
    )
  if (!c) return null
  return (
    <span className={cn('inline-flex h-3.5 shrink-0 items-center rounded-[3px] bg-muted px-1 font-mono text-[9px] font-semibold leading-none text-muted-foreground ring-1 ring-border', className)} aria-label={c}>
      {c}
    </span>
  )
}
