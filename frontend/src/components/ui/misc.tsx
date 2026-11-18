import * as React from 'react'
import * as AvatarPrimitive from '@radix-ui/react-avatar'
import * as SeparatorPrimitive from '@radix-ui/react-separator'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn, initials } from '@/lib/utils'

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', {
  variants: {
    variant: {
      default: 'bg-accent text-accent-foreground ring-primary/15',
      secondary: 'bg-muted text-muted-foreground ring-border',
      success: 'bg-success-soft text-success-strong ring-success-border',
      warning: 'bg-warning-soft text-warning-strong ring-warning-border',
      destructive: 'bg-danger-soft text-danger-strong ring-danger-border',
      outline: 'bg-transparent text-foreground ring-border',
    },
  },
  defaultVariants: { variant: 'default' },
})

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <AvatarPrimitive.Root
      className={cn('relative flex size-8 shrink-0 overflow-hidden rounded-full bg-primary/10', className)}
    >
      <AvatarPrimitive.Fallback className="flex size-full items-center justify-center text-xs font-semibold text-primary">
        {initials(name) || '?'}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  )
}

export function Separator({ className, ...props }: React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>) {
  return <SeparatorPrimitive.Root className={cn('h-px w-full shrink-0 bg-border', className)} {...props} />
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  )
}
