import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FlaskConical, Inbox } from 'lucide-react'
import { useMailbox } from '@/api/queries'
import { EmptyState, ErrorState, LoadingRows } from '@/components/page'
import { Input } from '@/components/ui/form-controls'
import { Logo } from '@/components/logo'
import { cn, formatDateTime } from '@/lib/utils'

/** Development-only viewer for emails captured by the simulation provider. */
export function DevMailboxPage() {
  const [params, setParams] = useSearchParams()
  const to = params.get('to') ?? ''
  const q = useMailbox(to || undefined)
  const [selected, setSelected] = useState<string | null>(null)
  const items = q.data?.items ?? []
  const current = items.find((m) => m.id === selected) ?? items[0]

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 items-center gap-4 border-b bg-card px-5">
        <Logo />
        <span className="flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning-strong ring-1 ring-warning-border">
          <FlaskConical className="size-3.5" /> Development mailbox · simulated emails only
        </span>
        <Input
          className="ml-auto w-72"
          placeholder="Filter by recipient email"
          defaultValue={to}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setParams((e.target as HTMLInputElement).value ? { to: (e.target as HTMLInputElement).value } : {})
          }}
          aria-label="Filter by recipient"
        />
      </header>
      {q.isLoading ? (
        <LoadingRows />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={Inbox} title="No emails yet" description="Emails sent in simulation mode appear here." />
      ) : (
        <div className="grid min-h-0 flex-1 md:grid-cols-[340px_1fr]">
          <ul className="overflow-y-auto border-r bg-card">
            {items.map((m) => (
              <li key={m.id}>
                <button
                  onClick={() => setSelected(m.id)}
                  className={cn('w-full border-b px-4 py-3 text-left hover:bg-muted/50', current?.id === m.id && 'bg-accent')}
                >
                  <div className="truncate text-sm font-medium">{m.subject}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {m.to} · {formatDateTime(m.created_at)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {current && (
            <section className="flex min-h-0 flex-col">
              <div className="border-b bg-card px-5 py-3 text-sm">
                <div className="font-semibold">{current.subject}</div>
                <div className="text-xs text-muted-foreground">
                  From {current.from} to {current.to}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {Array.from(
                    new Set([...(current.html.match(/href="(https?:[^"]+)"/g) ?? []).map((h) => h.slice(6, -1).replace(/&amp;/g, '&')), ...(current.text.match(/https?:\/\/\S+/g) ?? [])]),
                  )
                    .filter((u) => u.startsWith(window.location.origin) || !current.html.includes('/api/v1/t/c/'))
                    .map((url) => {
                      const path = new URL(url).pathname
                      const label = path.includes('/t/c/') ? 'Tracked link' : path === '/unsubscribe' ? 'Unsubscribe' : path
                      return (
                        <a
                          key={url}
                          href={url}
                          target={path.includes('/t/c/') ? '_blank' : undefined}
                          rel="noreferrer"
                          data-testid="mail-link"
                          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                        >
                          {label}: {path.length > 32 ? path.slice(0, 32) + '…' : path}
                        </a>
                      )
                    })}
                </div>
              </div>
              <iframe
                title="Email preview"
                sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
                srcDoc={current.html}
                className="min-h-[600px] w-full flex-1 bg-white"
              />
            </section>
          )}
        </div>
      )}
    </div>
  )
}
