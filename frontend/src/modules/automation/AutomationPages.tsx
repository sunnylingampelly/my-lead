import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { MoreHorizontal, Plus, Search, Workflow as WorkflowIcon } from 'lucide-react'
import { automationApi, type WorkflowSummary, useWorkflows, wqk } from '@/api/automation'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Pagination } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import { cn, timeAgo } from '@/lib/utils'
import { NODE_META, STARTERS, TRIGGER_LABEL } from './meta'
import { WorkflowStatusBadge } from './RunsPanel'

function NewWorkflowDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { app } = useWorkspace()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<string | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
          <DialogDescription>Start from a ready-made journey or a blank canvas. You choose senders, templates and lists in the builder.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {STARTERS.map((s) => (
            <button
              key={s.key}
              disabled={!!busy}
              data-testid={`starter-${s.key}`}
              onClick={async () => {
                setBusy(s.key)
                try {
                  const w = await automationApi(app!.id).create({ name: s.key === 'blank' ? 'Untitled workflow' : s.name, description: s.description, graph: s.graph })
                  navigate(`/apps/${app!.id}/automation/${w.id}`)
                } catch (e) {
                  toast.error(errorMessage(e))
                  setBusy(null)
                }
              }}
              className="group rounded-xl border p-4 text-left transition hover:border-primary/50 hover:bg-accent/30 disabled:opacity-60"
            >
              <div className="mb-3 flex items-center gap-1">
                {s.graph.nodes.slice(0, 6).map((n) => {
                  const m = NODE_META[n.type]
                  const Icon = m.icon
                  return (
                    <span key={n.id} className={cn('flex size-7 items-center justify-center rounded-md', m.tone)}>
                      <Icon className="size-3.5" />
                    </span>
                  )
                })}
              </div>
              <div className="text-sm font-semibold">{s.name}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{s.description}</div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function AutomationPage() {
  const { app, org, can } = useWorkspace()
  const appId = app!.id
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  const [del, setDel] = useState<WorkflowSummary | null>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])
  const q = useWorkflows(appId, { page, page_size: 20, status: status || undefined, search: debounced || undefined })
  const f = (n: number) => formatCount(n, app!.default_country)
  const write = can('automation.write')
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${appId}` }, { label: 'Automation' }]}
        title="Automation"
        description="Journeys that send the right email, text or call when something happens to a contact."
        actions={
          write && (
            <Button onClick={() => setCreating(true)}>
              <Plus /> New workflow
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="flex gap-1">
            {[['', 'All'], ['active', 'Active'], ['paused', 'Paused'], ['draft', 'Drafts'], ['archived', 'Archived']].map(([k, label]) => (
              <button key={k} onClick={() => { setStatus(k!); setPage(1) }} className={cn('rounded-full px-3 py-1.5 text-xs font-medium transition', status === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                {label}
              </button>
            ))}
          </div>
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search workflows" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search workflows" data-page-search />
          </div>
        </div>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState
            icon={WorkflowIcon}
            title={debounced || status ? 'No workflows match' : 'No workflows yet'}
            description="Welcome new subscribers, follow up with people who didn’t open, or call contacts who go quiet. Every message still respects consent and quiet hours."
            action={write && !debounced && !status && <Button variant="outline" onClick={() => setCreating(true)}>Create your first workflow</Button>}
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Workflow</TH>
                  <TH>Status</TH>
                  <TH>Trigger</TH>
                  <TH className="text-right">In progress</TH>
                  <TH className="text-right">Completed</TH>
                  <TH>Updated</TH>
                  <TH className="w-10" />
                </TR>
              </THead>
              <TBody>
                {q.data.items.map((w) => (
                  <TR key={w.id} className="cursor-pointer" onClick={() => navigate(`/apps/${appId}/automation/${w.id}`)}>
                    <TD>
                      <div className="font-medium">{w.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {w.steps} step{w.steps === 1 ? '' : 's'}
                        {w.has_unpublished_changes && w.version > 0 && ' · unpublished changes'}
                      </div>
                    </TD>
                    <TD>
                      <WorkflowStatusBadge status={w.status} />
                    </TD>
                    <TD className="text-sm text-muted-foreground">{w.trigger ? TRIGGER_LABEL[w.trigger] : '—'}</TD>
                    <TD className="text-right tabular-nums">{f((w.runs.waiting ?? 0) + (w.runs.running ?? 0))}</TD>
                    <TD className="text-right tabular-nums">{f(w.runs.completed ?? 0)}</TD>
                    <TD className="text-xs text-muted-foreground">{timeAgo(w.updated_at)}</TD>
                    <TD onClick={(e) => e.stopPropagation()}>
                      {write && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`Actions for ${w.name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => navigate(`/apps/${appId}/automation/${w.id}`)}>Open</DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={async () => {
                                try {
                                  const d = await automationApi(appId).duplicate(w.id)
                                  navigate(`/apps/${appId}/automation/${d.id}`)
                                } catch (e) {
                                  toast.error(errorMessage(e))
                                }
                              }}
                            >
                              Duplicate
                            </DropdownMenuItem>
                            {w.version === 0 && (
                              <DropdownMenuItem className="text-destructive" onSelect={() => setDel(w)}>
                                Delete draft
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={20} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <Card className="mt-6">
        <CardContent className="grid gap-4 pt-6 text-sm text-muted-foreground md:grid-cols-3">
          <div>
            <Badge variant="secondary">Safe by default</Badge>
            <p className="mt-2">Each message step uses the same checks as campaigns: consent, suppression, quiet hours, DLT and TCPA rules.</p>
          </div>
          <div>
            <Badge variant="secondary">Versioned</Badge>
            <p className="mt-2">Edit freely. Changes reach people only when you publish, and everyone’s path is recorded step by step.</p>
          </div>
          <div>
            <Badge variant="secondary">Once per person</Badge>
            <p className="mt-2">Contacts enter a workflow once unless you allow re-entry, and receive each message step at most once.</p>
          </div>
        </CardContent>
      </Card>
      <NewWorkflowDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete “${del?.name}”?`}
        description="This draft has never run, so nothing else is affected."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          try {
            await automationApi(appId).remove(del!.id)
            await qc.invalidateQueries({ queryKey: wqk.all(appId) })
            toast.success('Workflow deleted')
          } catch (e) {
            toast.error(errorMessage(e))
          } finally {
            setDel(null)
          }
        }}
      />
    </>
  )
}
