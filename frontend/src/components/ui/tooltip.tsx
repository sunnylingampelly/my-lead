import * as React from 'react'
import * as T from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

/** Hover/focus hint. Wrap any focusable element. */
export function Tooltip({
  content,
  children,
  side = 'top',
  shortcut,
  disabled,
}: {
  content: React.ReactNode
  children: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  shortcut?: string
  disabled?: boolean
}) {
  if (disabled) return children
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-[60] flex items-center gap-2 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-pop',
            'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95',
          )}
        >
          {content}
          {shortcut && <kbd className="rounded bg-background/20 px-1 font-mono text-[10px]">{shortcut}</kbd>}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
