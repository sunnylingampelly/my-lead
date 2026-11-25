import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Download, ShieldCheck, Trash2 } from 'lucide-react'
import { qk } from '@/api/queries'
import { orgApi, privacyApi } from '@/api/services'
import { errorMessage } from '@/api/client'
import { ErrorState, LoadingRows } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/misc'
import { useAuth } from '@/hooks/useAuth'
import { formatDateTime } from '@/lib/utils'
import type { Organization } from '@/types/api'

/** Organization → Security: require two-factor for owners and admins. */
export function OrgSecurityCard({ org, editable }: { org: Organization; editable: boolean }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [busy, setBusy] = useState(false)
  const on = !!org.require_mfa_admins

  const toggle = async () => {
    setBusy(true)
    try {
      await orgApi.update(org.id, { require_mfa_admins: !on })
      await qc.invalidateQueries({ queryKey: qk.orgs })
      toast.success(on ? 'Two-factor is no longer required' : 'Two-factor is now required for owners and admins')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <ShieldCheck className="size-4" /> Security
          {on ? <Badge variant="success">2FA required</Badge> : <Badge>2FA optional</Badge>}
        </CardTitle>
        <CardDescription>
          Require two-factor authentication for owners and admins. Anyone affected who hasn't set it up is sent to
          setup at their next sign-in and can't use organization admin actions (members, billing, deleting, data
          requests) until they do.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-primary" checked={on} disabled={!editable || busy}
            onChange={toggle} data-testid="require-mfa-toggle" />
          Require two-factor for owners and admins
        </label>
        {!on && editable && !user?.mfa_enabled && (
          <span className="text-sm text-muted-foreground">
            Turn it on for <Link to="/account?setup=1" className="text-primary underline">your own account</Link> first.
          </span>
        )}
      </CardContent>
    </Card>
  )
}

/** Organization → Data requests: past contact data exports and erasures (who and when, no personal data). */
export function DataRequestsCard({ orgId }: { orgId: string }) {
  const [page, setPage] = useState(1)
  const q = useQuery({ queryKey: ['data-requests', orgId, page], queryFn: () => privacyApi.requests(orgId, { page, page_size: 10 }) })
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.page_size)) : 1
  return (
    <Card id="data-requests">
      <CardHeader>
        <CardTitle>Data requests</CardTitle>
        <CardDescription>
          Data-subject requests handled under the DPDP Act 2023 / GDPR: "Download all data" and "Erase this contact"
          from a contact's profile. Erased contacts are identified only by their former ID.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? <LoadingRows rows={3} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> :
          q.data!.items.length === 0 ? <p className="text-sm text-muted-foreground">No requests yet.</p> : (
            <ul className="divide-y" data-testid="data-requests">
              {q.data!.items.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-3 text-sm">
                  {r.kind === 'erasure'
                    ? <Trash2 className="mt-0.5 size-4 shrink-0 text-danger-strong" />
                    : <Download className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {r.kind === 'erasure' ? 'Erasure' : 'Data export'} · {r.subject_label ?? <span className="font-mono text-xs">contact {r.contact_id.slice(0, 8)}</span>}
                    </div>
                    <div className="text-muted-foreground">
                      {r.application_name ?? 'Application'} · by {r.requested_by_name ?? 'a former member'}
                    </div>
                  </div>
                  <time className="text-muted-foreground" dateTime={r.created_at}>{formatDateTime(r.created_at)}</time>
                </li>
              ))}
            </ul>
          )}
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-2 text-sm">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="text-muted-foreground">{page} / {pages}</span>
            <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
