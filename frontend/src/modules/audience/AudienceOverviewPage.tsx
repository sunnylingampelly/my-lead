import { Link } from 'react-router-dom'
import { FileSpreadsheet, Filter, ShieldCheck, Upload, UserCheck, UserPlus, Users } from 'lucide-react'
import { useAudienceOverview } from '@/api/audience'
import { ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/misc'
import { CHANNEL_META, StatCard } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { countryFlag, countryName, formatCount } from '@/lib/regions'
import { timeAgo } from '@/lib/utils'
import type { Channel } from '@/types/audience'
import { GrowthChart } from './GrowthChart'

export function AudienceOverviewPage() {
  const { app, org, can } = useWorkspace()
  const base = `/apps/${app!.id}/audience`
  const q = useAudienceOverview(app!.id)
  const f = (n: number) => formatCount(n, app!.default_country)

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${app!.id}` }, { label: 'Audience' }]}
        title="Audience"
        description="Everyone this application can reach, and on which channels they have agreed to hear from you."
        actions={
          can('audience.write') && (
            <>
              <Button variant="outline" asChild>
                <Link to={`${base}/segments/new`}>
                  <Filter /> New segment
                </Link>
              </Button>
              <Button asChild>
                <Link to={`${base}/import`}>
                  <Upload /> Import contacts
                </Link>
              </Button>
            </>
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
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard label="Total contacts" value={f(q.data.total)} icon={Users} hint={`${f(q.data.new_last_7_days)} added in the last 7 days`} />
              <StatCard label="Active" value={f(q.data.active)} icon={UserCheck} tone="success" hint={`${f(q.data.unsubscribed)} unsubscribed from everything`} />
              <StatCard label="With email" value={f(q.data.with_email)} icon={CHANNEL_META.email.icon} hint={`${f(q.data.consent.email)} gave email consent`} />
              <StatCard label="With phone" value={f(q.data.with_phone)} icon={CHANNEL_META.sms.icon} hint={`${f(q.data.consent.sms)} gave SMS consent`} />
            </div>

            <div className="grid gap-6 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle>Audience growth</CardTitle>
                  <CardDescription>Total contacts over the last 30 days (UTC).</CardDescription>
                </CardHeader>
                <CardContent>
                  <GrowthChart data={q.data.growth} country={app!.default_country} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ShieldCheck className="size-4 text-primary" /> Reachable for marketing
                  </CardTitle>
                  <CardDescription>Consented, not unsubscribed and not suppressed.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(['email', 'sms', 'voice'] as Channel[]).map((ch) => {
                    const n = q.data.reachable[ch]
                    const pct = q.data.total ? Math.round((n / q.data.total) * 100) : 0
                    const Icon = CHANNEL_META[ch].icon
                    return (
                      <div key={ch} data-testid={`reachable-${ch}`}>
                        <div className="flex items-center justify-between text-sm">
                          <span className="flex items-center gap-2">
                            <Icon className="size-4 text-muted-foreground" /> {CHANNEL_META[ch].label}
                          </span>
                          <span className="tabular-nums">
                            <span className="font-semibold">{f(n)}</span> <span className="text-xs text-muted-foreground">({pct}%)</span>
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                  {q.data.total > 0 && q.data.reachable.email + q.data.reachable.sms + q.data.reachable.voice === 0 && (
                    <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
                      Nobody has recorded marketing consent yet. Confirm consent during import or on each contact.
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-6 lg:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle>Where contacts are</CardTitle>
                  <CardDescription>By phone country, or address country when there's no phone.</CardDescription>
                </CardHeader>
                <CardContent>
                  {q.data.countries.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No contacts yet.</p>
                  ) : (
                    <ul className="space-y-2.5">
                      {q.data.countries.map((c) => (
                        <li key={c.country}>
                          <div className="flex justify-between text-sm">
                            <span>
                              {countryFlag(c.country)} {countryName(c.country)}
                            </span>
                            <span className="tabular-nums text-muted-foreground">{f(c.count)}</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-primary/70" style={{ width: `${(c.count / q.data.total) * 100}%` }} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card className="lg:col-span-2">
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>Recent imports</CardTitle>
                  <Button variant="link" size="sm" asChild>
                    <Link to={`${base}/import`}>All imports</Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  {q.data.recent_imports.length === 0 ? (
                    <div className="flex flex-col items-center py-6 text-center text-sm text-muted-foreground">
                      <FileSpreadsheet className="mb-2 size-6" />
                      No imports yet.
                      {can('audience.write') && (
                        <Button variant="outline" size="sm" className="mt-3" asChild>
                          <Link to={`${base}/contacts`}>
                            <UserPlus /> Add a contact manually
                          </Link>
                        </Button>
                      )}
                    </div>
                  ) : (
                    <ul className="divide-y">
                      {q.data.recent_imports.map((i) => (
                        <li key={i.id} className="flex items-center gap-3 py-2.5 text-sm">
                          <FileSpreadsheet className="size-4 text-muted-foreground" />
                          <Link to={`${base}/import/${i.id}`} className="min-w-0 flex-1 truncate font-medium hover:text-primary">
                            {i.file_name}
                          </Link>
                          <span className="tabular-nums text-muted-foreground">
                            {f(i.created_count)} new · {f(i.updated_count)} updated
                          </span>
                          <Badge variant={i.status === 'completed' ? 'success' : i.status === 'failed' ? 'destructive' : 'secondary'} className="capitalize">
                            {i.status === 'uploaded' ? 'Not started' : i.status}
                          </Badge>
                          <span className="hidden w-24 text-right text-xs text-muted-foreground sm:block">{timeAgo(i.created_at)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )
      )}
    </>
  )
}
