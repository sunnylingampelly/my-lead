/** Call detail drawer: the AI conversation (chat bubbles), summary, sentiment/interest and captured outcomes. */
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { voiceApi } from '@/api/voice'
import { ErrorState } from '@/components/page'
import { Sheet } from '@/components/ui/sheet'
import { Badge, Skeleton } from '@/components/ui/misc'
import { formatPhone } from '@/lib/regions'
import { cn, formatDateTime } from '@/lib/utils'
import { CALL_STATUS, INTEREST, SENTIMENT, formatDuration, formatOutcome } from './format'

export function CallDetailSheet({ appId, campaignId, callId, onClose }: { appId: string; campaignId: string; callId: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['voice', appId, 'call', callId], queryFn: () => voiceApi(appId).call(campaignId, callId!), enabled: !!callId })
  const c = q.data
  const status = c ? (CALL_STATUS[c.status] ?? { label: c.status, variant: 'secondary' as const }) : null
  return (
    <Sheet
      open={!!callId}
      onOpenChange={(o) => !o && onClose()}
      title={c ? c.contact_name || formatPhone(c.to_phone) : 'Call'}
      description={c ? `${formatPhone(c.to_phone)}${c.from_number ? ` · called from ${formatPhone(c.from_number)}` : ''} · ${c.ended_at ? formatDateTime(c.ended_at) : 'in progress'}${c.duration_seconds ? ` · ${formatDuration(c.duration_seconds)}` : ''}` : undefined}
      className="max-w-lg"
    >
      <div className="space-y-5" data-testid="call-detail">
        {q.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          c && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {status && <Badge variant={status.variant}>{status.label}</Badge>}
                {c.ai_interest && <Badge variant={INTEREST[c.ai_interest]?.variant ?? 'secondary'}>Interest: {INTEREST[c.ai_interest]?.label ?? c.ai_interest}</Badge>}
                {c.ai_sentiment && <Badge variant={SENTIMENT[c.ai_sentiment]?.variant ?? 'secondary'}>{SENTIMENT[c.ai_sentiment]?.label ?? c.ai_sentiment}</Badge>}
                {(c.opted_out || c.do_not_call) && <Badge variant="destructive">Opted out</Badge>}
                {c.simulated && <Badge variant="secondary">Simulated</Badge>}
              </div>
              {c.agent_id && (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Summary</h3>
                  <p className="text-sm" data-testid="call-summary">
                    {c.ai_summary ?? (c.ai_processed_at ? 'No conversation took place.' : 'Being reviewed…')}
                  </p>
                  {c.ai_next_step && <p className="text-xs text-muted-foreground">Next step: {c.ai_next_step}</p>}
                  {c.callback_requested_at && <p className="text-xs text-muted-foreground">Asked for a call back: {formatDateTime(c.callback_requested_at)}</p>}
                </section>
              )}
              {c.ai_outcomes.length > 0 && (
                <section>
                  <h3 className="mb-1 text-sm font-semibold">Captured</h3>
                  <dl className="divide-y rounded-lg border text-sm">
                    {c.ai_outcomes.map((o) => (
                      <div key={o.key} className="flex justify-between gap-3 px-3 py-2">
                        <dt className="text-muted-foreground">{o.label}</dt>
                        <dd className="min-w-0 break-words text-right font-medium">{formatOutcome(o.value, o.type)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
              <section>
                <h3 className="mb-2 text-sm font-semibold">Transcript</h3>
                {c.transcript.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No transcript for this call.</p>
                ) : (
                  <div className="space-y-2 rounded-lg bg-muted/40 p-3" data-testid="transcript">
                    {c.transcript.map((t, i) => (
                      <div key={i} className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}>
                        <div className={cn('max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm', t.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-card shadow-sm ring-1 ring-border')}>
                          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-70">{t.role === 'user' ? c.contact_name || 'Contact' : c.agent?.name || 'Agent'}</div>
                          {t.text}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <div className="flex flex-wrap gap-3 text-sm">
                {c.contact_id && (
                  <Link className="font-medium text-primary hover:underline" to={`/apps/${appId}/audience/contacts/${c.contact_id}`}>
                    Open contact
                  </Link>
                )}
                {c.agent && (
                  <Link className="font-medium text-primary hover:underline" to={`/apps/${appId}/voice/agents/${c.agent.id}`}>
                    Agent: {c.agent.name} (v{c.agent.version})
                  </Link>
                )}
              </div>
            </>
          )
        )}
      </div>
    </Sheet>
  )
}
