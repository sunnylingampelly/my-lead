import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCheck } from 'lucide-react'
import { SlackLogo as Slack } from '@/components/SlackLogo'
import { aiApi, aiqk, useApprovals } from '@/api/ai'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/misc'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn } from '@/lib/utils'
import type { ActionCard as Card_ } from '@/types/ai'
import { ActionCard } from './ActionCard'

/** Actions proposed by agents in approval mode. Approving runs it with your permissions; it's logged. */
export function ApprovalsPage() {
  const { app } = useWorkspace()
  const appId = app!.id
  const [tab, setTab] = useState<'pending' | 'decided'>('pending')
  const q = useApprovals(appId, tab)
  const qc = useQueryClient()
  const decide = (c: Card_) => async (approve: boolean, args?: Record<string, unknown>) => {
    const out = approve ? await aiApi(appId).approve(c.id, args) : await aiApi(appId).reject(c.id)
    qc.invalidateQueries({ queryKey: aiqk.status(appId) })
    qc.invalidateQueries({ queryKey: aiqk.approvals(appId, 'decided') })
    return out
  }
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Approvals"
        description="Changes your AI agents want to make. Nothing happens until someone approves it, here or from Slack."
        breadcrumbs={[{ label: app!.name, to: `/apps/${appId}` }, { label: 'AI Team' }, { label: 'Approvals' }]}
      />
      <div className="mb-4 inline-flex rounded-lg border p-0.5" role="tablist">
        {(['pending', 'decided'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('rounded-md px-3 py-1 text-sm', tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
            {t === 'pending' ? 'Waiting' : 'Decided'}
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <Card>
          <LoadingRows />
        </Card>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.length ? (
        <Card>
          <EmptyState
            icon={CheckCheck}
            title={tab === 'pending' ? 'Nothing waiting for approval' : 'No decisions yet'}
            description={
              <>
                Agents in “Ask for approval” mode queue their changes here. <Link to={`/apps/${appId}/ai/agents`} className="text-primary hover:underline">Manage agents</Link>
              </>
            }
          />
        </Card>
      ) : (
        <ul className="space-y-3" data-testid="approvals">
          {q.data.map((c) => (
            <li key={`${c.id}-${c.status}`} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {c.agent_id && (
                  <Link to={`/apps/${appId}/ai/agents/${c.agent_id}${c.run_id ? `?run=${c.run_id}` : ''}`} className="font-medium hover:text-foreground">
                    {c.agent_name ?? 'Agent'}
                  </Link>
                )}
                <span>{new Date(c.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                {c.decided_via === 'slack' && (
                  <Badge variant="outline">
                    <Slack className="size-3" /> Decided in Slack
                  </Badge>
                )}
              </div>
              <ActionCard card={c} mode="approve" onDecide={decide(c)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
