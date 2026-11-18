import * as React from 'react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { cn } from '@/lib/utils'

export const DropdownMenu = Menu.Root
export const DropdownMenuTrigger = Menu.Trigger
export const DropdownMenuGroup = Menu.Group

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof Menu.Content>,
  React.ComponentPropsWithoutRef<typeof Menu.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <Menu.Portal>
    <Menu.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-[12rem] overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-pop',
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
        className,
      )}
      {...props}
    />
  </Menu.Portal>
))
DropdownMenuContent.displayName = 'DropdownMenuContent'

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof Menu.Item>,
  React.ComponentPropsWithoutRef<typeof Menu.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <Menu.Item
    ref={ref}
    className={cn(
      'relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted-foreground',
      destructive && 'text-destructive focus:bg-danger-soft [&_svg]:text-destructive',
      className,
    )}
    {...props}
  />
))
DropdownMenuItem.displayName = 'DropdownMenuItem'

export function DropdownMenuLabel({ className, ...props }: React.ComponentPropsWithoutRef<typeof Menu.Label>) {
  return (
    <Menu.Label
      className={cn('px-2 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground', className)}
      {...props}
    />
  )
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentPropsWithoutRef<typeof Menu.Separator>) {
  return <Menu.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
}

export const DropdownMenuRadioGroup = Menu.RadioGroup
export const DropdownMenuSub = Menu.Sub

export function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof Menu.SubTrigger>) {
  return (
    <Menu.SubTrigger
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus:bg-muted data-[state=open]:bg-muted [&_svg]:size-4 [&_svg]:text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
      <span className="ml-auto text-muted-foreground">›</span>
    </Menu.SubTrigger>
  )
}

export function DropdownMenuSubContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof Menu.SubContent>) {
  return (
    <Menu.Portal>
      <Menu.SubContent
        sideOffset={6}
        className={cn('z-50 min-w-[10rem] rounded-lg border bg-popover p-1 text-popover-foreground shadow-pop', className)}
        {...props}
      />
    </Menu.Portal>
  )
}

const itemIndicatorBase =
  'relative flex cursor-pointer select-none items-center gap-2 rounded-md py-1.5 pl-7 pr-2 text-sm outline-none focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50'

export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem className={cn(itemIndicatorBase, className)} {...props}>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <Menu.ItemIndicator>✓</Menu.ItemIndicator>
      </span>
      {children}
    </Menu.CheckboxItem>
  )
}

export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(itemIndicatorBase, className, '[&_svg]:size-4 [&_svg]:text-muted-foreground')} {...props}>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <Menu.ItemIndicator>
          <span className="block size-1.5 rounded-full bg-primary" />
        </Menu.ItemIndicator>
      </span>
      {children}
    </Menu.RadioItem>
  )
}
