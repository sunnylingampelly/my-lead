/** Email overview, campaigns list, templates and senders. */
import { lazy, Suspense, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  Clock,
  Copy,
  FileText,
  Globe,
  LayoutTemplate,
  Mail,
  MailCheck,
  MoreHorizontal,
  MousePointerClick,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Send,
  Star,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { emailApi, eqk, useCampaigns, useEmailOverview, useSenders, useTemplates } from '@/api/email'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Pagination, StatCard } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import { cn, formatDate, formatDateTime, timeAgo } from '@/lib/utils'
import type { CampaignListItem, EmailTemplate, Sender } from '@/types/email'
import { NewCampaignButton } from './CampaignEditorPage'
import { CampaignStatusBadge, HtmlEditor, pct, VariablePicker } from './components'
import { STARTERS } from './starters'

const VisualEditor = lazy(() => import('./VisualEditor').then((m) => ({ default: m.VisualEditor })))

function useCrumbs(label: string) {
  const { app, org } = useWorkspace()
  return [{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${app!.id}` }, { label: 'Email', to: `/apps/${app!.id}/email` }, { label }]
}

const rate = (n: number, d: number) => (d ? (100 * n) / d : null)

// ------------------------------------------------------------------ overview

export function EmailOverviewPage() {
  const { app, can } = useWorkspace()
  const q = useEmailOverview(app!.id)
  const senders = useSenders(app!.id)
  const f = (n: number) => formatCount(n, app!.default_country)
  const base = `/apps/${app!.id}/email`
  const noVerified = senders.data && !senders.data.some((s) => s.status === 'verified')
  return (
    <>
      <PageHeader
        breadcrumbs={useCrumbs('Overview')}
        title="Email"
        description="Campaign performance over the last 30 days, from real delivery and engagement records."
        actions={can('campaigns.write') && <NewCampaignButton />}
      />
      {noVerified && can('settings.write') && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-warning-border bg-warning-soft px-4 py-3 text-sm text-warning-strong">
          <TriangleAlert className="size-4" />
          <span className="flex-1">You need a verified sender address before you can send.</span>
          <Button size="sm" variant="outline" asChild>
            <Link to={`${base}/senders`}>Add a sender</Link>
          </Button>
        </div>
      )}
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        q.data && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <StatCard label="Campaigns sent" value={f(q.data.last_30_days.campaigns)} icon={Send} hint="Last 30 days" />
              <StatCard label="Emails sent" value={f(q.data.last_30_days.sent)} icon={Mail} hint="Accepted by the provider" />
              <StatCard label="Delivery rate" value={pct(q.data.last_30_days.delivery_rate)} icon={MailCheck} tone="success" hint={`${f(q.data.last_30_days.delivered)} delivered`} />
              <StatCard label="Open rate" value={pct(q.data.last_30_days.open_rate)} icon={BadgeCheck} hint="Unique opens ÷ delivered" />
              <StatCard label="Click rate" value={pct(q.data.last_30_days.click_rate)} icon={MousePointerClick} hint="Unique clicks ÷ delivered" />
            </div>
            <div className="grid gap-6 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>Recent campaigns</CardTitle>
                  <Button variant="link" size="sm" asChild>
                    <Link to={`${base}/campaigns`}>All campaigns</Link>
                  </Button>
                </CardHeader>
                {q.data.recent.length === 0 ? (
                  <EmptyState icon={Send} title="No campaigns yet" description="Create your first campaign and send it to a segment." action={can('campaigns.write') && <NewCampaignButton variant="outline" />} />
                ) : (
                  <ul className="divide-y border-t">
                    {q.data.recent.map((c) => (
                      <li key={c.id}>
                        <Link to={c.status === 'draft' ? `${base}/campaigns/${c.id}/edit` : `${base}/campaigns/${c.id}`} className="flex items-center gap-4 px-5 py-3 transition hover:bg-muted/40">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{c.name}</div>
                            <div className="truncate text-xs text-muted-foreground">{c.subject ?? 'No subject yet'}</div>
                          </div>
                          {c.stats && c.stats.sent > 0 && (
                            <div className="hidden text-right text-xs sm:block">
                              <div className="tabular-nums">{pct(rate(c.stats.unique_opens, c.stats.delivered))} opened</div>
                              <div className="tabular-nums text-muted-foreground">{f(c.stats.sent)} sent</div>
                            </div>
                          )}
                          <CampaignStatusBadge status={c.status} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <CalendarClock className="size-4" /> Upcoming
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {q.data.upcoming.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Nothing scheduled.</p>
                    ) : (
                      <ul className="space-y-3">
                        {q.data.upcoming.map((c) => (
                          <li key={c.id}>
                            <Link className="text-sm font-medium hover:text-primary" to={`${base}/campaigns/${c.id}`}>
                              {c.name}
                            </Link>
                            <div className="text-xs text-muted-foreground">{c.scheduled_at && formatDateTime(c.scheduled_at)}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Shortcuts</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-2">
                    <Button variant="outline" className="justify-start" asChild>
                      <Link to={`${base}/templates`}>
                        <LayoutTemplate /> Templates
                      </Link>
                    </Button>
                    <Button variant="outline" className="justify-start" asChild>
                      <Link to={`${base}/senders`}>
                        <BadgeCheck /> Senders ({q.data.senders.verified ?? 0} verified)
                      </Link>
                    </Button>
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

// ------------------------------------------------------------------ campaigns list

const TABS = [
  ['', 'All'],
  ['draft', 'Drafts'],
  ['scheduled', 'Scheduled'],
  ['sending', 'Sending'],
  ['completed', 'Sent'],
] as const

export function CampaignsPage() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  const [del, setDel] = useState<CampaignListItem | null>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])
  const q = useCampaigns(appId, { page, page_size: 20, status: status || undefined, search: debounced || undefined })
  const f = (n: number) => formatCount(n, app!.default_country)
  const base = `/apps/${appId}/email/campaigns`
  const open = (c: CampaignListItem) => navigate(c.status === 'draft' ? `${base}/${c.id}/edit` : `${base}/${c.id}`)

  return (
    <>
      <PageHeader breadcrumbs={useCrumbs('Campaigns')} title="Email campaigns" description="Drafts, scheduled sends and results." actions={can('campaigns.write') && <NewCampaignButton />} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="flex gap-1">
            {TABS.map(([k, label]) => (
              <button
                key={k}
                onClick={() => {
                  setStatus(k)
                  setPage(1)
                }}
                className={cn('rounded-full px-3 py-1.5 text-xs font-medium transition', status === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search campaigns" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search campaigns" data-page-search />
          </div>
        </div>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState icon={Send} title={debounced || status ? 'No campaigns match' : 'No campaigns yet'} description="Campaigns you create appear here with their results." action={can('campaigns.write') && !debounced && !status && <NewCampaignButton variant="outline" />} />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Campaign</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Recipients</TH>
                  <TH className="text-right">Delivered</TH>
                  <TH className="text-right">Opened</TH>
                  <TH className="text-right">Clicked</TH>
                  <TH>Date</TH>
                  <TH className="w-10" />
                </TR>
              </THead>
              <TBody>
                {q.data.items.map((c) => {
                  const s = c.stats
                  return (
                    <TR key={c.id} className="cursor-pointer" onClick={() => open(c)}>
                      <TD>
                        <div className="font-medium">{c.name}</div>
                        <div className="max-w-xs truncate text-xs text-muted-foreground">{c.subject ?? 'No subject yet'}</div>
                      </TD>
                      <TD>
                        <CampaignStatusBadge status={c.status} />
                      </TD>
                      <TD className="text-right tabular-nums">{c.recipient_count ? f(c.recipient_count) : '—'}</TD>
                      <TD className="text-right tabular-nums">{s?.sent ? pct(rate(s.delivered, s.sent)) : '—'}</TD>
                      <TD className="text-right tabular-nums">{s?.delivered ? pct(rate(s.unique_opens, s.delivered)) : '—'}</TD>
                      <TD className="text-right tabular-nums">{s?.delivered ? pct(rate(s.unique_clicks, s.delivered)) : '—'}</TD>
                      <TD className="whitespace-nowrap text-muted-foreground">
                        {c.status === 'scheduled' && c.scheduled_at ? (
                          <span className="flex items-center gap-1">
                            <Clock className="size-3.5" /> {formatDateTime(c.scheduled_at)}
                          </span>
                        ) : c.launched_at ? (
                          formatDate(c.launched_at)
                        ) : (
                          `Edited ${timeAgo(c.updated_at)}`
                        )}
                      </TD>
                      <TD onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`Actions for ${c.name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => open(c)}>{c.status === 'draft' ? <Pencil /> : <FileText />} {c.status === 'draft' ? 'Edit' : 'View report'}</DropdownMenuItem>
                            {can('campaigns.write') && (
                              <DropdownMenuItem
                                onSelect={async () => {
                                  try {
                                    const d = await emailApi(appId).duplicateCampaign(c.id)
                                    navigate(`${base}/${d.id}/edit`)
                                  } catch (e) {
                                    toast.error(errorMessage(e))
                                  }
                                }}
                              >
                                <Copy /> Duplicate
                              </DropdownMenuItem>
                            )}
                            {c.status === 'draft' && can('campaigns.write') && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem destructive onSelect={() => setDel(c)}>
                                  <Trash2 /> Delete draft
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TD>
                    </TR>
                  )
                })}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={20} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete “${del?.name}”?`}
        description="This draft will be removed permanently."
        confirmLabel="Delete draft"
        destructive
        onConfirm={async () => {
          try {
            await emailApi(appId).deleteCampaign(del!.id)
            await qc.invalidateQueries({ queryKey: eqk.all(appId) })
            toast.success('Draft deleted')
          } catch (e) {
            toast.error(errorMessage(e))
          }
          setDel(null)
        }}
      />
    </>
  )
}

// ------------------------------------------------------------------ templates

function Thumb({ html }: { html: string | null }) {
  return (
    <div className="pointer-events-none h-48 overflow-hidden border-b bg-muted">
      {html ? (
        <iframe title="Template thumbnail" srcDoc={html} sandbox="" tabIndex={-1} className="h-[640px] w-[640px] origin-top-left scale-[0.45] border-0 bg-white" />
      ) : (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <FileText className="size-8" />
        </div>
      )}
    </div>
  )
}

export function TemplatesPage() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const q = useTemplates(appId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [del, setDel] = useState<EmailTemplate | null>(null)
  const create = async (starter: (typeof STARTERS)[number]) => {
    try {
      const t = await emailApi(appId).createTemplate({ name: starter.key === 'blank' ? 'Untitled template' : starter.name, subject: starter.subject || null, preheader: starter.preheader || null, editor: 'visual', html: starter.html })
      await qc.invalidateQueries({ queryKey: eqk.templates(appId) })
      navigate(`/apps/${appId}/email/templates/${t.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <>
      <PageHeader
        breadcrumbs={useCrumbs('Templates')}
        title="Email templates"
        description="Reusable designs. Campaigns copy a template, so editing a template never changes a sent email."
        actions={
          can('campaigns.write') && (
            <Button onClick={() => setCreating(true)}>
              <Plus /> New template
            </Button>
          )
        }
      />
      {q.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      ) : !q.data?.length ? (
        <Card>
          <EmptyState icon={LayoutTemplate} title="No templates yet" description="Save a design here to reuse it across campaigns." action={can('campaigns.write') && <Button variant="outline" onClick={() => setCreating(true)}><Plus /> New template</Button>} />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {q.data.map((t) => (
            <div key={t.id} className="group overflow-hidden rounded-lg border bg-card shadow-card transition hover:-translate-y-0.5 hover:border-primary/40">
              <Link to={`/apps/${appId}/email/templates/${t.id}`}>
                <Thumb html={t.html} />
              </Link>
              <div className="flex items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <Link to={`/apps/${appId}/email/templates/${t.id}`} className="block truncate text-sm font-medium hover:text-primary">
                    {t.name}
                  </Link>
                  <div className="truncate text-xs text-muted-foreground">Edited {timeAgo(t.updated_at)}</div>
                </div>
                {can('campaigns.write') && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`Actions for ${t.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={async () => {
                          const c = await emailApi(appId).createCampaign({ name: t.name, template_id: t.id })
                          navigate(`/apps/${appId}/email/campaigns/${c.id}/edit?step=setup`)
                        }}
                      >
                        <Send /> Use in a campaign
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={async () => {
                          await emailApi(appId).duplicateTemplate(t.id)
                          await qc.invalidateQueries({ queryKey: eqk.templates(appId) })
                        }}
                      >
                        <Copy /> Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive onSelect={() => setDel(t)}>
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>New template</DialogTitle>
            <DialogDescription>Choose a starting layout.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STARTERS.map((s) => (
              <button key={s.key} onClick={() => create(s)} className="overflow-hidden rounded-lg border text-left transition hover:border-primary">
                <Thumb html={s.html} />
                <div className="p-3">
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="text-xs text-muted-foreground">{s.description}</div>
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete “${del?.name}”?`}
        description="Campaigns that used this template keep their own copy."
        confirmLabel="Delete template"
        destructive
        onConfirm={async () => {
          await emailApi(appId).deleteTemplate(del!.id).catch((e) => toast.error(errorMessage(e)))
          await qc.invalidateQueries({ queryKey: eqk.templates(appId) })
          setDel(null)
        }}
      />
    </>
  )
}

export function TemplateEditorPage() {
  const { templateId } = useParams()
  const { app, can } = useWorkspace()
  const appId = app!.id
  const qc = useQueryClient()
  const q = useQuery({ queryKey: eqk.template(appId, templateId!), queryFn: () => emailApi(appId).template(templateId!) })
  const [t, setT] = useState<Partial<EmailTemplate>>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (q.data) setT(q.data)
  }, [q.data])
  const crumbs = useCrumbs('Templates')
  if (q.isLoading) return <Skeleton className="h-[70vh] w-full" />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const save = async () => {
    setSaving(true)
    try {
      await emailApi(appId).updateTemplate(templateId!, { name: t.name, subject: t.subject, preheader: t.preheader, editor: t.editor, design: t.design, html: t.html, text: t.text })
      await qc.invalidateQueries({ queryKey: eqk.templates(appId) })
      toast.success('Template saved')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <PageHeader
        breadcrumbs={[...crumbs.slice(0, 3), { label: 'Templates', to: `/apps/${appId}/email/templates` }, { label: t.name ?? '' }]}
        title={t.name || 'Template'}
        actions={
          can('campaigns.write') && (
            <Button onClick={save} loading={saving}>
              Save template
            </Button>
          )
        }
      />
      <div className="mb-4 grid gap-4 md:grid-cols-3">
        <Field label="Name" htmlFor="t-name">
          <Input id="t-name" value={t.name ?? ''} onChange={(e) => setT({ ...t, name: e.target.value })} />
        </Field>
        <Field label="Default subject" htmlFor="t-sub" action={<VariablePicker appId={appId} onInsert={(tok) => setT({ ...t, subject: (t.subject ?? '') + tok })} label="Field" />}>
          <Input id="t-sub" value={t.subject ?? ''} onChange={(e) => setT({ ...t, subject: e.target.value })} />
        </Field>
        <Field label="Preview text" htmlFor="t-pre">
          <Input id="t-pre" value={t.preheader ?? ''} onChange={(e) => setT({ ...t, preheader: e.target.value })} />
        </Field>
      </div>
      {q.data!.editor === 'html' ? (
        <HtmlEditor appId={appId} value={t.html ?? ''} onChange={(v) => setT((p) => ({ ...p, html: v }))} />
      ) : (
        <div className="h-[calc(100vh-17rem)] min-h-[620px]">
          <Suspense fallback={<Skeleton className="h-full w-full" />}>
            <VisualEditor initialDesign={q.data!.design} initialHtml={q.data!.html} onChange={(v) => setT((p) => ({ ...p, design: v.design, html: v.html }))} />
          </Suspense>
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------------ senders

function SenderRow({ s }: { s: Sender }) {
  const { app, can } = useWorkspace()
  const qc = useQueryClient()
  const tips = useQuery({ queryKey: ['sender-tips', s.id], queryFn: () => emailApi(app!.id).senderTips(s.id) })
  const [del, setDel] = useState(false)
  const refresh = () => qc.invalidateQueries({ queryKey: eqk.senders(app!.id) })
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className={cn('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full', s.status === 'verified' ? 'bg-success-soft text-success-strong' : 'bg-warning-soft text-warning-strong')}>
          {s.status === 'verified' ? <CheckCircle2 className="size-4" /> : <Clock className="size-4" />}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{s.from_name}</span>
            <span className="text-sm text-muted-foreground">&lt;{s.from_email}&gt;</span>
            {s.is_default && (
              <Badge>
                <Star className="size-3" /> Default
              </Badge>
            )}
            <Badge variant={s.status === 'verified' ? 'success' : 'warning'}>{s.status === 'verified' ? 'Verified' : 'Awaiting confirmation'}</Badge>
          </div>
          <div className="text-xs text-muted-foreground">
            {s.status === 'verified' ? `Verified ${s.verified_at ? timeAgo(s.verified_at) : ''}` : `Confirmation email sent ${s.verification_sent_at ? timeAgo(s.verification_sent_at) : ''} to ${s.from_email}`}
            {s.reply_to && ` · replies go to ${s.reply_to}`}
          </div>
          {tips.data?.tips.map((t) => (
            <p key={t} className="mt-1 flex items-start gap-1.5 text-xs text-warning-strong">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {t}
            </p>
          ))}
        </div>
      </div>
      {can('settings.write') && (
        <div className="flex gap-2">
          {s.status !== 'verified' && (
            <Button size="sm" variant="outline" onClick={async () => { await emailApi(app!.id).resendSender(s.id).catch((e) => toast.error(errorMessage(e))); toast.success('Confirmation email sent'); refresh() }}>
              <RotateCw /> Resend
            </Button>
          )}
          {!s.is_default && s.status === 'verified' && (
            <Button size="sm" variant="ghost" onClick={async () => { await emailApi(app!.id).updateSender(s.id, { is_default: true }); refresh() }}>
              Make default
            </Button>
          )}
          <Button size="icon" variant="ghost" aria-label={`Delete ${s.from_email}`} onClick={() => setDel(true)}>
            <Trash2 />
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title={`Remove ${s.from_email}?`}
        description="Draft campaigns using it will need a new sender."
        confirmLabel="Remove sender"
        destructive
        onConfirm={async () => {
          await emailApi(app!.id).deleteSender(s.id).catch((e) => toast.error(errorMessage(e)))
          setDel(false)
          refresh()
        }}
      />
    </li>
  )
}

export function SendersPage() {
  const { app, can } = useWorkspace()
  const q = useSenders(app!.id)
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ from_name: '', from_email: '', reply_to: '' })
  const [busy, setBusy] = useState(false)
  const domain = q.data?.find((s) => s.status === 'verified')?.domain ?? 'yourdomain.com'
  return (
    <>
      <PageHeader
        breadcrumbs={useCrumbs('Senders')}
        title="Sender addresses"
        description="Addresses your campaigns are sent from. Each one is confirmed by clicking a link sent to it."
        actions={
          can('settings.write') && (
            <Button onClick={() => setOpen(true)}>
              <Plus /> Add sender
            </Button>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          {q.isLoading ? (
            <LoadingRows rows={3} />
          ) : !q.data?.length ? (
            <EmptyState icon={Mail} title="No sender addresses" description="Add the address people will see in the From line." action={can('settings.write') && <Button variant="outline" onClick={() => setOpen(true)}><Plus /> Add sender</Button>} />
          ) : (
            <ul className="divide-y">
              {q.data.map((s) => (
                <SenderRow key={s.id} s={s} />
              ))}
            </ul>
          )}
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="size-4" /> Domain authentication
            </CardTitle>
            <CardDescription>Gmail and Yahoo require these for bulk senders. Add them at your DNS provider for {domain}.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            {[
              ['SPF', 'TXT', domain, 'v=spf1 include:amazonses.com ~all'],
              ['DKIM', 'CNAME', `selector._domainkey.${domain}`, 'Provided by SES or Brevo when you add the domain'],
              ['DMARC', 'TXT', `_dmarc.${domain}`, 'v=DMARC1; p=none; rua=mailto:dmarc@' + domain],
            ].map(([name, type, host, value]) => (
              <div key={name} className="rounded-md border p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{name}</span>
                  <Badge variant="secondary">{type}</Badge>
                </div>
                <div className="mt-1 break-all font-mono text-muted-foreground">{host}</div>
                <div className="mt-0.5 break-all font-mono">{value}</div>
              </div>
            ))}
            <p className="text-muted-foreground">These are guidance only. Domain records are checked by the email provider when live sending is enabled.</p>
          </CardContent>
        </Card>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a sender</DialogTitle>
            <DialogDescription>We will email a confirmation link to this address. It can be used once confirmed.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="From name" htmlFor="s-name" hint="Usually your brand, e.g. “Acme Deals”.">
              <Input id="s-name" value={form.from_name} onChange={(e) => setForm({ ...form, from_name: e.target.value })} />
            </Field>
            <Field label="From email" htmlFor="s-email" hint="Use an address on your own domain for the best deliverability.">
              <Input id="s-email" type="email" value={form.from_email} onChange={(e) => setForm({ ...form, from_email: e.target.value })} />
            </Field>
            <Field label="Reply-to (optional)" htmlFor="s-reply">
              <Input id="s-reply" type="email" value={form.reply_to} onChange={(e) => setForm({ ...form, reply_to: e.target.value })} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!form.from_name.trim() || !form.from_email.includes('@')}
              onClick={async () => {
                setBusy(true)
                try {
                  await emailApi(app!.id).createSender({ from_name: form.from_name, from_email: form.from_email, reply_to: form.reply_to || null })
                  await qc.invalidateQueries({ queryKey: eqk.senders(app!.id) })
                  toast.success(`Confirmation email sent to ${form.from_email}`)
                  setForm({ from_name: '', from_email: '', reply_to: '' })
                  setOpen(false)
                } catch (e) {
                  toast.error(errorMessage(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Add and send confirmation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
