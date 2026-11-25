import { lazy, Suspense, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Circle,
  EyeOff,
  ListChecks,
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
import { useBilling } from '@/api/billing'
import { formatMoney } from '@/modules/sms/format'
import { ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/misc'
import { useUser } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn, timeAgo } from '@/lib/utils'
import { describeAction } from '@/modules/organizations/auditLabels'
import { StatCard } from '@/components/audience'
// The chart library (recharts, ~420 kB) loads after the dashboard itself has rendered.
const GrowthChart = lazy(() => import('@/modules/audience/GrowthChart').then((m) => ({ default: m.GrowthChart })))
import { formatCount } from '@/lib/regions'
import type { ChecklistItem, DashboardData } from '@/types/api'
import { CHECKLIST_ANCHOR, setChecklistHidden, useChecklistHidden } from './checklistState'

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

const CHANNELS = [
  { key: 'audience', label: 'Audience', icon: UsersRound, path: 'audience', unit: 'contacts added', text: 'Contacts, imports, segments and lists' },
  { key: 'email', label: 'Email', icon: Mail, path: 'email', unit: 'emails', text: 'Campaigns, templates and delivery tracking' },
  { key: 'sms', label: 'SMS', icon: MessageSquare, path: 'sms', unit: 'texts', text: 'DLT-ready SMS with delivery receipts' },
  { key: 'voice', label: 'Voice', icon: PhoneCall, path: 'voice', unit: 'calls', text: 'Voice broadcasts with retries and windows' },
] as const

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const blocked = !item.done && !item.available
  return (
    <li className="flex items-center gap-3 rounded-md px-3 py-2.5" data-testid={`checklist-${item.key}`}>
      {item.done ? (
        <CheckCircle2 className="size-5 shrink-0 text-success-strong" />
      ) : blocked ? (
        <Lock className="size-4 shrink-0 text-muted-foreground/60" />
      ) : (
        <Circle className="size-5 shrink-0 text-muted-foreground/40" />
      )}
      <div className="min-w-0 flex-1">
        <span className={cn('text-sm', item.done && 'text-muted-foreground line-through')}>{item.label}</span>
        {item.optional && !item.done && <span className="ml-1.5 text-xs text-muted-foreground">(optional)</span>}
        {item.detail && !item.done && <p className="text-xs text-muted-foreground">{item.detail}</p>}
      </div>
      {!item.done &&
        (blocked ? (
          <span className="shrink-0 text-xs text-muted-foreground">Ask an admin</span>
        ) : (
          <Button size="sm" variant="outline" className="shrink-0" asChild>
            <Link to={item.href}>{item.cta}</Link>
          </Button>
        ))}
    </li>
  )
}

