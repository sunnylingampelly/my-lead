import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { ScrollText } from 'lucide-react'
import { useApplications, useAuditLogs } from '@/api/queries'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatDateTime } from '@/lib/utils'
import { describeAction } from './auditLabels'

const PAGE_SIZE = 25

export function AuditLogPage() {
  const { orgId } = useParams()
  const { org } = useWorkspace()
  const [page, setPage] = useState(1)
  const q = useAuditLogs(orgId!, { page, page_size: PAGE_SIZE })
  const apps = useApplications(orgId)
  const appName = (id: string | null) => (id ? (apps.data?.find((a) => a.id === id)?.name ?? 'Deleted application') : '—')
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / PAGE_SIZE)) : 1

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: 'Audit log' }]}
        title="Audit log"
        description="A permanent record of security and administrative actions in this organization."
      />
      <Card>
        {q.isLoading ? (
          <LoadingRows rows={8} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data?.items.length === 0 ? (
          <EmptyState icon={ScrollText} title="No events yet" />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Actor</TH>
                <TH>Action</TH>
                <TH>Application</TH>
                <TH>Details</TH>
              </TR>
            </THead>
            <TBody>
              {q.data?.items.map((l) => (
                <TR key={l.id}>
                  <TD className="whitespace-nowrap text-muted-foreground">{formatDateTime(l.created_at)}</TD>
                  <TD className="font-medium">{l.actor_name ?? 'System'}</TD>
                  <TD>{describeAction(l.action)}</TD>
                  <TD className="text-muted-foreground">{appName(l.application_id)}</TD>
                  <TD className="max-w-xs truncate text-muted-foreground">{l.summary ?? ''}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              Page {page} of {pages} · {q.data?.total} events
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </>
  )
}
