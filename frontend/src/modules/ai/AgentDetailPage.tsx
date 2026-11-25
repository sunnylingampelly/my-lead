import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FlaskConical, History, Pencil, Play, Trash2 } from 'lucide-react'
import { aiApi, aiqk, useAgent, useAgentRuns, useAiStatus, useAiTools, useRun } from '@/api/ai'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, FullPageSpinner, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/misc'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn } from '@/lib/utils'
import { AgentEditor } from './AgentEditor'
import { SimulatedNotice } from './AgentsPage'
import { FlowChips, RunStatus, RunTimeline, Switch } from './components'
import { Markdown } from './Markdown'

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—')

export function AgentDetailPage() {
  const { app } = useWorkspace()
  const appId = app!.id
  const { agentId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const canManage = app!.permissions.includes('ai.manage')
  const agent = useAgent(appId, agentId)
  const runs = useAgentRuns(appId, agentId)
  const tools = useAiTools(appId)
  const status = useAiStatus(appId)
  const selected = params.get('run') ?? runs.data?.[0]?.id ?? null
  const run = useRun(appId, selected)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState<'run' | 'dry' | 'toggle' | 'delete' | null>(null)

  if (agent.isLoading) return <FullPageSpinner />
  if (agent.error || !agent.data) return <ErrorState error={agent.error} onRetry={() => agent.refetch()} />
  const a = agent.data
  const refresh = () => qc.invalidateQueries({ queryKey: aiqk.all(appId) })

  const runNow = async (dry: boolean) => {
    setBusy(dry ? 'dry' : 'run')
    try {
      const r = await aiApi(appId).run(a.id, dry)
      setParams({ run: r.id }, { replace: true })
      refresh()
      toast.success(dry ? 'Test run finished: nothing was changed' : r.status === 'completed' ? 'Run finished' : 'Run started')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const toggle = async (on: boolean) => {
    setBusy('toggle')
    try {
      await aiApi(appId).updateAgent(a.id, { enabled: on })
      refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const remove = async () => {
    setBusy('delete')
    try {
      await aiApi(appId).deleteAgent(a.id)
      refresh()
      navigate(`/apps/${appId}/ai/agents`)
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(null)
    }
  }
  const toolLabel = (n: string) => tools.data?.find((t) => t.name === n)?.label ?? n

  return (
    <div>
      <PageHeader
        title={a.name}
        description={a.description || a.trigger_label}
        breadcrumbs={[{ label: app!.name, to: `/apps/${appId}` }, { label: 'AI Agents', to: `/apps/${appId}/ai/agents` }, { label: a.name }]}
        actions={
          canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="mr-1 flex items-center gap-2 text-sm">
                <Switch checked={a.enabled} onChange={toggle} disabled={busy === 'toggle'} label={a.enabled ? 'Turn off' : 'Turn on'} testId="agent-detail-toggle" />
                {a.enabled ? 'On' : 'Off'}
              </label>
              <Button variant="outline" onClick={() => runNow(true)} loading={busy === 'dry'} disabled={!!busy} data-testid="agent-dry-run">
                <FlaskConical /> Test run
              </Button>
              <Button onClick={() => runNow(false)} loading={busy === 'run'} disabled={!!busy} data-testid="agent-run-now">
                <Play /> Run now
              </Button>
              <Button variant="ghost" size="icon" aria-label="Edit agent" onClick={() => setEditing(true)}>
                <Pencil />
              </Button>
              <Button variant="ghost" size="icon" aria-label="Delete agent" onClick={() => setDeleting(true)}>
                <Trash2 />
              </Button>
            </div>
          )
        }
      />
      {status.data?.simulated && <SimulatedNotice />}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>How it works</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <FlowChips steps={a.flow} />
              <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-2">
                <dt className="text-muted-foreground">Starts</dt>
                <dd>{a.trigger_label}</dd>
                <dt className="text-muted-foreground">Mode</dt>
                <dd>{a.mode === 'approve' ? 'Asks for approval before changing anything' : 'Acts on its own'}</dd>
                <dt className="text-muted-foreground">Tools</dt>
                <dd className="flex flex-wrap gap-1">
                  {a.allowed_tools.map((t) => (
                    <Badge key={t} variant="secondary">
                      {toolLabel(t)}
                    </Badge>
                  ))}
                </dd>
                <dt className="text-muted-foreground">Reports to</dt>
                <dd>
                  {[a.destinations.in_app && 'In-app', ...(a.destinations.slack_channels ?? []).map((c) => `Slack #${c.name}`), a.destinations.email_user_ids.length && `Email (${a.destinations.email_user_ids.length})`].filter(Boolean).join(', ') || 'Nowhere'}
                </dd>
                <dt className="text-muted-foreground">Runs as</dt>
                <dd>{a.owner_name}</dd>
                {a.next_run_at && (
                  <>
                    <dt className="text-muted-foreground">Next run</dt>
                    <dd>{when(a.next_run_at)}</dd>
                  </>
                )}
              </dl>
              {a.instructions && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none font-medium text-foreground">Instructions</summary>
                  <p className="mt-1 whitespace-pre-wrap">{a.instructions}</p>
                </details>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="size-4" /> Runs
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {runs.data?.length ? (
                <ul className="divide-y" data-testid="agent-runs">
                  {runs.data.map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => setParams({ run: r.id }, { replace: true })} className={cn('flex w-full flex-col items-start gap-1 px-5 py-2.5 text-left text-sm hover:bg-muted/50', r.id === selected && 'bg-accent')} aria-current={r.id === selected}>
                        <span className="flex w-full items-center gap-2">
                          <span className="tabular-nums text-muted-foreground">{when(r.created_at)}</span>
                          <span className="ml-auto">
                            <RunStatus run={r} />
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground">{r.trigger_key.startsWith('manual') ? 'Run by hand' : r.trigger_key.startsWith('schedule') ? 'Scheduled' : String(r.trigger.event ?? 'Event').replace(/_/g, ' ')}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 pb-5 text-sm text-muted-foreground">No runs yet. Use “Test run” to see what it would do.</p>
              )}
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Run log</CardTitle>
          </CardHeader>
          <CardContent>
            {!selected ? (
              <EmptyState icon={History} title="Nothing to show yet" description="Each run lists every tool the agent used, what it found, what it changed or proposed, and where it reported." />
            ) : run.data ? (
              <div className="space-y-4" data-testid="run-detail">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <RunStatus run={run.data} />
                  <span className="text-muted-foreground">{when(run.data.created_at)}</span>
                  {run.data.input_tokens + run.data.output_tokens > 0 && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{run.data.input_tokens + run.data.output_tokens} tokens</span>}
                </div>
                {run.data.error && <p className="rounded-md border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-strong">{run.data.error}</p>}
                <RunTimeline steps={run.data.steps} />
                {run.data.summary && run.data.status === 'completed' && (
                  <details className="text-xs" open={false}>
                    <summary className="cursor-pointer select-none font-medium">Full report</summary>
                    <Markdown text={run.data.summary} className="mt-2" />
                  </details>
                )}
              </div>
            ) : (
              <FullPageSpinner />
            )}
          </CardContent>
        </Card>
      </div>
      {editing && <AgentEditor appId={appId} open onOpenChange={setEditing} initial={a} agent={a} />}
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} title={`Delete ${a.name}?`} description="The agent and its run history are deleted. Actions it already took stay." confirmLabel="Delete agent" destructive loading={busy === 'delete'} onConfirm={remove} />
    </div>
  )
}
