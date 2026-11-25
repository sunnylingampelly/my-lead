import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CheckSquare, Plus } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { cqk, crmApi, type TaskQuery, useTasks, useTaskSummary } from '@/api/crm'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/misc'
import { Pagination } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn } from '@/lib/utils'
import { TaskFormDialog } from './components'
import { TaskRow } from './Timeline'

const TABS: { key: string; label: string; q: Partial<TaskQuery> }[] = [
  { key: 'overdue', label: 'Overdue', q: { due: 'overdue', status: 'open' } },
  { key: 'today', label: 'Today', q: { due: 'today', status: 'open' } },
  { key: 'upcoming', label: 'Upcoming', q: { due: 'upcoming', status: 'open' } },
  { key: 'none', label: 'No date', q: { due: 'none', status: 'open' } },
  { key: 'done', label: 'Done', q: { status: 'done' } },
]

export function TasksPage() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const summary = useTaskSummary(appId)
  const [tab, setTab] = useState(() => 'today')
  const [scope, setScope] = useState<'me' | 'all'>('me')
  const [page, setPage] = useState(1)
  const [create, setCreate] = useState(() => new URLSearchParams(window.location.search).get('new') === '1')
  const t = TABS.find((x) => x.key === tab)!
  const q = useTasks(appId, { ...t.q, assignee_id: scope === 'me' ? 'me' : undefined, page, page_size: 25 })
  const counts: Record<string, number | undefined> = { overdue: summary.data?.overdue, today: summary.data?.today }
  // ?task=<id> (from a notification) pins that task above the list.
  const [params, setParams] = useSearchParams()
  const focusId = params.get('task')
  const focus = useQuery({
    queryKey: cqk.tasks(appId, { focus: focusId }),
    queryFn: () => crmApi(appId).task(focusId!),
    enabled: !!focusId,
    retry: false,
  })
  const focused = focusId ? focus.data : undefined
  const focusRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) focusRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focused])
  const clearFocus = () => {
    const next = new URLSearchParams(params)
    next.delete('task')
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageHeader
        title="Tasks"
        description={
          <span className="flex items-center gap-2">
            Calls, emails and follow-ups assigned to {scope === 'me' ? 'you' : 'the team'}.
            {!!summary.data?.overdue && (
              <Badge variant="destructive" data-testid="overdue-count">
                {summary.data.overdue} overdue
              </Badge>
            )}
          </span>
        }
        actions={
          can('crm.write') && (
            <Button onClick={() => setCreate(true)}>
              <Plus /> New task
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 border-b" role="tablist">
          {TABS.map((x) => (
            <button
              key={x.key}
              type="button"
              role="tab"
              aria-selected={tab === x.key}
              onClick={() => (setTab(x.key), setPage(1))}
              className={cn('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition', tab === x.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              {x.label}
              {scope === 'me' && !!counts[x.key] && (
                <span className={cn('rounded-full px-1.5 text-[11px] tabular-nums', x.key === 'overdue' ? 'bg-danger-soft text-danger-strong' : 'bg-muted text-muted-foreground')}>{counts[x.key]}</span>
              )}
            </button>
          ))}
        </div>
        <div className="ml-auto flex rounded-md border bg-card p-0.5" role="group" aria-label="Assignee">
          {(['me', 'all'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              onClick={() => (setScope(s), setPage(1))}
              className={cn('rounded px-3 py-1 text-xs font-medium', scope === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}
            >
              {s === 'me' ? 'My tasks' : 'Everyone'}
            </button>
          ))}
        </div>
      </div>
      {focusId && (focused || focus.isError) && (
        <div ref={focusRef}>
        <Card className="mb-4 ring-2 ring-primary/40" data-testid="focused-task">
          <div className="flex items-center justify-between px-4 pt-3 text-xs font-medium text-muted-foreground">
            <span>{focused ? 'Task from your notification' : 'That task no longer exists or was reassigned.'}</span>
            <Button variant="ghost" size="sm" onClick={clearFocus}>
              Dismiss
            </Button>
          </div>
          {focused && (
            <ul>
              <TaskRow appId={appId} t={focused} showRelated highlight />
            </ul>
          )}
        </Card>
        </div>
      )}
      <Card>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState
            icon={CheckSquare}
            title={tab === 'done' ? 'Nothing completed yet' : 'All clear'}
            description={tab === 'overdue' ? 'No overdue tasks. Nice.' : tab === 'done' ? undefined : 'Plan your next call, email or follow-up.'}
            action={
              tab !== 'done' && can('crm.write') ? (
                <Button onClick={() => setCreate(true)}>
                  <Plus /> New task
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <ul className="divide-y" data-testid="tasks-list">
              {q.data.items.map((task) => (
                <TaskRow key={task.id} appId={appId} t={task} showRelated />
              ))}
            </ul>
            <Pagination page={page} pageSize={25} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <TaskFormDialog appId={appId} open={create} onOpenChange={setCreate} />
    </>
  )
}
