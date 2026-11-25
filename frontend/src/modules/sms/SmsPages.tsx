/** SMS overview, campaigns, templates, sender IDs, DLT / 10DLC registration and replies. */
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  FileCheck2,
  FileText,
  FlaskConical,
  Inbox,
  Landmark,
  MessageSquare,
  MessageSquareReply,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Star,
  Trash2,
  TriangleAlert,
  UserMinus,
  XCircle,
} from 'lucide-react'
import { smsApi, sqk, useSmsCampaigns, useSmsInbound, useSmsOverview, useSmsRegistration, useSmsSenders, useSmsTemplates } from '@/api/sms'
import { http, errorMessage } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Checkbox, Pagination, StatCard } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import { analyseSms, toDltPattern } from '@/lib/smsEncoding'
import { cn, formatDate, formatDateTime, timeAgo } from '@/lib/utils'
import type { SenderKind, SmsCampaignListItem, SmsCategory, SmsCountry, SmsInboundItem, SmsSender, SmsTemplate } from '@/types/sms'
import { crmApi } from '@/api/crm'
import { CampaignStatusBadge, pct } from '../email/components'
import { SmsComposer } from './components'
import { CATEGORY_LABEL, COUNTRY_FLAG, formatMoney, KIND_LABEL } from './format'
import { NewSmsCampaignButton } from './SmsCampaignEditorPage'
import { BackToCampaignBanner, SetupChecklist, WhatIsThis, type SetupItem } from '../email/campaignKit'

