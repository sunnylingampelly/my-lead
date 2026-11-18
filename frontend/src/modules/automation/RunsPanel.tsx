import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, Circle, Clock, StopCircle, Users, XCircle } from 'lucide-react'
import { automationApi, type WorkflowRun, type WorkflowStatus, useWorkflowRuns, wqk } from '@/api/automation'
import { errorMessage } from '@/api/client'
import { EmptyState, LoadingRows } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/misc'
import { Sheet } from '@/components/ui/sheet'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Pagination } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn, formatDateTime, timeAgo } from '@/lib/utils'

const WF_STATUS: Record<WorkflowStatus, { label: string; variant: 'secondary' | 'success' | 'warning' | 'outline' }> = {
  draft: { label: 'Draft', variant: 'secondary' },
  active: { label: 'Active', variant: 'success' },
  paused: { label: 'Paused', variant: 'warning' },
  archived: { label: 'Archived', variant: 'outline' },
}

export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  const m = WF_STATUS[status]
  return (
    <Badge variant={m.variant}>
      {status === 'active' && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {m.label}
    </Badge>
  )
}

const RUN_STATUS: Record<WorkflowRun['status'], { label: string; variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive' }> = {
  waiting: { label: 'In progress', variant: 'default' },
  running: { label: 'In progress', variant: 'default' },
  completed: { label: 'Completed', variant: 'success' },
  exited: { label: 'Left early', variant: 'warning' },
  failed: { label: 'Failed', variant: 'destructive' },
}

const OUTCOME_ICON: Record<string, typeof Circle> = { done: CheckCircle2, waiting: Clock, failed: XCircle, skipped: Circle }

function RunDetail({ workflowId, run, onClose, canStop }: { workflowId: string; run: WorkflowRun | null; onClose: () => void; canStop: boolean }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['automation', app!.id, 'run', run?.id], queryFn: () => automationApi(app!.id).runSteps(workflowId, run!.id), enabled: !!run })
  return (
    <Sheet open={!!run} onOpenChange={(o) => { if (!o) onClose() }} title={run?.contact ?? ''} description="Every step this person has taken in the journey.">
        {run && (
          <div className="mt-4 space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={RUN_STATUS[run.status].variant}>{RUN_STATUS[run.status].label}</Badge>
              <span className="text-muted-foreground">Started {formatDateTime(run.started_at)}</span>
            </div>
            {run.exit_reason && <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong">{run.exit_reason}</p>}
            {run.contact_id && (
              <Link className="text-primary hover:underline" to={`/apps/${app!.id}/audience/contacts/${run.contact_id}`}>
                Open contact
              </Link>
            )}
            <ol className="relative space-y-4 border-l pl-5">
              {q.data?.steps.map((s, i) => {
                const Icon = OUTCOME_ICON[s.outcome] ?? CheckCircle2
                return (
                  <li key={i} className="relative">
                    <Icon className={cn('absolute -left-[27px] top-0.5 size-4 bg-card', s.outcome === 'failed' ? 'text-destructive' : s.outcome === 'waiting' ? 'text-primary' : 'text-success-strong')} />
                    <div className="font-medium">{s.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.detail ?? s.outcome.replace('_', ' ')} · {formatDateTime(s.at)}
                    </div>
                  </li>
                )
              })}
              {q.data?.steps.length === 0 && <li className="text-muted-foreground">No steps yet.</li>}
            </ol>
            {canStop && ['waiting', 'running'].includes(run.status) && (
              <Button
                variant="outline"
                className="w-full text-destructive"
                onClick={async () => {
                  try {
                    await automationApi(app!.id).stopRun(workflowId, run.id)
                    await qc.invalidateQueries({ queryKey: wqk.all(app!.id) })
                    toast.success('Removed from the journey')
                    onClose()
                  } catch (e) {
                    toast.error(errorMessage(e))
                  }
                }}
              >
                <StopCircle /> Remove from journey
              </Button>
            )}
          </div>
        )}
    </Sheet>
  )
}

const FILTERS = [
  ['', 'All'],
  ['waiting', 'In progress'],
  ['completed', 'Completed'],
  ['exited', 'Left early'],
  ['failed', 'Failed'],
] as const

export function RunsPanel({ workflowId, canStop }: { workflowId: string; canStop: boolean }) {
  const { app } = useWorkspace()
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<WorkflowRun | null>(null)
  const q = useWorkflowRuns(app!.id, workflowId, { page, page_size: 25, status: status || undefined })
  return (
    <Card className="mx-auto max-w-5xl">
      <div className="flex flex-wrap gap-1 border-b p-3">
        {FILTERS.map(([k, label]) => (
          <button key={k} onClick={() => { setStatus(k); setPage(1) }} className={cn('rounded-full px-3 py-1.5 text-xs font-medium transition', status === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
            {label}
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data?.items.length ? (
        <EmptyState icon={Users} title="No one has entered yet" description="People appear here as soon as they meet the trigger of an active workflow." />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Contact</TH>
                <TH>Status</TH>
                <TH>Current step</TH>
                <TH>Next action</TH>
                <TH>Entered</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((r) => (
                <TR key={r.id} className="cursor-pointer" onClick={() => setOpen(r)} data-testid="run-row">
                  <TD className="font-medium">{r.contact}</TD>
                  <TD>
                    <Badge variant={RUN_STATUS[r.status].variant}>{RUN_STATUS[r.status].label}</Badge>
                  </TD>
                  <TD className="text-sm">{r.current_step ?? '—'}</TD>
                  <TD className="text-xs text-muted-foreground">{r.status === 'waiting' && r.wake_at ? formatDateTime(r.wake_at) : (r.exit_reason ?? '—')}</TD>
                  <TD className="text-xs text-muted-foreground">{timeAgo(r.started_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={25} total={q.data.total} onPage={setPage} />
        </>
      )}
      <RunDetail workflowId={workflowId} run={open} onClose={() => setOpen(null)} canStop={canStop} />
    </Card>
  )
}
