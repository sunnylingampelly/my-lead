import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bot, Hash as Slack, Plus, Sparkles, Wand2 } from 'lucide-react'
import { aiApi, aiqk, useAgents, useAgentTemplates, useAiStatus } from '@/api/ai'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/misc'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { Agent, AgentConfig, AgentRun, AgentTemplate } from '@/types/ai'
import { AgentEditor, DescribeDialog } from './AgentEditor'
import { FlowChips, RunStatus, Switch } from './components'
import { BLANK_AGENT as BLANK, iconFor, TEMPLATE_ICON } from './lib'

function fromTemplate(t: AgentTemplate): AgentConfig {
  return { ...BLANK, name: t.name, description: t.description, template: t.key, instructions: t.instructions, trigger: t.trigger, allowed_tools: t.allowed_tools, mode: t.mode }
}

export function SimulatedNotice() {
  return (
    <div className="mb-5 flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft px-4 py-3 text-sm text-warning-strong" data-testid="ai-simulated-notice">
      <Sparkles className="mt-0.5 size-4 shrink-0" />
      <span>
        <strong>Simulation mode.</strong> No OpenAI key is configured, so agents follow a scripted plan per template and the assistant understands a few kinds of request. Everything else (tools, approvals, Slack) works for real.
      </span>
    </div>
  )
}

function AgentCard({ agent, appId, canManage }: { agent: Agent; appId: string; canManage: boolean }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const Icon = iconFor(agent.template ? TEMPLATE_ICON[agent.template] : null)
  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      await aiApi(appId).updateAgent(agent.id, { enabled: on })
      qc.invalidateQueries({ queryKey: aiqk.agents(appId) })
      toast.success(on ? `${agent.name} is on` : `${agent.name} is off`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="flex flex-col p-4 transition hover:border-primary/40" data-testid="agent-card">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <Link to={`/apps/${appId}/ai/agents/${agent.id}`} className="block truncate font-semibold hover:text-primary">
            {agent.name}
          </Link>
          <div className="text-xs text-muted-foreground">{agent.trigger_label}</div>
        </div>
        <Switch checked={agent.enabled} onChange={toggle} disabled={!canManage || busy} label={`${agent.enabled ? 'Turn off' : 'Turn on'} ${agent.name}`} testId="agent-toggle" />
      </div>
      {agent.description && <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{agent.description}</p>}
      <FlowChips steps={agent.flow} className="mt-3" />
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3 text-xs text-muted-foreground">
        <Badge variant={agent.mode === 'approve' ? 'secondary' : 'outline'}>{agent.mode === 'approve' ? 'Asks first' : 'Acts on its own'}</Badge>
        {agent.destinations.slack_channels?.length ? (
          <span className="inline-flex items-center gap-1">
            <Slack className="size-3" /> #{agent.destinations.slack_channels[0]!.name}
          </span>
        ) : null}
        {agent.last_status && agent.last_run_at && (
          <span className="ml-auto inline-flex items-center gap-1">
            Last run <RunStatus run={{ status: agent.last_status as AgentRun['status'], dry_run: false, simulated: false }} />
          </span>
        )}
      </div>
    </Card>
  )
}

export function AgentsPage() {
  const { app } = useWorkspace()
  const appId = app!.id
  const canManage = app!.permissions.includes('ai.manage')
  const agents = useAgents(appId)
  const meta = useAgentTemplates(appId)
  const status = useAiStatus(appId)
  const navigate = useNavigate()
  const [editor, setEditor] = useState<{ key: number; cfg: AgentConfig } | null>(null)
  const [describe, setDescribe] = useState(false)

  const open = (cfg: AgentConfig) => setEditor({ key: Date.now(), cfg })

  return (
    <div>
      <PageHeader
        title="AI Agents"
        description="Agents watch for events or run on a schedule, use your data, and report to the team in the app, by email or in Slack."
        breadcrumbs={[{ label: app!.name, to: `/apps/${appId}` }, { label: 'AI Team' }, { label: 'AI Agents' }]}
        actions={
          canManage && (
            <>
              <Button variant="outline" onClick={() => setDescribe(true)} data-testid="agent-describe">
                <Wand2 /> Describe what you want
              </Button>
              <Button onClick={() => open(BLANK)}>
                <Plus /> New agent
              </Button>
            </>
          )
        }
      />
      {status.data?.simulated && <SimulatedNotice />}
      {status.data && !status.data.slack.connected && canManage && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
          <Slack className="size-4 text-primary" />
          <span className="flex-1">Connect Slack to post agent reports and approve actions from a channel.</span>
          <Button asChild size="sm" variant="outline">
            <Link to={`/apps/${appId}/ai/integrations`}>Connect Slack</Link>
          </Button>
        </div>
      )}

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold">Your agents</h2>
        {agents.isLoading ? (
          <Card>
            <LoadingRows />
          </Card>
        ) : agents.error ? (
          <ErrorState error={agents.error} onRetry={() => agents.refetch()} />
        ) : agents.data?.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {agents.data.map((a) => (
              <AgentCard key={a.id} agent={a} appId={appId} canManage={canManage} />
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState icon={Bot} title="No agents yet" description="Start from a template below: most are ready to switch on." />
          </Card>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Templates</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {meta.data?.templates.map((t) => {
            const Icon = iconFor(t.icon)
            return (
              <Card key={t.key} className="flex flex-col p-4" data-testid={`template-${t.key}`}>
                <div className="flex items-center gap-2">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-primary">
                    <Icon className="size-4" />
                  </span>
                  <h3 className="font-semibold leading-tight">{t.name}</h3>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{t.description}</p>
                <FlowChips steps={t.flow} className="mt-3" />
                {canManage && (
                  <div className="mt-auto pt-4">
                    <Button variant="outline" size="sm" onClick={() => open(fromTemplate(t))} data-testid={`use-template-${t.key}`}>
                      Use template
                    </Button>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      </section>

      {editor && (
        <AgentEditor
          key={editor.key}
          appId={appId}
          open
          onOpenChange={(o) => !o && setEditor(null)}
          initial={editor.cfg}
          onSaved={(a) => navigate(`/apps/${appId}/ai/agents/${a.id}`)}
        />
      )}
      <DescribeDialog appId={appId} open={describe} onOpenChange={setDescribe} onDraft={open} />
    </div>
  )
}