function useCrumbs(label: string) {
  const { app, org } = useWorkspace()
  return [{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${app!.id}` }, { label: 'SMS', to: `/apps/${app!.id}/sms` }, { label }]
}

const usePricing = (appId: string) =>
  useQuery({
    queryKey: ['sms', appId, 'pricing'],
    queryFn: () => http.get<{ live: boolean; per_segment: Record<string, Record<string, number | string>> }>(`/apps/${appId}/sms/pricing`).then((r) => r.data),
    staleTime: 300_000,
  })

// ------------------------------------------------------------------ overview

export function SmsOverviewPage() {
  const { app, can } = useWorkspace()
  const q = useSmsOverview(app!.id)
  const senders = useSmsSenders(app!.id)
  const f = (n: number) => formatCount(n, app!.default_country)
  const base = `/apps/${app!.id}/sms`
  const country = app!.default_country
  const [other, setOther] = useState(false)
  const markets: ('IN' | 'US')[] = country === 'US' ? ['US'] : country === 'IN' ? ['IN'] : ['IN', 'US']
  if (other) markets.push(markets[0] === 'IN' ? 'US' : 'IN')
  const activeIn = (c: string) => !!senders.data?.some((s) => s.status === 'active' && s.country === c)
  const setupItems: SetupItem[] =
    q.data && senders.data
      ? markets.flatMap((m): SetupItem[] =>
          m === 'IN'
            ? [
                { key: 'in-reg', label: 'Add your DLT entity registration (PE ID)', done: q.data!.registration.india, to: `${base}/registration`, term: 'pe_id' },
                { key: 'in-sender', label: 'Add and confirm a DLT header (sender ID)', done: activeIn('IN'), to: `${base}/senders`, term: 'dlt_header' },
                { key: 'in-template', label: 'Add a DLT content template', done: q.data!.setup.dlt_templates > 0, to: `${base}/templates`, term: 'dlt_template' },
                { key: 'in-consent', label: 'Contacts with SMS consent (India)', done: q.data!.setup.consented.IN > 0, to: `/apps/${app!.id}/audience/import`, term: 'consent' },
              ]
            : [
                { key: 'us-reg', label: 'Register your 10DLC brand and campaign', done: q.data!.registration.us, to: `${base}/registration`, term: 'tendlc' },
                { key: 'us-sender', label: 'Add and confirm a US number', done: activeIn('US'), to: `${base}/senders` },
                { key: 'us-consent', label: 'Contacts with SMS consent (TCPA, US)', done: q.data!.setup.consented.US > 0, to: `/apps/${app!.id}/audience/import`, term: 'tcpa' },
              ],
        )
      : []
  const spend = q.data ? Object.entries(q.data.last_30_days.spend) : []
  return (
    <>
      <PageHeader
        breadcrumbs={useCrumbs('Overview')}
        title="SMS"
        description="Text message performance over the last 30 days, from carrier delivery receipts."
        actions={can('campaigns.write') && <NewSmsCampaignButton />}
      />
      <SetupChecklist
        testId="sms-setup"
        title="Finish SMS setup before your first campaign"
        items={setupItems}
        extra={
          country && !other ? (
            <button className="mt-3 text-xs font-medium underline" onClick={() => setOther(true)}>
              Also sending to {country === 'IN' ? 'the United States' : 'India'}?
            </button>
          ) : null
        }
      />
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        q.data && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <StatCard label="Texts sent" value={f(q.data.last_30_days.sent)} icon={Send} hint={`${f(q.data.last_30_days.campaigns)} campaigns · last 30 days`} />
              <StatCard label="Delivery rate" value={pct(q.data.last_30_days.delivery_rate)} icon={BadgeCheck} tone="success" hint={`${f(q.data.last_30_days.delivered)} delivered`} />
              <StatCard label="SMS parts" value={f(q.data.last_30_days.segments)} icon={MessageSquare} hint="Each part is billed" />
              <StatCard label="Spend" value={spend.length ? spend.map(([cur, v]) => formatMoney(v, cur)).join(' + ') : '—'} icon={CircleDollarSign} hint="Parts × per-part price" />
              <StatCard label="Opt-outs" value={f(q.data.last_30_days.opt_outs)} icon={UserMinus} hint="STOP replies received" />
            </div>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <Card className="min-w-0 lg:col-span-2">
                <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                  <CardTitle>Recent campaigns</CardTitle>
                  <Button variant="link" size="sm" asChild>
                    <Link to={`${base}/campaigns`}>All campaigns</Link>
                  </Button>
                </CardHeader>
                {q.data.recent.length === 0 ? (
                  <EmptyState icon={MessageSquare} title="No SMS campaigns yet" description="Create a campaign, check the compliance list and text a segment." action={can('campaigns.write') && <NewSmsCampaignButton variant="outline" />} />
                ) : (
                  <ul className="divide-y border-t">
                    {q.data.recent.map((c) => (
                      <li key={c.id}>
                        <Link to={c.status === 'draft' ? `${base}/campaigns/${c.id}/edit` : `${base}/campaigns/${c.id}`} className="flex items-center gap-4 px-5 py-3 transition hover:bg-muted/40">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{c.name}</div>
                            <div className="truncate text-xs text-muted-foreground">{c.body || 'No message yet'}</div>
                          </div>
                          {c.stats && c.stats.sent > 0 && (
                            <div className="hidden text-right text-xs sm:block">
                              <div className="tabular-nums">{pct(c.stats.sent ? (100 * c.stats.delivered) / c.stats.sent : null)} delivered</div>
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
                    <CardTitle>Compliance</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {[
                      ['🇮🇳 TRAI DLT entity', q.data.registration.india],
                      ['🇺🇸 A2P 10DLC', q.data.registration.us],
                    ].map(([label, ok]) => (
                      <div key={label as string} className="flex items-center justify-between">
                        <span>{label}</span>
                        {ok ? <Badge variant="success">Confirmed</Badge> : <Badge variant="secondary">Not set up</Badge>}
                      </div>
                    ))}
                    <div className="flex items-center justify-between">
                      <span>Sender IDs</span>
                      <span className="tabular-nums text-muted-foreground">
                        {q.data.senders.active ?? 0} approved · {q.data.senders.pending ?? 0} pending
                      </span>
                    </div>
                    <div className="grid gap-2 pt-2">
                      <Button variant="outline" className="justify-start" asChild>
                        <Link to={`${base}/registration`}>
                          <Landmark /> DLT & 10DLC
                        </Link>
                      </Button>
                      <Button variant="outline" className="justify-start" asChild>
                        <Link to={`${base}/inbox`}>
                          <Inbox /> Replies & opt-outs
                        </Link>
                      </Button>
                    </div>
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

// ------------------------------------------------------------------ campaigns

const TABS = [
  ['', 'All'],
  ['draft', 'Drafts'],
  ['scheduled', 'Scheduled'],
  ['sending', 'Sending'],
  ['completed', 'Sent'],
] as const

export function SmsCampaignsPage() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  const [del, setDel] = useState<SmsCampaignListItem | null>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])
  const q = useSmsCampaigns(appId, { page, page_size: 20, status: status || undefined, search: debounced || undefined })
  const f = (n: number) => formatCount(n, app!.default_country)
  const base = `/apps/${appId}/sms/campaigns`
  const open = (c: SmsCampaignListItem) => navigate(c.status === 'draft' ? `${base}/${c.id}/edit` : `${base}/${c.id}`)
  return (
    <>
      <PageHeader breadcrumbs={useCrumbs('Campaigns')} title="SMS campaigns" description="Drafts, scheduled sends and delivery results." actions={can('campaigns.write') && <NewSmsCampaignButton />} />
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
          <EmptyState icon={MessageSquare} title={debounced || status ? 'No campaigns match' : 'No SMS campaigns yet'} description="Campaigns you create appear here with their results." action={can('campaigns.write') && !debounced && !status && <NewSmsCampaignButton variant="outline" />} />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Campaign</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Recipients</TH>
                  <TH className="text-right">Delivered</TH>
                  <TH className="text-right">Cost</TH>
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
                        <div className="max-w-md truncate text-xs text-muted-foreground">
                          {CATEGORY_LABEL[c.category]} · {c.body || 'No message yet'}
                        </div>
                      </TD>
                      <TD>
                        <CampaignStatusBadge status={c.status} />
                      </TD>
                      <TD className="text-right tabular-nums">{c.recipient_count ? f(c.recipient_count) : '—'}</TD>
                      <TD className="text-right tabular-nums">{s && s.sent ? pct((100 * s.delivered) / s.sent) : '—'}</TD>
                      <TD className="text-right tabular-nums">{s && s.sent ? formatMoney(s.cost, c.currency) : '—'}</TD>
                      <TD className="whitespace-nowrap text-xs text-muted-foreground">
                        {c.launched_at ? formatDate(c.launched_at) : c.scheduled_at ? `Scheduled ${formatDateTime(c.scheduled_at)}` : `Edited ${timeAgo(c.updated_at)}`}
                      </TD>
                      <TD onClick={(e) => e.stopPropagation()}>
                        {can('campaigns.write') && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" aria-label={`Actions for ${c.name}`}>
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => open(c)}>{c.status === 'draft' ? 'Edit' : 'View report'}</DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={async () => {
                                  try {
                                    const d = await smsApi(appId).duplicateCampaign(c.id)
                                    navigate(`${base}/${d.id}/edit`)
                                  } catch (e) {
                                    toast.error(errorMessage(e))
                                  }
                                }}
                              >
                                Duplicate
                              </DropdownMenuItem>
                              {c.status === 'draft' && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem className="text-destructive" onSelect={() => setDel(c)}>
                                    Delete
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
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
        description="The draft is removed permanently."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          try {
            await smsApi(appId).deleteCampaign(del!.id)
            await qc.invalidateQueries({ queryKey: sqk.all(appId) })
            toast.success('Draft deleted')
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

// ------------------------------------------------------------------ templates

/** Create or edit an SMS template; also used inline by the campaign editor. */
export function TemplateDialog({
  open,
  onOpenChange,
  template,
  onSaved,
  initial,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  template: SmsTemplate | null
  onSaved?: (t: SmsTemplate) => void
  initial?: { category?: SmsCategory; body?: string; sender_ref?: string | null }
}) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const senders = useSmsSenders(app!.id)
  const [form, setForm] = useState({ name: '', category: 'promotional' as SmsCategory, body: '', sender_ref: '', dlt_template_id: '', dlt_template_text: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open)
      setForm({
        name: template?.name ?? '',
        category: template?.category ?? initial?.category ?? 'promotional',
        body: template?.body ?? initial?.body ?? '',
        sender_ref: template?.sender_ref ?? initial?.sender_ref ?? '',
        dlt_template_id: template?.dlt_template_id ?? '',
        dlt_template_text: template?.dlt_template_text ?? '',
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template])
  const sender = senders.data?.find((s) => s.id === form.sender_ref)
  const india = sender?.country === 'IN' || (!sender && app!.default_country === 'IN')
  const match = form.dlt_template_text ? toDltPattern(form.body) === toDltPattern(form.dlt_template_text.replace(/\{#\s*var\s*#\}/gi, '{#var#}')) : null
  const save = async () => {
    setBusy(true)
    const body = { ...form, sender_ref: form.sender_ref || null, dlt_template_id: form.dlt_template_id.trim() || null, dlt_template_text: form.dlt_template_text.trim() || null }
    try {
      const out = template ? await smsApi(app!.id).updateTemplate(template.id, body) : await smsApi(app!.id).createTemplate(body)
      await qc.invalidateQueries({ queryKey: sqk.templates(app!.id) })
      toast.success(template ? 'Template saved' : 'Template created')
      onSaved?.(out)
      onOpenChange(false)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{template ? 'Edit SMS template' : 'New SMS template'}</DialogTitle>
          <DialogDescription>Reusable message text. In India, add the template ID and exact text approved on your DLT portal.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Name" htmlFor="t-name" className="sm:col-span-1">
              <Input id="t-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Type" htmlFor="t-cat">
              <Select id="t-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as SmsCategory })}>
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sender ID" htmlFor="t-sender">
              <Select id="t-sender" value={form.sender_ref} onChange={(e) => setForm({ ...form, sender_ref: e.target.value })}>
                <option value="">Any</option>
                {senders.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {COUNTRY_FLAG[s.country]} {s.sender_id}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Message" htmlFor="t-body">
            <SmsComposer id="t-body" appId={app!.id} value={form.body} onChange={(v) => setForm({ ...form, body: v })} />
          </Field>
          {india && (
            <div className="grid gap-4 rounded-lg border bg-muted/30 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <FileCheck2 className="size-4" /> DLT registration (India)
              </div>
              <Field label="DLT template ID" htmlFor="t-dltid" hint="19 digits, from your DLT portal (Jio, Airtel, Vi, BSNL…)" action={<WhatIsThis term="dlt_template" />}>
                <Input id="t-dltid" inputMode="numeric" value={form.dlt_template_id} onChange={(e) => setForm({ ...form, dlt_template_id: e.target.value })} placeholder="1107160000000012345" />
              </Field>
              <Field label="Registered text" htmlFor="t-dlttext" hint="Paste the approved text exactly, with {#var#} where fields go." action={<WhatIsThis term="dlt_var" />}>
                <Textarea id="t-dlttext" rows={3} value={form.dlt_template_text} onChange={(e) => setForm({ ...form, dlt_template_text: e.target.value })} className="font-mono text-xs" />
              </Field>
              {match !== null && (
                <div className={cn('flex items-center gap-2 text-sm', match ? 'text-success-strong' : 'text-danger-strong')} data-testid="template-dlt-match">
                  {match ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
                  {match ? 'Message matches the registered text' : `Doesn’t match. Your text reads: ${toDltPattern(form.body)}`}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!form.name.trim() || !form.body.trim()} onClick={save}>
            {template ? 'Save template' : 'Create template'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SmsTemplatesPage() {
  const { app, can } = useWorkspace()
  const q = useSmsTemplates(app!.id)
  const senders = useSmsSenders(app!.id)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [edit, setEdit] = useState<SmsTemplate | null>(null)
  const [open, setOpen] = useState(false)
  const [del, setDel] = useState<SmsTemplate | null>(null)
  const senderName = (id: string | null) => senders.data?.find((s) => s.id === id)?.sender_id
  return (
    <>
      <BackToCampaignBanner />
      <PageHeader
        breadcrumbs={useCrumbs('Templates')}
        title="SMS templates"
        description="Approved message text to reuse across campaigns."
        actions={
          can('campaigns.write') && (
            <Button
              onClick={() => {
                setEdit(null)
                setOpen(true)
              }}
            >
              <Plus /> New template
            </Button>
          )
        }
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.length ? (
        <Card>
          <EmptyState icon={FileText} title="No SMS templates yet" description="In India, every promotional or transactional text must use a DLT-registered template. Add yours here once." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {q.data.map((t) => {
            const info = analyseSms(t.body)
            return (
              <Card key={t.id} className="flex flex-col">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-base">{t.name}</CardTitle>
                      <CardDescription>
                        {CATEGORY_LABEL[t.category]}
                        {senderName(t.sender_ref) && ` · ${senderName(t.sender_ref)}`}
                      </CardDescription>
                    </div>
                    {t.dlt_template_id &&
                      (t.dlt_match ? (
                        <Badge variant="success">
                          <ShieldCheck className="size-3" /> DLT
                        </Badge>
                      ) : (
                        <Badge variant="destructive">DLT mismatch</Badge>
                      ))}
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-3">
                  <p className="line-clamp-4 flex-1 whitespace-pre-wrap rounded-lg bg-muted/50 p-3 text-sm">{t.body}</p>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {info.segments} part{info.segments === 1 ? '' : 's'} · {info.encoding}
                    </span>
                    {can('campaigns.write') && (
                      <span className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            try {
                              const c = await smsApi(app!.id).createCampaign({ name: t.name, template_id: t.id })
                              navigate(`/apps/${app!.id}/sms/campaigns/${c.id}/edit`)
                            } catch (e) {
                              toast.error(errorMessage(e))
                            }
                          }}
                        >
                          <Send /> Use
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Edit ${t.name}`}
                          onClick={() => {
                            setEdit(t)
                            setOpen(true)
                          }}
                        >
                          <Pencil />
                        </Button>
                        <Button size="icon" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => setDel(t)}>
                          <Trash2 />
                        </Button>
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
      <TemplateDialog open={open} onOpenChange={setOpen} template={edit} />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete “${del?.name}”?`}
        description="Campaigns that already used it keep their text."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          try {
            await smsApi(app!.id).deleteTemplate(del!.id)
            await qc.invalidateQueries({ queryKey: sqk.templates(app!.id) })
            toast.success('Template deleted')
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

// ------------------------------------------------------------------ senders

const KINDS: Record<SmsCountry, SenderKind[]> = { IN: ['promotional', 'transactional', 'service'], AE: ['promotional', 'transactional', 'service'], US: ['long_code', 'toll_free', 'short_code'] }
const PLACEHOLDER: Record<SenderKind, string> = {
  promotional: '561234',
  transactional: 'ACMEIN',
  service: 'ACMEIN',
  long_code: '+14155550100',
  toll_free: '+18885550100',
  short_code: '55555',
}

/** Add a sender ID; also used inline by the campaign editor (with the kind the campaign needs). */
export function AddSenderDialog({
  open,
  onOpenChange,
  onCreated,
  defaultKind,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated?: (s: SmsSender) => void
  defaultKind?: SenderKind
}) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const initialCountry: SmsCountry = app!.default_country === 'US' ? 'US' : 'IN'
  const [country, setCountry] = useState<SmsCountry>(initialCountry)
  const [kind, setKind] = useState<SenderKind>(defaultKind && KINDS[initialCountry].includes(defaultKind) ? defaultKind : KINDS[initialCountry][0]!)
  const [senderId, setSenderId] = useState('')
  const [headerId, setHeaderId] = useState('')
  const [provider, setProvider] = useState<'simulation' | 'sns'>('simulation')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setSenderId('')
      setHeaderId('')
      setError(null)
    }
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a sender ID</DialogTitle>
          <DialogDescription>Use a header or number you have already registered. You confirm it on the next step.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Country">
            {(['IN', 'US'] as SmsCountry[]).map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={country === c}
                onClick={() => {
                  setCountry(c)
                  setKind(KINDS[c][0]!)
                  setProvider('simulation')
                }}
                className={cn('rounded-lg border px-3 py-2.5 text-sm font-medium transition', country === c ? 'border-primary bg-accent/50' : 'text-muted-foreground hover:bg-muted')}
              >
                {COUNTRY_FLAG[c]} {c === 'IN' ? 'India (DLT)' : 'United States'}
              </button>
            ))}
          </div>
          <Field label="Type" htmlFor="s-kind">
            <Select id="s-kind" value={kind} onChange={(e) => setKind(e.target.value as SenderKind)}>
              {KINDS[country].map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={country === 'IN' ? 'Header' : 'Number'}
            action={country === 'IN' ? <WhatIsThis term="dlt_header" /> : undefined}
            htmlFor="s-id"
            error={error ?? undefined}
            hint={country === 'IN' ? (kind === 'promotional' ? 'Promotional headers are 6 digits.' : 'Service and transactional headers are 6 letters.') : kind === 'short_code' ? '5 or 6 digits.' : 'E.164 format, starting +1.'}
          >
            <Input id="s-id" value={senderId} onChange={(e) => setSenderId(e.target.value.trim())} placeholder={PLACEHOLDER[kind]} className="font-mono" />
          </Field>
          {country === 'IN' && (
            <Field label="DLT header ID (optional)" htmlFor="s-hid" hint="The numeric ID your DLT portal shows next to the approved header.">
              <Input id="s-hid" value={headerId} onChange={(e) => setHeaderId(e.target.value)} inputMode="numeric" />
            </Field>
          )}
          <Field label="Provider" htmlFor="s-prov" hint="Simulation never contacts a carrier. Live providers are used only after the platform is switched to live mode.">
            <Select id="s-prov" value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
              <option value="simulation">Simulation</option>
              <option value="sns">Amazon SNS</option>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!senderId}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                const s = await smsApi(app!.id).createSender({ sender_id: senderId, country, kind, provider, dlt_header_id: headerId || null })
                await qc.invalidateQueries({ queryKey: sqk.all(app!.id) })
                toast.success('Sender ID added. Confirm it to start using it.')
                onCreated?.(s)
                onOpenChange(false)
              } catch (e) {
                setError(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Add sender ID
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SmsSendersPage() {
  const { app, can } = useWorkspace()
  const q = useSmsSenders(app!.id)
  const qc = useQueryClient()
  const [add, setAdd] = useState(false)
  const [attest, setAttest] = useState<SmsSender | null>(null)
  const [del, setDel] = useState<SmsSender | null>(null)
  const [busy, setBusy] = useState(false)
  const write = can('settings.write')
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: sqk.all(app!.id) })
      toast.success(msg)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
      setAttest(null)
      setDel(null)
    }
  }
  return (
    <>
      <BackToCampaignBanner />
      <PageHeader
        breadcrumbs={useCrumbs('Sender IDs')}
        title="Sender IDs"
        description="DLT headers for India and numbers or short codes for the US."
        actions={
          write && (
            <Button onClick={() => setAdd(true)}>
              <Plus /> Add sender ID
            </Button>
          )
        }
      />
      <Card>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.length ? (
          <EmptyState icon={MessageSquareReply} title="No sender IDs yet" description="Add the header or number your texts come from." action={write && <Button variant="outline" onClick={() => setAdd(true)}>Add sender ID</Button>} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Sender</TH>
                <TH>Type</TH>
                <TH>Provider</TH>
                <TH>Status</TH>
                <TH className="w-10" />
              </TR>
            </THead>
            <TBody>
              {q.data.map((s) => (
                <TR key={s.id}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <span aria-hidden>{COUNTRY_FLAG[s.country]}</span>
                      <span className="font-mono font-semibold">{s.sender_id}</span>
                      {s.is_default && (
                        <Badge variant="secondary">
                          <Star className="size-3" /> Default
                        </Badge>
                      )}
                    </div>
                  </TD>
                  <TD className="text-sm text-muted-foreground">{KIND_LABEL[s.kind]}</TD>
                  <TD className="text-sm capitalize">{s.provider === 'sns' ? 'Amazon SNS' : s.provider}</TD>
                  <TD>
                    {s.status === 'active' ? (
                      <Badge variant="success">Approved {s.attested_at && `· ${formatDate(s.attested_at)}`}</Badge>
                    ) : write ? (
                      <Button size="sm" variant="outline" onClick={() => setAttest(s)}>
                        <ShieldCheck /> Confirm registration
                      </Button>
                    ) : (
                      <Badge variant="warning">Not confirmed</Badge>
                    )}
                  </TD>
                  <TD>
                    {write && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${s.sender_id}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {!s.is_default && <DropdownMenuItem onSelect={() => act(() => smsApi(app!.id).defaultSender(s.id), `${s.sender_id} is now the default`)}>Make default</DropdownMenuItem>}
                          <DropdownMenuItem className="text-destructive" onSelect={() => setDel(s)}>
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <AddSenderDialog open={add} onOpenChange={setAdd} />
      <ConfirmDialog
        open={!!attest}
        onOpenChange={(o) => !o && setAttest(null)}
        title={`Confirm ${attest?.sender_id} is registered?`}
        description={
          attest?.country === 'IN'
            ? 'You confirm this header is approved on your DLT portal for your Principal Entity. Operators block texts from unregistered headers. Your name and the time are recorded.'
            : 'You confirm this number or short code is provisioned for your business and linked to an approved 10DLC campaign or toll-free verification. Your name and the time are recorded.'
        }
        confirmLabel="I confirm"
        loading={busy}
        onConfirm={() => act(() => smsApi(app!.id).attestSender(attest!.id), 'Sender ID approved')}
      />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Remove ${del?.sender_id}?`}
        description="Draft campaigns using it will need a new sender ID."
        confirmLabel="Remove"
        destructive
        loading={busy}
        onConfirm={() => act(() => smsApi(app!.id).deleteSender(del!.id), 'Sender ID removed')}
      />
    </>
  )
}

