import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowRight, LayoutGrid, Plus } from 'lucide-react'
import { useApplications } from '@/api/queries'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/misc'
import { useWorkspace } from '@/hooks/useWorkspace'
import { APP_COLORS, cn, formatDate } from '@/lib/utils'

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  application_manager: 'App manager',
  campaign_manager: 'Campaign manager',
  analyst: 'Analyst',
  viewer: 'Viewer',
  platform_support: 'Support (read-only)',
}

export function ApplicationsPage() {
  const { orgId } = useParams()
  const navigate = useNavigate()
  const { org, canOrg } = useWorkspace()
  const q = useApplications(orgId)
  const newAction = canOrg('apps.create') && (
    <Button onClick={() => navigate(`/onboarding/application?org=${orgId}`)}>
      <Plus /> New application
    </Button>
  )

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? 'Organization' }, { label: 'Applications' }]}
        title="Applications"
        description="Each application is an isolated workspace with its own audience, campaigns and settings."
        actions={newAction}
      />
      {q.isLoading ? (
        <Card>
          <LoadingRows />
        </Card>
      ) : q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : q.data?.length === 0 ? (
        <Card>
          <EmptyState
            icon={LayoutGrid}
            title="No applications you can access"
            description={canOrg('apps.create') ? 'Create one to start building an audience.' : 'Ask an admin to give you access to an application.'}
            action={newAction}
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {q.data?.map((a) => (
            <Link
              key={a.id}
              to={`/apps/${a.id}`}
              className="group rounded-lg border bg-card p-5 shadow-card transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-pop"
            >
              <div className="flex items-start gap-3">
                <div className={cn('flex size-10 items-center justify-center rounded-lg text-sm font-semibold text-white', APP_COLORS[a.color] ?? 'bg-indigo-500')}>
                  {a.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{a.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{a.timezone}</div>
                </div>
                <Badge variant="secondary">{ROLE_LABEL[a.role] ?? a.role}</Badge>
              </div>
              <p className="mt-4 line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">{a.description || 'No description'}</p>
              <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                <span>Created {formatDate(a.created_at)}</span>
                <span className="flex items-center gap-1 font-medium text-primary opacity-0 transition group-hover:opacity-100">
                  Open <ArrowRight className="size-3.5" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