function GettingStarted({ appId, items }: { appId: string; items: ChecklistItem[] }) {
  const done = items.filter((c) => c.done).length
  return (
    <Card id={CHECKLIST_ANCHOR} className="scroll-mt-20" data-testid="getting-started">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Getting started</CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {done} of {items.length} complete
            </span>
            <Button variant="ghost" size="sm" onClick={() => setChecklistHidden(appId, true)} data-testid="hide-checklist">
              <EyeOff /> Hide
            </Button>
          </div>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(done / Math.max(items.length, 1)) * 100}%` }} />
        </div>
      </CardHeader>
      <CardContent className="p-2 pt-0">
        {done === items.length ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">Everything is set up. Nice work.</p>
        ) : (
          <ul>
            {items.map((item) => (
              <ChecklistRow key={item.key} item={item} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function Channels({ appId, data, country }: { appId: string; data: DashboardData; country: string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your channels at a glance</CardTitle>
        <CardDescription>Last 30 days. Open a channel to see its campaigns and reports.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        {CHANNELS.map((c) => {
          const ch = data.channels[c.key]
          // SMS is coming soon in every market: a plain card, nothing to click into.
          if (c.key === 'sms' || ch.coming_soon)
            return (
              <div key={c.key} className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/20 p-4" data-testid={`channel-${c.key}`}>
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-card text-muted-foreground shadow-card">
                  <c.icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-muted-foreground">{c.label}</span>
                    <Badge variant="secondary">Coming soon</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">Text messaging with carrier registration built in is on its way.</p>
                </div>
              </div>
            )
          return (
            <div key={c.key} className="relative rounded-lg border bg-muted/30 transition-colors hover:border-primary/40 hover:bg-muted/50" data-testid={`channel-${c.key}`}>
              <Link to={`/apps/${appId}/${c.path}`} className="flex items-start gap-3 p-4 pb-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-card text-primary shadow-card">
                  <c.icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{c.label}</span>
                    {ch.ready ? <Badge variant="success">Ready</Badge> : <Badge variant="secondary">Setup needed</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{c.text}</p>
                  <p className="mt-2 text-lg font-semibold tabular-nums">
                    {formatCount(ch.count_30d, country)} <span className="text-xs font-normal text-muted-foreground">{c.unit}</span>
                  </p>
                </div>
              </Link>
              {!ch.ready && (
                <Link to={ch.setup_href} className="mx-4 mb-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  Finish setup <ArrowRight className="size-3" />
                </Link>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

const CHANNEL_NAMES: Record<string, string> = { email: 'Email', sms: 'SMS', voice: 'Voice' }

/** This application's spend this month, with a link to the one Billing page (filtered to this app). */
function UsageCard() {
  const { app, org, canOrg } = useWorkspace()
  const q = useBilling({ kind: 'app', id: app!.id, orgId: app!.organization_id })
  const s = q.data
  return (
    <Card data-testid="usage-card">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <CardTitle>Usage this month</CardTitle>
          <CardDescription>Paid from the {org?.name ?? 'organization'} wallet.</CardDescription>
        </div>
        {org && canOrg('billing.read') && (
          <Button variant="link" size="sm" asChild>
            <Link to={`/orgs/${org.id}/billing?app=${app!.id}`}>Open billing</Link>
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {q.isLoading || !s ? (
          <div className="h-16 animate-pulse rounded-md bg-muted" />
        ) : (
          <>
            <div className="text-2xl font-semibold tabular-nums">{formatMoney(s.month_usage.total, s.currency)}</div>
            {Object.keys(s.month_usage.by_channel).length > 0 ? (
              <div className="space-y-1">
                {Object.entries(s.month_usage.by_channel).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 text-muted-foreground">
                    <span>{CHANNEL_NAMES[k] ?? k}</span>
                    <span className="tabular-nums">{formatMoney(v, s.currency)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">Nothing charged yet this month.</p>
            )}
            <div className={cn('flex justify-between gap-2 border-t pt-3', s.low && 'text-danger-strong')}>
              <span>Wallet available</span>
              <span className="font-medium tabular-nums">{formatMoney(s.available, s.currency)}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function DashboardPage() {
  const user = useUser()
  const { app, org, can, canOrg } = useWorkspace()
  const q = useDashboard(app!.id)
  const hidden = useChecklistHidden(app!.id)
  const incomplete = !!q.data && q.data.checklist.some((c) => !c.done)
  const { hash } = useLocation()
  // The sidebar's "Setup x/y" pill links to #getting-started.
  useEffect(() => {
    if (hash === `#${CHECKLIST_ANCHOR}` && q.data) {
      const t = setTimeout(() => document.getElementById(CHECKLIST_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
      return () => clearTimeout(t)
    }
  }, [hash, q.data])

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name }, { label: 'Overview' }]}
        title={`${greeting()}, ${user.full_name.split(' ')[0]}`}
        description={`Here's what's happening in ${app!.name}.`}
        actions={
          <div className="flex flex-wrap gap-2">
            {hidden && incomplete && (
              <Button variant="ghost" onClick={() => setChecklistHidden(app!.id, false)} data-testid="show-checklist">
                <ListChecks /> Show setup checklist
              </Button>
            )}
            {can('settings.read') && (
              <Button variant="outline" asChild>
                <Link to={`/apps/${app!.id}/settings`}>
                  <Settings /> Settings
                </Link>
              </Button>
            )}
          </div>
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
                <StatCard label="Reachable by calls" value={formatCount(q.data.audience.reachable.voice ?? 0, app!.default_country)} icon={PhoneCall} hint="Consented and not suppressed" />
              </div>
            )}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="min-w-0 space-y-6 lg:col-span-2">
                {!hidden && <GettingStarted appId={app!.id} items={q.data.checklist} />}
                {q.data.audience && q.data.audience.total > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Audience growth</CardTitle>
                      <CardDescription>Total contacts over the last 30 days.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Suspense fallback={<div className="h-[180px] animate-pulse rounded-md bg-muted" />}>
                        <GrowthChart data={q.data.audience.growth} country={app!.default_country} height={180} />
                      </Suspense>
                    </CardContent>
                  </Card>
                )}
                <Channels appId={app!.id} data={q.data} country={app!.default_country} />
              </div>

              <div className="min-w-0 space-y-6">
                {can('billing.read') && <UsageCard />}
                <Card>
                  <CardHeader>
                    <CardTitle>Team</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl className="grid grid-cols-3 gap-3 text-center">
                      {[
                        { label: 'Can open this app', value: q.data.team.with_access },
                        { label: 'In org', value: q.data.team.organization_members },
                        { label: 'Invited', value: q.data.team.pending_invitations },
                      ].map((s) => (
                        <div key={s.label} className="rounded-lg bg-muted/50 px-1 py-3">
                          <dd className="text-xl font-semibold tabular-nums">{s.value}</dd>
                          <dt className="text-[11px] leading-tight text-muted-foreground">{s.label}</dt>
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
                      <ol className="relative space-y-4 border-l pl-5" data-testid="recent-activity">
                        {q.data.recent_activity.map((a) => (
                          <li key={a.id} className="relative min-w-0">
                            <span className="absolute -left-[25px] top-1 flex size-2.5 rounded-full bg-primary/70 ring-4 ring-card" />
                            <p className="text-sm">
                              <span className="font-medium">{a.actor_name ?? 'System'}</span>{' '}
                              <span className="text-muted-foreground">{describeAction(a.action)}</span>
                            </p>
                            {a.summary &&
                              (a.href ? (
                                <Link to={a.href} className="block truncate text-xs text-primary hover:underline">
                                  {a.summary}
                                </Link>
                              ) : (
                                <p className="truncate text-xs text-muted-foreground">{a.summary}</p>
                              ))}
                            {!a.summary && a.href && (
                              <Link to={a.href} className="block text-xs text-primary hover:underline">
                                View
                              </Link>
                            )}
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