// ------------------------------------------------------------------ registration

/** DLT (India) and 10DLC (US) registration. The same DLT registration covers SMS and voice; Voice opens it too. */
export function SmsRegistrationPage({ channel = 'sms' }: { channel?: 'sms' | 'voice' }) {
  const { app, can, org } = useWorkspace()
  const country = app!.default_country
  const [showOther, setShowOther] = useState(false)
  const showIndia = channel === 'voice' || country !== 'US' || showOther
  const showUs = channel === 'sms' && (country !== 'IN' || showOther)
  const q = useSmsRegistration(app!.id)
  const qc = useQueryClient()
  const write = can('settings.write')
  const crumbs = useCrumbs('DLT & 10DLC')
  const [form, setForm] = useState({ principal_entity_id: '', entity_name: '', dlt_platform: '', us_brand_id: '', us_campaign_id: '' })
  const [attest, setAttest] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (q.data)
      setForm({
        principal_entity_id: q.data.principal_entity_id ?? '',
        entity_name: q.data.entity_name ?? '',
        dlt_platform: q.data.dlt_platform ?? '',
        us_brand_id: q.data.us_brand_id ?? '',
        us_campaign_id: q.data.us_campaign_id ?? '',
      })
  }, [q.data])
  const dirty = useMemo(() => q.data && Object.entries(form).some(([k, v]) => (q.data![k as keyof typeof form] ?? '') !== v), [form, q.data])
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value })
  const save = async () => {
    setBusy(true)
    try {
      const out = await smsApi(app!.id).updateRegistration({ ...form, attest })
      qc.setQueryData(sqk.registration(app!.id), out)
      await qc.invalidateQueries({ queryKey: sqk.all(app!.id) })
      setAttest(false)
      toast.success(attest ? 'Registration saved and confirmed' : 'Registration saved')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <BackToCampaignBanner />
      {channel === 'voice' ? (
        <PageHeader
          breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${app!.id}` }, { label: 'Voice', to: `/apps/${app!.id}/voice` }, { label: 'DLT registration' }]}
          title="DLT registration (shared by SMS and voice)"
          description="Indian operators block business calls and texts from entities not registered on a DLT portal. One registration covers both channels."
        />
      ) : (
        <PageHeader breadcrumbs={crumbs} title="DLT & 10DLC registration" description="Carriers in India and the US block business texts from unregistered senders." />
      )}
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-6">
            {showIndia && (
            <Card>
              <CardHeader>
                <CardTitle>🇮🇳 India: TRAI DLT</CardTitle>
                <CardDescription>Your Principal Entity registration on an operator DLT portal. Headers and templates are registered under it.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <Field label="Principal Entity ID" htmlFor="r-pe" hint="Digits only, usually 19" action={<WhatIsThis term="pe_id" />}>
                  <Input id="r-pe" inputMode="numeric" value={form.principal_entity_id} onChange={set('principal_entity_id')} disabled={!write} className="font-mono" />
                </Field>
                <Field label="Registered entity name" htmlFor="r-name">
                  <Input id="r-name" value={form.entity_name} onChange={set('entity_name')} disabled={!write} />
                </Field>
                <Field label="DLT portal" htmlFor="r-platform">
                  <Select id="r-platform" value={form.dlt_platform} onChange={set('dlt_platform')} disabled={!write}>
                    <option value="">Choose…</option>
                    {['Jio', 'Airtel', 'Vodafone Idea', 'BSNL', 'MTNL', 'Tata', 'Other'].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </Select>
                </Field>
              </CardContent>
            </Card>
            )}
            {showUs && (
            <Card>
              <CardHeader>
                <CardTitle>🇺🇸 United States: A2P 10DLC <WhatIsThis term="tendlc" /></CardTitle>
                <CardDescription>Brand and campaign IDs from The Campaign Registry, via your provider. Required for texting from local 10-digit numbers.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <Field label="Brand ID" htmlFor="r-brand">
                  <Input id="r-brand" value={form.us_brand_id} onChange={set('us_brand_id')} disabled={!write} className="font-mono" />
                </Field>
                <Field label="Campaign ID" htmlFor="r-camp">
                  <Input id="r-camp" value={form.us_campaign_id} onChange={set('us_campaign_id')} disabled={!write} className="font-mono" />
                </Field>
              </CardContent>
            </Card>
            )}
            {channel === 'sms' && country && !showOther && (
              <button className="text-sm font-medium text-primary hover:underline" onClick={() => setShowOther(true)} data-testid="show-other-market">
                Also sending to {country === 'IN' ? 'the United States' : 'India'}?
              </button>
            )}
            {write && (
              <Card>
                <CardContent className="space-y-4 pt-6">
                  <label className="flex items-start gap-3 text-sm">
                    <Checkbox checked={attest} onChange={(e) => setAttest(e.target.checked)} aria-label="Confirm registration" />
                    <span>
                      I confirm these registrations are approved and belong to this business.
                      <span className="block text-xs text-muted-foreground">Your name and the time are recorded. Changing any ID later clears the confirmation.</span>
                    </span>
                  </label>
                  <div className="flex justify-end">
                    <Button loading={busy} disabled={!dirty && !attest} onClick={save}>
                      Save registration
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {q.data?.attested_at ? (
                <div className="flex items-start gap-2 text-success-strong" data-testid="registration-confirmed">
                  <CheckCircle2 className="mt-0.5 size-4" />
                  <span>
                    Confirmed by {q.data.attested_by_name ?? 'a team member'} on {formatDateTime(q.data.attested_at)}
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2 text-warning-strong">
                  <TriangleAlert className="mt-0.5 size-4" /> Not confirmed. Campaigns cannot be sent until it is.
                </div>
              )}
              <p className="text-xs text-muted-foreground">We check that headers, templates and message text line up with these registrations before every send. Approval itself happens with the regulator and your provider.</p>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------------ replies

function SimulateReplyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const senders = useSmsSenders(app!.id)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [body, setBody] = useState('STOP')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open && !to && senders.data?.[0]) setTo(senders.data[0].sender_id)
  }, [open, to, senders.data])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Simulate a reply</DialogTitle>
          <DialogDescription>Pretend a contact texted one of your sender IDs. STOP opts them out; START opts them back in.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="From (contact’s number)" htmlFor="r-from">
            <Input id="r-from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="+919876543210" />
          </Field>
          <Field label="To (your sender ID)" htmlFor="r-to">
            <Select id="r-to" value={to} onChange={(e) => setTo(e.target.value)}>
              {senders.data?.map((s) => (
                <option key={s.id} value={s.sender_id}>
                  {s.sender_id}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Message" htmlFor="r-body">
            <Input id="r-body" value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!from || !to || !body}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await smsApi(app!.id).simulateInbound({ from_phone: from, to_sender: to, body, event_id: `ui-${Date.now()}` })
                await qc.invalidateQueries({ queryKey: sqk.all(app!.id) })
                await qc.invalidateQueries({ queryKey: ['audience', app!.id] })
                toast.success(r.keyword ? `${r.keyword.toUpperCase()} processed · ${r.contacts_updated} contact(s) updated` : 'Reply recorded')
                onOpenChange(false)
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Send reply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Act on a reply: open the contact, create a follow-up task (assigned to the contact's owner) or start a deal. */
function ReplyActions({ reply }: { reply: SmsInboundItem }) {
  const { app, can } = useWorkspace()
  const c = reply.contact!
  const contactUrl = `/apps/${app!.id}/audience/contacts/${c.id}`
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for reply from ${c.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link to={contactUrl}>Open contact</Link>
        </DropdownMenuItem>
        {can('crm.write') && (
          <DropdownMenuItem
            onSelect={async () => {
              try {
                await crmApi(app!.id).createTask({
                  title: `Reply to ${c.name}: “${reply.body.slice(0, 60)}”`,
                  type: 'call',
                  contact_id: c.id,
                  assignee_id: c.owner_id ?? undefined,
                  notes: `SMS reply received ${formatDateTime(reply.received_at)}${reply.campaign ? ` to “${reply.campaign.name}”` : ''}:
${reply.body}`,
                })
                toast.success('Follow-up task created', { action: { label: 'View tasks', onClick: () => window.location.assign(`/apps/${app!.id}/crm/tasks`) } })
              } catch (e) {
                toast.error(errorMessage(e))
              }
            }}
          >
            Create follow-up task
          </DropdownMenuItem>
        )}
        {can('crm.write') && (
          <DropdownMenuItem asChild>
            <Link to={contactUrl}>Start a deal (on the contact)</Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const KEYWORD_BADGE = { stop: ['destructive', 'Opted out'], start: ['success', 'Opted in'], help: ['secondary', 'Help'] } as const

export function SmsInboxPage() {
  const { app, can } = useWorkspace()
  const [page, setPage] = useState(1)
  const q = useSmsInbound(app!.id, { page, page_size: 25 })
  const pricing = usePricing(app!.id)
  const [sim, setSim] = useState(false)
  return (
    <>
      <PageHeader
        breadcrumbs={useCrumbs('Replies')}
        title="Replies & opt-outs"
        description="Texts received on your sender IDs. STOP, UNSUBSCRIBE and similar keywords are honoured automatically."
        actions={
          pricing.data && !pricing.data.live && can('campaigns.write') ? (
            <Button variant="outline" onClick={() => setSim(true)}>
              <FlaskConical /> Simulate a reply
            </Button>
          ) : undefined
        }
      />
      <Card>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState icon={Inbox} title="No replies yet" description="When contacts reply to your texts, their messages and opt-outs appear here." />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>From</TH>
                  <TH>To</TH>
                  <TH>Message</TH>
                  <TH>Keyword</TH>
                  <TH>Received</TH>
                  <TH className="w-10" />
                </TR>
              </THead>
              <TBody>
                {q.data.items.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      {r.contact ? (
                        <Link className="text-sm font-medium hover:text-primary" to={`/apps/${app!.id}/audience/contacts/${r.contact.id}`} data-testid="reply-contact">
                          {r.contact.name}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">Unknown number</span>
                      )}
                      <div className="font-mono text-xs text-muted-foreground">{r.from}</div>
                    </TD>
                    <TD className="font-mono text-sm">{r.to}</TD>
                    <TD className="max-w-sm">
                      <div className="truncate">{r.body}</div>
                      {r.campaign && (
                        <Link className="text-xs text-muted-foreground hover:text-primary" to={`/apps/${app!.id}/sms/campaigns/${r.campaign.id}`} data-testid="reply-campaign">
                          Reply to {r.campaign.name}
                        </Link>
                      )}
                    </TD>
                    <TD>
                      {r.keyword ? (
                        <Badge variant={KEYWORD_BADGE[r.keyword][0]}>
                          {KEYWORD_BADGE[r.keyword][1]}
                          {r.contacts_updated ? ` · ${r.contacts_updated}` : ''}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground">{timeAgo(r.received_at)}</TD>
                    <TD>{r.contact && <ReplyActions reply={r} />}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={25} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <SimulateReplyDialog open={sim} onOpenChange={setSim} />
    </>
  )
}
