import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ChevronRight, Inbox, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/misc'
import { errorMessage } from '@/api/client'
import { cn } from '@/lib/utils'

export interface Crumb {
  label: string
  to?: string
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
}: {
  title: string
  description?: ReactNode
  breadcrumbs?: Crumb[]
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
            {breadcrumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="size-3" />}
                {c.to ? (
                  <Link to={c.to} className="hover:text-foreground">
                    {c.label}
                  </Link>
                ) : (
                  <span className="text-foreground/80">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: string
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <div className="relative mb-5 flex size-16 items-center justify-center" aria-hidden>
        <span className="absolute inset-0 rounded-full bg-primary/5 ring-1 ring-primary/10" />
        <span className="absolute inset-2 rounded-full bg-primary/10" />
        <span className="relative flex size-10 items-center justify-center rounded-xl bg-card text-primary shadow-card ring-1 ring-border">
          <Icon className="size-5" />
        </span>
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)} role="alert">
      <div className="mb-4 flex size-11 items-center justify-center rounded-full bg-danger-soft text-destructive">
        <AlertTriangle className="size-5" />
      </div>
      <h3 className="text-sm font-semibold">Couldn't load this</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-5" onClick={onRetry}>
          <RefreshCw /> Try again
        </Button>
      )}
    </div>
  )
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  )
}

export function FullPageSpinner() {
  return (
    <div className="flex h-full items-center justify-center" aria-busy="true">
      <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  )
}
