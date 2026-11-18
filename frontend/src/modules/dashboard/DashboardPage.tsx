import { Link } from 'react-router-dom'
import {
  Activity,
  CheckCircle2,
  Circle,
  Lock,
  Mail,
  MessageSquare,
  PhoneCall,
  Plus,
  Settings,
  UserPlus,
  Users,
  UsersRound,
} from 'lucide-react'
import { useDashboard } from '@/api/queries'
import { ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/misc'
import { useUser } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn, timeAgo } from '@/lib/utils'
import { describeAction } from '@/modules/organizations/auditLabels'
import { StatCard } from '@/components/audience'
import { GrowthChart } from '@/modules/audience/GrowthChart'
import { formatCount } from '@/lib/regions'

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

const CHANNELS = [
  { key: 'audience', label: 'Audience', icon: UsersRound, phase: 'Phase 2', text: 'Contacts, imports, segments and lists' },
  { key: 'email', label: 'Email', icon: Mail, phase: 'Phase 3', text: 'Campaigns, templates and delivery tracking' },
  { key: 'sms', label: 'SMS', icon: MessageSquare, phase: 'Phase 4', text: 'DLT-ready SMS with delivery receipts' },
  { key: 'voice', label: 'Voice', icon: PhoneCall, phase: 'Phase 5', text: 'Voice broadcasts with retries and windows' },
]

