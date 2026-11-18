import { useQuery } from '@tanstack/react-query'
import { FlaskConical, Hash, Mic, PhoneCall, Volume2 } from 'lucide-react'
import { http } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows } from '@/components/page'
import { Logo } from '@/components/logo'
import { Badge } from '@/components/ui/misc'
import { formatPhone } from '@/lib/regions'
import { formatDateTime } from '@/lib/utils'

interface CallLogItem {
  id: string
  to: string
  from: string
  outcome: string
  script: { kind: string; text: string | null; url: string | null }[]
  keypress_prompt: string | null
  created_at: string
}

const OUTCOME: Record<string, string> = {
  answered: 'Answered',
  no_answer: 'No answer',
  busy: 'Busy',
  voicemail: 'Voicemail',
  opt_out: 'Answered, pressed 9',
}

/** Development-only viewer for calls captured by the voice simulation provider. */
export function DevCallLogPage() {
  const q = useQuery({
    queryKey: ['dev', 'call-log'],
    queryFn: () => http.get<{ items: CallLogItem[] }>('/dev/call-log', { params: { limit: 200 } }).then((r) => r.data),
    refetchInterval: 3000,
  })
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 items-center gap-4 border-b bg-card px-5">
        <Logo />
        <span className="flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning-strong ring-1 ring-warning-border">
          <FlaskConical className="size-3.5" /> Development call log · simulated calls only
        </span>
        <span className="ml-auto flex gap-4 text-sm">
          <a className="text-primary hover:underline" href="/dev/sms">
            SMS outbox
          </a>
          <a className="text-primary hover:underline" href="/dev/mailbox">
            Email mailbox
          </a>
        </span>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6">
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState icon={PhoneCall} title="No simulated calls yet" description="Start a voice campaign or place a test call. Calls appear here instead of ringing a phone." />
        ) : (
          <ul className="space-y-3" data-testid="call-log">
            {q.data.items.map((c) => (
              <li key={c.id} className="rounded-xl border bg-card p-4 shadow-card">
                <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    To <span className="font-mono font-semibold text-foreground">{formatPhone(c.to)}</span>
                  </span>
                  <span>
                    from <span className="font-mono">{c.from}</span>
                  </span>
                  <Badge variant="secondary">{OUTCOME[c.outcome] ?? c.outcome}</Badge>
                  <span className="ml-auto">{formatDateTime(c.created_at)}</span>
                </div>
                <ol className="space-y-1.5 text-sm">
                  {c.script.map((s, i) => (
                    <li key={i} className="flex gap-2">
                      {s.kind === 'play' ? <Volume2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <Mic className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                      {s.kind === 'play' ? <audio controls preload="none" src={s.url ?? undefined} className="h-8" /> : <span>{s.text}</span>}
                    </li>
                  ))}
                  {c.keypress_prompt && (
                    <li className="flex gap-2 text-muted-foreground">
                      <Hash className="mt-0.5 size-4 shrink-0" /> {c.keypress_prompt}
                    </li>
                  )}
                </ol>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
