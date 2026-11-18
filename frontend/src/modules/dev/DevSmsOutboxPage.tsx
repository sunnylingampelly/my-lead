import { useQuery } from '@tanstack/react-query'
import { FlaskConical, MessageSquare } from 'lucide-react'
import { http } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows } from '@/components/page'
import { Logo } from '@/components/logo'
import { formatPhone } from '@/lib/regions'
import { formatDateTime } from '@/lib/utils'

interface OutboxItem {
  id: string
  to: string
  from: string
  body: string
  category: string
  dlt_template_id: string | null
  created_at: string
}

/** Development-only viewer for texts captured by the SMS simulation provider. */
export function DevSmsOutboxPage() {
  const q = useQuery({
    queryKey: ['dev', 'sms-outbox'],
    queryFn: () => http.get<{ items: OutboxItem[] }>('/dev/sms-outbox', { params: { limit: 200 } }).then((r) => r.data),
    refetchInterval: 3000,
  })
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 items-center gap-4 border-b bg-card px-5">
        <Logo />
        <span className="flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning-strong ring-1 ring-warning-border">
          <FlaskConical className="size-3.5" /> Development SMS outbox · simulated texts only
        </span>
        <a className="ml-auto text-sm text-primary hover:underline" href="/dev/mailbox">
          Email mailbox
        </a>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6">
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState icon={MessageSquare} title="No simulated texts yet" description="Send an SMS campaign or a test. Texts appear here instead of reaching a phone." />
        ) : (
          <ul className="space-y-3" data-testid="sms-outbox">
            {q.data.items.map((m) => (
              <li key={m.id} className="rounded-xl border bg-card p-4 shadow-card">
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    To <span className="font-mono font-semibold text-foreground">{formatPhone(m.to)}</span>
                  </span>
                  <span>
                    from <span className="font-mono">{m.from}</span>
                  </span>
                  <span className="capitalize">{m.category}</span>
                  {m.dlt_template_id && <span>DLT {m.dlt_template_id}</span>}
                  <span className="ml-auto">{formatDateTime(m.created_at)}</span>
                </div>
                <p className="w-fit max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-muted px-3 py-2 text-sm">{m.body}</p>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