export function DashboardPage() {
  const user = useUser()
  const { app, org, can, canOrg } = useWorkspace()
  const q = useDashboard(app!.id)

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name }, { label: 'Overview' }]}
        title={`${greeting()}, ${user.full_name.split(' ')[0]}`}
        description={`Here's what's happening in ${app!.name}.`}
        actions={
          can('settings.read') && (
            <Button variant="outline" asChild>
              <Link to={`/apps/${app!.id}/settings`}>
                <Settings /> Settings
              </Link>
            </Button>
          )
        }
      />
      {q.isLoading ? (
        <Card>
          <LoadingRows rows={6} />
        </Card>
      ) : q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : (
        q.data && (
          <div className="space-y-6">
          {q.data.audience && (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="kpis">
              <StatCard label="Total contacts" value={formatCount(q.data.audience.total, app!.default_country)} icon={UsersRound} hint={`+${formatCount(q.data.audience.new_last_7_days, app!.default_country)} in 7 days`} />
              <StatCard label="Active contacts" value={formatCount(q.data.audience.active, app!.default_country)} icon={Users} tone="success" />
              <StatCard label="Reachable by email" value={formatCount(q.data.audience.reachable.email, app!.default_country)} icon={Mail} hint="Consented and not suppressed" />
              <StatCard label="Reachable by SMS" value={formatCount(q.data.audience.reachable.sms, app!.default_country)} icon={MessageSquare} hint="Consented and not suppressed" />
            </div>
          )}
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              {q.data.audience && q.data.audience.total > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Audience growth</CardTitle>
                    <CardDescription>Total contacts over the last 30 days.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <GrowthChart data={q.data.audience.growth} country={app!.default_country} height={180} />
                  </CardContent>
                </Card>
              )}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Getting started</CardTitle>
                    <span className="text-xs font-medium text-muted-foreground">
                      {q.data.checklist.filter((c) => c.done).length} of {q.data.checklist.length} complete
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${(q.data.checklist.filter((c) => c.done).length / q.data.checklist.length) * 100}%` }}
                    />
                  </div>
                </CardHeader>
                <CardContent className="p-2 pt-0">
                  <ul>
                    {q.data.checklist.map((item) => {
                      const locked = item.available === false && !item.done
                      return (
                        <li key={item.key} className="flex items-center gap-3 rounded-md px-3 py-2.5">
                          {item.done ? (
                            <CheckCircle2 className="size-5 text-success-strong" />
                          ) : locked ? (
                            <Lock className="size-4 text-muted-foreground/60" />
                          ) : (
                            <Circle className="size-5 text-muted-foreground/40" />
                          )}
                          <span className={cn('flex-1 text-sm', item.done && 'text-muted-foreground line-through')}>{item.label}</span>
                          {!item.done && item.key === 'invite_team' && item.available !== false && org && (
                            <Button size="sm" variant="outline" asChild>
                              <Link to={`/orgs/${org.id}/team?invite=1`}>Invite</Link>
                            </Button>
                          )}
                          {!item.done && item.key === 'import_contacts' && item.available !== false && (
                            <Button size="sm" variant="outline" asChild>
                              <Link to={`/apps/${app!.id}/audience/import`}>Import</Link>
                            </Button>
                          )}
                          {!item.done && item.key === 'create_segment' && item.available !== false && (
                            <Button size="sm" variant="outline" asChild>
                              <Link to={`/apps/${app!.id}/audience/segments/new`}>Create</Link>
                            </Button>
                          )}
                          {locked && item.module && <Badge variant="secondary">Coming soon</Badge>}
                        </li>
                      )
                    })}
                  </ul>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Channels</CardTitle>
                  <CardDescription>
                    Metrics appear here from real campaign records as each module is enabled. Nothing is sent while the
                    platform is in simulation mode.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-2">
                  {CHANNELS.map((c) => (
                    <div key={c.key} className="flex items-start gap-3 rounded-lg border bg-muted/30 p-4">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-card text-primary shadow-card">
                        <c.icon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{c.label}</span>
                          {q.data.modules[c.key] ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">{c.phase}</Badge>}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{c.text}</p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Team</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-3 gap-3 text-center">
                    {[
                      { label: 'With access', value: q.data.team.with_access },
                      { label: 'In org', value: q.data.team.organization_members },
                      { label: 'Invited', value: q.data.team.pending_invitations },
                    ].map((s) => (
                      <div key={s.label} className="rounded-lg bg-muted/50 py-3">
                        <dd className="text-xl font-semibold tabular-nums">{s.value}</dd>
                        <dt className="text-[11px] text-muted-foreground">{s.label}</dt>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-4 flex flex-col gap-2">
                    {canOrg('members.invite') && org && (
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`/orgs/${org.id}/team?invite=1`}>
                          <UserPlus /> Invite teammate
                        </Link>
                      </Button>
                    )}
                    {canOrg('members.read') && org && (
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/orgs/${org.id}/team`}>
                          <Users /> Manage team
                        </Link>
                      </Button>
                    )}
                    {canOrg('apps.create') && org && (
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/onboarding/application?org=${org.id}`}>
                          <Plus /> New application
                        </Link>
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Recent activity</CardTitle>
                </CardHeader>
                <CardContent>
                  {q.data.recent_activity.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">No activity yet.</p>
                  ) : (
                    <ol className="relative space-y-4 border-l pl-5">
                      {q.data.recent_activity.map((a) => (
                        <li key={a.id} className="relative">
                          <span className="absolute -left-[25px] top-1 flex size-2.5 rounded-full bg-primary/70 ring-4 ring-card" />
                          <p className="text-sm">
                            <span className="font-medium">{a.actor_name ?? 'System'}</span>{' '}
                            <span className="text-muted-foreground">{describeAction(a.action)}</span>
                          </p>
                          {a.summary && <p className="truncate text-xs text-muted-foreground">{a.summary}</p>}
                          <p className="text-[11px] text-muted-foreground">{timeAgo(a.created_at)}</p>
                        </li>
                      ))}
                    </ol>
                  )}
                  {canOrg('audit.read') && org && (
                    <Button variant="link" size="sm" className="mt-2 px-0" asChild>
                      <Link to={`/orgs/${org.id}/audit-log`}>
                        <Activity /> View audit log
                      </Link>
                    </Button>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
          </div>
        )
      )}
    </>
  )
}
