import * as React from 'react'
import * as D from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Side panel for quick views that keep the underlying page in context. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-slate-950/30 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <D.Content
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l bg-card shadow-pop',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right data-[state=open]:duration-300 data-[state=closed]:duration-200',
            className,
          )}
        >
          <div className="flex items-start gap-3 border-b px-5 py-4">
            <div className="min-w-0 flex-1">
              <D.Title className="truncate text-base font-semibold">{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-sm text-muted-foreground">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">Details</D.Description>
              )}
            </div>
            <D.Close className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
