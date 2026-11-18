import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Popover from '@radix-ui/react-dropdown-menu'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Bell, BellOff, CheckCheck, CheckCircle2, Info, XCircle } from 'lucide-react'
import { notificationsApi, nqk, useNotifications, useUnreadCount, type AppNotification } from '@/api/notifications'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { cn, timeAgo } from '@/lib/utils'

const ICON = {
  info: { icon: Info, cls: 'text-primary bg-accent' },
  success: { icon: CheckCircle2, cls: 'text-success-strong bg-success-soft' },
  warning: { icon: AlertTriangle, cls: 'text-warning-strong bg-warning-soft' },
  error: { icon: XCircle, cls: 'text-danger-strong bg-danger-soft' },
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false)
  const unread = useUnreadCount()
  const list = useNotifications(open)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const count = unread.data?.unread ?? 0

  const refresh = () => qc.invalidateQueries({ queryKey: nqk.all })
  const openItem = async (n: AppNotification) => {
    setOpen(false)
    if (!n.read_at) await notificationsApi.read(n.id).catch(() => undefined)
    refresh()
    if (n.link) navigate(n.link)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content="Notifications">
        <Popover.Trigger asChild>
          <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications${count ? `, ${count} unread` : ''}`} data-testid="notifications">
            <Bell />
            {count > 0 && (
              <span className="absolute right-1 top-1 flex min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white ring-2 ring-card">
                {count > 9 ? '9+' : count}
              </span>
            )}
          </Button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[min(92vw,380px)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-pop data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="text-sm font-semibold">Notifications</div>
            {count > 0 && (
              <button
                className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                onClick={async () => {
                  await notificationsApi.readAll()
                  refresh()
                }}
              >
                <CheckCheck className="size-3.5" /> Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {list.isLoading ? (
              <div className="space-y-3 p-4">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
                ))}
              </div>
            ) : !list.data?.items.length ? (
              <div className="flex flex-col items-center px-6 py-10 text-center">
                <BellOff className="size-6 text-muted-foreground" />
                <p className="mt-2 text-sm font-medium">You're all caught up</p>
                <p className="text-xs text-muted-foreground">Import results, new teammates and access changes appear here.</p>
              </div>
            ) : (
              <ul className="divide-y">
                {list.data.items.map((n) => {
                  const meta = ICON[n.level] ?? ICON.info
                  return (
                    <Popover.Item
                      key={n.id}
                      onSelect={(e) => {
                        e.preventDefault()
                        openItem(n)
                      }}
                      className={cn('flex cursor-pointer gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/60 focus:bg-muted/60', !n.read_at && 'bg-accent/40')}
                    >
                      <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full', meta.cls)}>
                        <meta.icon className="size-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className={cn('text-sm leading-snug', !n.read_at && 'font-semibold')}>{n.title}</p>
                        {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>}
                        <p className="mt-1 text-[11px] text-muted-foreground">{timeAgo(n.created_at)}</p>
                      </div>
                      {!n.read_at && <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                    </Popover.Item>
                  )
                })}
              </ul>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
