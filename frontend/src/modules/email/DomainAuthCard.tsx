import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, Check, CheckCircle2, Copy, Globe, HelpCircle, RefreshCw, XCircle } from 'lucide-react'
import { http, errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { cn, formatDateTime } from '@/lib/utils'
import type { Sender } from '@/types/email'

export type RecordStatus = 'pass' | 'missing' | 'wrong' | 'warn' | 'error'
export interface DomainRecord {
  key: string
  label: string
  type: string
  host: string
  status: RecordStatus
  expected: string | null
  found: string[]
  detail: string
  required: boolean
  policy?: string | null
}
export interface DomainCheck {
  domain: string
  sender_id: string
  status: 'authenticated' | 'partial' | 'unauthenticated' | 'error' | 'free_mail' | 'disabled'
  checked_at: string | null
  records: DomainRecord[]
  dmarc_policy: string | null
  spf_include: string
}

const STATUS: Record<DomainCheck['status'], { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  authenticated: { label: 'Authenticated', variant: 'success' },
  partial: { label: 'Partly set up', variant: 'warning' },
  unauthenticated: { label: 'Not authenticated', variant: 'destructive' },
  error: { label: 'Could not check', variant: 'warning' },
  free_mail: { label: 'Free email domain', variant: 'warning' },
  disabled: { label: 'Checks off', variant: 'secondary' },
}
const RECORD_LABEL: Record<RecordStatus, string> = { pass: 'Pass', missing: 'Missing', wrong: 'Wrong', warn: 'Recommended', error: 'Lookup failed' }

const domainKey = (appId: string, senderId: string) => ['email', appId, 'domain', senderId] as const

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Copied')
  } catch {
    toast.error('Couldn’t copy. Select the text and copy it manually.')
  }
}

function CopyValue({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-start gap-1.5">
        <code className="min-w-0 flex-1 break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px] leading-snug">{value}</code>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          aria-label={`Copy ${label.toLowerCase()}`}
          data-testid={testId}
          onClick={async () => {
            await copy(value)
            setDone(true)
            window.setTimeout(() => setDone(false), 1500)
          }}
        >
          {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  )
}

function StatusIcon({ s }: { s: RecordStatus }) {
  if (s === 'pass') return <CheckCircle2 className="size-4 shrink-0 text-success-strong" aria-label="Pass" />
  if (s === 'warn' || s === 'error') return <AlertTriangle className="size-4 shrink-0 text-warning-strong" aria-label={RECORD_LABEL[s]} />
  return <XCircle className="size-4 shrink-0 text-destructive" aria-label={RECORD_LABEL[s]} />
}

function RecordRow({ r }: { r: DomainRecord }) {
  const needsChange = r.status === 'missing' || r.status === 'wrong'
  return (
    <li className="space-y-2 rounded-md border p-2.5" data-testid={`dns-record-${r.key}`} data-status={r.status}>
      <div className="flex items-center gap-2">
        <StatusIcon s={r.status} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{r.label}</span>
        <Badge variant="secondary">{r.type}</Badge>
        <Badge variant={r.status === 'pass' ? 'success' : r.status === 'warn' || r.status === 'error' ? 'warning' : 'destructive'}>{RECORD_LABEL[r.status]}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{r.detail}</p>
      {needsChange && r.expected && (
        <div className="space-y-2">
          <CopyValue label="Host / name" value={r.host} testId={`copy-host-${r.key}`} />
          <CopyValue label={`Value (${r.type})`} value={r.expected} testId={`copy-value-${r.key}`} />
        </div>
      )}
      {r.found.length > 0 && r.status !== 'pass' && (
        <div className="text-[11px] text-muted-foreground">
          Found now: <span className="break-all font-mono">{r.found.join(' | ')}</span>
        </div>
      )}
    </li>
  )
}

/** Live SPF / DKIM / DMARC / MX status for a sender's domain, with the exact records to add. */
export function DomainAuthCard({ appId, senders }: { appId: string; senders: Sender[] }) {
  const qc = useQueryClient()
  // One sender per domain is enough: DNS belongs to the domain.
  const byDomain = new Map<string, Sender>()
  for (const s of senders) if (!byDomain.has(s.domain) || s.status === 'verified') byDomain.set(s.domain, s)
  const choices = [...byDomain.values()]
  const [picked, setPicked] = useState<string | null>(null)
  const sender = choices.find((s) => s.id === picked) ?? choices[0]
  const q = useQuery({
    queryKey: domainKey(appId, sender?.id ?? ''),
    queryFn: () => http.get<DomainCheck>(`/apps/${appId}/email/senders/${sender!.id}/domain`).then((r) => r.data),
    enabled: !!sender,
    staleTime: 60_000,
  })
  const [busy, setBusy] = useState(false)
  const recheck = async () => {
    if (!sender) return
    setBusy(true)
    try {
      const r = await http.post<DomainCheck>(`/apps/${appId}/email/senders/${sender.id}/domain/check`)
      qc.setQueryData(domainKey(appId, sender.id), r.data)
      qc.invalidateQueries({ queryKey: ['email', appId, 'readiness'] })
      toast.success(r.data.status === 'authenticated' ? `${r.data.domain} is authenticated` : 'DNS checked again')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const d = q.data
  return (
    <Card className="h-fit min-w-0" data-testid="domain-auth-card">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Globe className="size-4" /> Domain authentication
          </CardTitle>
          {d && <Badge variant={STATUS[d.status].variant} data-testid="domain-auth-status">{STATUS[d.status].label}</Badge>}
        </div>
        <CardDescription>Gmail and Yahoo require SPF, DKIM and DMARC for bulk senders. Add these records at your DNS provider.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {!sender ? (
          <p className="text-muted-foreground">Add a sender address to see the records for its domain.</p>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {choices.length > 1 ? (
                <Select aria-label="Domain" value={sender.id} onChange={(e) => setPicked(e.target.value)} className="w-full sm:flex-1">
                  {choices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.domain}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="min-w-0 flex-1 truncate font-mono text-sm">{sender.domain}</span>
              )}
              <Button size="sm" variant="outline" loading={busy} onClick={recheck} data-testid="domain-check-again" className="w-full sm:w-auto">
                <RefreshCw /> Check again
              </Button>
            </div>
            {q.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : q.isError ? (
              <p className="text-destructive">{errorMessage(q.error)}</p>
            ) : d?.status === 'free_mail' ? (
              <p className="rounded-md border border-warning-border bg-warning-soft p-2.5 text-warning-strong">
                {d.domain} is a free email provider. You cannot add DNS records for it, and its DMARC policy makes campaign email land in spam. Use an address on your own domain.
              </p>
            ) : d?.status === 'disabled' ? (
              <p className="text-muted-foreground">DNS checks are turned off on this server. Add SPF (include:{d.spf_include}), DKIM and DMARC records at your DNS provider.</p>
            ) : d ? (
              <>
                <ul className="space-y-2">
                  {d.records.map((r) => (
                    <RecordRow key={r.key} r={r} />
                  ))}
                </ul>
                <p className={cn('flex items-start gap-1.5 text-muted-foreground')}>
                  <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    DNS changes can take up to an hour to appear. Results are cached for 10 minutes and checked again daily.
                    {d.checked_at && ` Last checked ${formatDateTime(d.checked_at)}.`} Unauthenticated domains get a warning before sending; sending is not blocked.
                  </span>
                </p>
              </>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
