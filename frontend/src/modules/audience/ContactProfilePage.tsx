import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, Clock, Globe2, Mail, MapPin, Pencil, Phone, Plus, Send, ShieldAlert, Trash2, XCircle } from 'lucide-react'
import { audienceApi, aqk, useAttributes, useContact } from '@/api/audience'
import { ApiError, errorMessage } from '@/api/client'
import { crmApi } from '@/api/crm'
import { EmptyState, ErrorState, FullPageSpinner, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/form-controls'
import { Avatar, Badge } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CHANNEL_META, StatusBadge, TagChip } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { countryFlag, countryName } from '@/lib/regions'
import { cn, formatDate, formatDateTime, timeAgo } from '@/lib/utils'
import type { Channel, ContactDetail } from '@/types/audience'
import { ContactCrmPanel } from '../crm/ContactCrmPanel'
import { AddTagDialog, AddToListDialog, QuickActions, ReachChips, reachFromEligibility, WorkflowsCard } from '../crm/connect'
import { KIND_META } from '../crm/format'
import { ContactFormDialog } from './ContactFormDialog'
import { ContactPrivacyActions } from './ContactPrivacyActions'

/** Email, SMS and call history from campaigns (and SMS replies), newest first. */
function CampaignHistory({ appId, contactId }: { appId: string; contactId: string }) {
  const q = useQuery({
    queryKey: ['crm', appId, 'timeline', { contact_id: contactId }, 'campaigns'],
    queryFn: () => crmApi(appId).timeline({ contact_id: contactId }, { limit: 200, kinds: 'email,sms,call' }),
  })
  if (q.isLoading) return <p className="p-5 text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  if (!q.data?.length)
    return (
      <EmptyState
        icon={Send}
        title="No campaigns sent to this contact"
        description="Email, SMS and voice deliveries, opens, clicks, replies and call outcomes appear here once campaigns run."
      />
    )
  return (
    <ol className="relative space-y-4 border-l pl-6" data-testid="campaign-history">
      {q.data.map((it) => {
        const meta = KIND_META[it.kind] ?? KIND_META.system!
        const Icon = meta.icon
        const campaign = it.meta.campaign as string | undefined
        return (
          <li key={`${it.kind}:${it.id}`} className="relative">
            <span className={cn('absolute -left-[37px] top-0 flex size-6 items-center justify-center rounded-full ring-4 ring-card', meta.tone)}>
              <Icon className="size-3.5" />
            </span>
            <p className="text-sm font-medium">{it.title}</p>
            {it.body && <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-muted-foreground">{it.body}</p>}
            <p className="text-xs text-muted-foreground" title={formatDateTime(it.occurred_at)}>
              {timeAgo(it.occurred_at)}
              {campaign && ` · ${campaign}`}
            </p>
          </li>
        )
      })}
    </ol>
  )
}

function ConsentDialog({ contact, channel, onClose }: { contact: ContactDetail; channel: Channel | null; onClose: () => void }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const [source, setSource] = useState('')
  const [evidence, setEvidence] = useState('')
  const [reference, setReference] = useState('')
  const [saving, setSaving] = useState(false)
  if (!channel) return null
  const granted = contact[`${channel}_consent`] && !contact[`${channel}_unsubscribed`]
  const us = contact.phone_country === 'US' && channel !== 'email'
  const label = CHANNEL_META[channel].label

  const save = async (status: 'granted' | 'revoked') => {
    setSaving(true)
    try {
      const updated = await audienceApi(app!.id).changeConsent(contact.id, {
        channel,
        status,
        source: source || undefined,
        evidence: evidence || undefined,
        consent_reference: reference || undefined,
      })
      qc.setQueryData(aqk.contact(app!.id, contact.id), updated)
      await qc.invalidateQueries({ queryKey: aqk.all(app!.id) })
      toast.success(status === 'granted' ? `${label} consent recorded` : `Unsubscribed from ${label}`)
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{granted ? `Unsubscribe from ${label}` : `Record ${label} consent`}</DialogTitle>
          <DialogDescription>
            {granted
              ? 'The address is added to the suppression list. Re-subscribing later requires a new consent record.'
              : 'Only record consent this person actually gave. The record is kept as evidence.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label={granted ? 'Reason (optional)' : 'Where was consent collected?'} htmlFor="cs-src">
            <Input id="cs-src" value={source} onChange={(e) => setSource(e.target.value)} placeholder={granted ? 'Asked by phone' : 'Website preference centre'} />
          </Field>
          {!granted && channel !== 'email' && (
            <Field label={us ? 'Written consent evidence (required for US numbers)' : 'Evidence'} htmlFor="cs-ev" hint={us ? 'TCPA requires prior express written consent.' : undefined}>
              <Textarea id="cs-ev" rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
            </Field>
          )}
          {!granted && channel === 'sms' && contact.phone_country === 'IN' && (
            <Field label="DLT consent reference (optional)" htmlFor="cs-ref">
              <Input id="cs-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {granted ? (
            <Button variant="destructive" loading={saving} onClick={() => save('revoked')}>
              Unsubscribe
            </Button>
          ) : (
            <Button loading={saving} disabled={!source.trim()} onClick={() => save('granted')}>
              Record consent
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Row({ icon: Icon, label, children }: { icon: typeof Mail; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="break-words text-sm">{children || '—'}</div>
      </div>
    </div>
  )
}

export function ContactProfilePage() {
  const { contactId } = useParams()
  const { app, org, can } = useWorkspace()
  const appId = app!.id
  const api = audienceApi(appId)
  const q = useContact(appId, contactId!)
  const attrs = useAttributes(appId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [edit, setEdit] = useState(false)
  const [consentFor, setConsentFor] = useState<Channel | null>(null)
  const [del, setDel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const showCrm = can('crm.read')
  // With CRM access the activity lives in one merged timeline on the "CRM & activity" tab.
  const activity = useQuery({ queryKey: [...aqk.contact(appId, contactId!), 'activity'], queryFn: () => api.activity(contactId!), enabled: !showCrm })
  const consents = useQuery({ queryKey: [...aqk.contact(appId, contactId!), 'consents'], queryFn: () => api.consents(contactId!) })
  const write = can('audience.write')
  const base = `/apps/${appId}/audience`
  const [params, setParams] = useSearchParams()
  const rawTab = params.get('tab') ?? 'overview'
  // One activity view: "activity" and "crm" are the same tab for CRM users.
  const tab = showCrm ? (rawTab === 'activity' ? 'crm' : rawTab) : rawTab === 'crm' ? 'activity' : rawTab

  if (q.isLoading) return <FullPageSpinner />
  if (q.isError)
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <EmptyState title="Contact not found" description="It may have been deleted." action={<Button asChild><Link to={`${base}/contacts`}>Back to contacts</Link></Button>} />
    ) : (
      <ErrorState error={q.error} onRetry={() => q.refetch()} />
    )
  const c = q.data!
  const refresh = () => qc.invalidateQueries({ queryKey: aqk.all(appId) })
  const name = c.full_name || c.email || c.phone_display || 'Unnamed contact'
  const reach = reachFromEligibility(c.eligibility)

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${appId}` }, { label: 'Contacts', to: `${base}/contacts` }, { label: name }]}
        title={name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={c.status} />
            {c.jurisdiction && (
              <Badge variant="outline">
                {countryFlag(c.jurisdiction)} {c.jurisdiction_name}
                {c.jurisdiction === 'US' && ' · TCPA & CAN-SPAM'}
                {c.jurisdiction === 'IN' && ' · TRAI DLT & DPDP'}
              </Badge>
            )}
            <span>Added {formatDate(c.created_at)}</span>
          </span>
        }
        actions={
          (write || can('privacy.manage')) && (
            <>
              {write && (
                <>
                  <Button variant="outline" onClick={() => setEdit(true)}>
                    <Pencil /> Edit
                  </Button>
                  <Button variant="outline" className="text-destructive" onClick={() => setDel(true)}>
                    <Trash2 /> Delete
                  </Button>
                </>
              )}
              {can('privacy.manage') && <ContactPrivacyActions appId={appId} contactId={c.id} name={name} />}
            </>
          )
        }
      />

      <QuickActions
        appId={appId}
        className="-mt-3 mb-5"
        contact={{ id: c.id, name, email: c.email, phone: c.phone, ...(reach ?? {}) }}
        company={c.company_id && c.company ? { id: c.company_id, name: c.company } : null}
        crm={showCrm && can('crm.write')}
        write={write}
      />

      <Tabs
        value={tab}
        onValueChange={(v) => {
          const next = new URLSearchParams(params)
          if (v === 'overview') next.delete('tab')
          else next.set('tab', v)
          setParams(next, { replace: true })
        }}
      >
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {showCrm ? <TabsTrigger value="crm">CRM &amp; activity</TabsTrigger> : <TabsTrigger value="activity">Activity</TabsTrigger>}
          <TabsTrigger value="campaigns">Campaign history</TabsTrigger>
          <TabsTrigger value="attributes">Attributes</TabsTrigger>
          <TabsTrigger value="consent">Consent history</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader className="flex-row items-center gap-3">
                <Avatar name={name} className="size-11 text-sm" />
                <div className="min-w-0">
                  <CardTitle className="truncate">{name}</CardTitle>
                  <CardDescription>{c.company ?? 'No company'}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="divide-y">
                <Row icon={Mail} label="Email">{c.email}</Row>
                <Row icon={Phone} label="Phone">
                  {c.phone_display && (
                    <>
                      {countryFlag(c.phone_country)} {c.phone_display}
                      {c.phone_type && <span className="ml-2 text-xs capitalize text-muted-foreground">{c.phone_type.replace(/_/g, ' ')}</span>}
                    </>
                  )}
                </Row>
                <Row icon={MapPin} label="Location">
                  {[c.city, c.state, c.postal_code].filter(Boolean).join(', ')}
                  {c.country && ` · ${countryName(c.country)}`}
                </Row>
                <Row icon={Clock} label="Local timezone">{c.timezone}</Row>
                <Row icon={Globe2} label="Source">{c.source}</Row>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Reachability</CardTitle>
                <CardDescription>Whether marketing on each channel is allowed today, and why not.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-3">
                {(['email', 'sms', 'voice'] as Channel[]).map((ch) => {
                  const e = c.eligibility[ch]
                  const Icon = CHANNEL_META[ch].icon
                  const has = ch === 'email' ? !!c.email : !!c.phone
                  return (
                    <div key={ch} className="flex flex-col rounded-lg border p-4" data-testid={`reach-${ch}`}>
                      <div className="flex items-center gap-2">
                        <Icon className="size-4 text-muted-foreground" />
                        <span className="text-sm font-medium">{CHANNEL_META[ch].label}</span>
                        {e.eligible ? <CheckCircle2 className="ml-auto size-4 text-success-strong" /> : <XCircle className="ml-auto size-4 text-muted-foreground/60" />}
                      </div>
                      <div className={`mt-2 text-sm font-medium ${e.eligible ? 'text-success-strong' : 'text-muted-foreground'}`}>
                        {e.eligible ? 'Reachable' : 'Not reachable'}
                      </div>
                      <ul className="mt-1 flex-1 space-y-0.5 text-xs text-muted-foreground">
                        {e.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                      {write && has && (
                        <Button variant="outline" size="sm" className="mt-3" onClick={() => setConsentFor(ch)}>
                          {c[`${ch}_consent`] && !c[`${ch}_unsubscribed`] ? 'Unsubscribe' : 'Record consent'}
                        </Button>
                      )}
                    </div>
                  )
                })}
                {c.jurisdiction === 'US' && (
                  <p className="flex items-start gap-2 text-xs text-muted-foreground sm:col-span-3">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" /> Calls and texts to this contact are limited to 8:00–21:00 in {c.timezone ?? 'their local time'}.
                  </p>
                )}
                {c.jurisdiction === 'IN' && (
                  <p className="flex items-start gap-2 text-xs text-muted-foreground sm:col-span-3">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" /> Promotional SMS needs a DLT-registered header and template, and is sent 9:00–21:00 IST.
                  </p>
                )}
                {(c.jurisdiction === 'AE' || c.dncr_registered) && (
                  <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:col-span-3 sm:flex-row sm:items-center" data-testid="dncr">
                    <p className="flex flex-1 items-start gap-2">
                      <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                      {c.dncr_registered
                        ? 'On the UAE Do Not Call Registry (DNCR): this number is never called.'
                        : 'UAE calls: 09:00–18:00 UAE time, Monday to Friday. Numbers on the Do Not Call Registry (DNCR) are never called.'}
                    </p>
                    {write && (
                      <Button
                        variant="outline"
                        size="sm"
                        loading={busy}
                        onClick={async () => {
                          setBusy(true)
                          try {
                            await api.updateContact(c.id, { dncr_registered: !c.dncr_registered })
                            await refresh()
                            toast.success(c.dncr_registered ? 'DNCR flag removed' : 'Marked as on the DNCR')
                          } catch (e) {
                            toast.error(errorMessage(e))
                          } finally {
                            setBusy(false)
                          }
                        }}
                      >
                        {c.dncr_registered ? 'Remove DNCR flag' : 'Mark as on the DNCR'}
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle>Tags and lists</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-6 sm:grid-cols-2">
                <div>
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Tags
                    {write && (
                      <button className="rounded p-0.5 hover:bg-muted" aria-label="Add tag" onClick={() => setTagOpen(true)}>
                        <Plus className="size-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {c.tags.length === 0 && <span className="text-sm text-muted-foreground">No tags</span>}
                    {c.tags.map((t) => (
                      <TagChip
                        key={t.id}
                        name={t.name}
                        color={t.color}
                        onRemove={
                          write
                            ? async () => {
                                await api.untagContact(c.id, t.id).catch((e) => toast.error(errorMessage(e)))
                                refresh()
                              }
                            : undefined
                        }
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Lists
                    {write && (
                      <button className="rounded p-0.5 hover:bg-muted" aria-label="Add to list" onClick={() => setListOpen(true)}>
                        <Plus className="size-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {c.lists.length === 0 && <span className="text-sm text-muted-foreground">Not in any list</span>}
                    {c.lists.map((l) => (
                      <Link key={l.id} to={`${base}/lists/${l.id}`}>
                        <Badge variant="secondary">{l.name}</Badge>
                      </Link>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
            <WorkflowsCard appId={appId} contactIds={[c.id]} className="lg:col-span-3" />
          </div>
        </TabsContent>

        {showCrm && (
          <TabsContent value="crm">
            <div className="mb-4 flex flex-wrap items-center gap-2 text-sm" data-testid="crm-reach">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reachable by</span>
              <ReachChips reach={reach?.reach} reasons={reach?.reasons} />
            </div>
            <ContactCrmPanel contactId={c.id} contactName={name} />
          </TabsContent>
        )}

        {!showCrm && (
        <TabsContent value="activity">
          <Card>
            <CardContent className="pt-5">
              {activity.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : activity.data?.items.length === 0 ? (
                <EmptyState title="No activity yet" />
              ) : (
                <ol className="relative space-y-5 border-l pl-6">
                  {activity.data?.items.map((a) => (
                    <li key={a.id} className="relative">
                      <span className="absolute -left-[29px] top-1 size-2.5 rounded-full bg-primary/70 ring-4 ring-card" />
                      <p className="text-sm font-medium">{a.description}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(a.created_at)}
                        {a.actor_name && ` · by ${a.actor_name}`}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        )}

        <TabsContent value="campaigns">
          <Card>
            <CardContent className="pt-5">
              {showCrm ? (
                <CampaignHistory appId={appId} contactId={c.id} />
              ) : (
                <EmptyState
                  icon={Send}
                  title="Campaign history needs CRM access"
                  description="Ask an admin for CRM access to see the emails, SMS and calls sent to this contact."
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="attributes">
          <Card>
            <CardHeader>
              <CardTitle>Custom fields</CardTitle>
              <CardDescription>
                Defined per application on the <Link className="text-primary hover:underline" to={`${base}/fields`}>Custom fields</Link> page.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!attrs.data?.length ? (
                <p className="text-sm text-muted-foreground">No custom fields defined.</p>
              ) : (
                <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                  {attrs.data.map((a) => (
                    <div key={a.id} className="flex justify-between gap-4 border-b py-2 text-sm">
                      <dt className="text-muted-foreground">{a.label}</dt>
                      <dd className="font-medium">
                        {c.attributes[a.key] === undefined || c.attributes[a.key] === null
                          ? '—'
                          : typeof c.attributes[a.key] === 'boolean'
                            ? c.attributes[a.key] ? 'Yes' : 'No'
                            : a.data_type === 'date'
                              ? formatDate(String(c.attributes[a.key]))
                              : String(c.attributes[a.key])}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="consent">
          <Card>
            <CardHeader>
              <CardTitle>Consent history</CardTitle>
              <CardDescription>Every grant and withdrawal, with its source and evidence. Records cannot be edited.</CardDescription>
            </CardHeader>
            <CardContent>
              {consents.data?.length === 0 ? (
                <p className="text-sm text-muted-foreground">No consent has been recorded for this contact.</p>
              ) : (
                <ul className="divide-y">
                  {consents.data?.map((r) => (
                    <li key={r.id} className="py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={r.status === 'granted' ? 'success' : 'warning'}>{r.status === 'granted' ? 'Granted' : 'Withdrawn'}</Badge>
                        <span className="font-medium">{CHANNEL_META[r.channel].label}</span>
                        <span className="text-muted-foreground">via {r.method.replace('_', ' ')}</span>
                        {r.jurisdiction && <span className="text-muted-foreground">· {countryFlag(r.jurisdiction)} {r.jurisdiction}</span>}
                        <span className="ml-auto text-xs text-muted-foreground" title={formatDateTime(r.created_at)}>
                          {timeAgo(r.created_at)}
                          {r.recorded_by_name && ` · ${r.recorded_by_name}`}
                        </span>
                      </div>
                      {r.source && <p className="mt-1 text-muted-foreground">Source: {r.source}</p>}
                      {r.evidence && <p className="text-muted-foreground">Evidence: {r.evidence}</p>}
                      {r.consent_reference && <p className="text-muted-foreground">Reference: {r.consent_reference}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ContactFormDialog open={edit} onOpenChange={setEdit} contact={c} />
      <AddTagDialog appId={appId} open={tagOpen} onOpenChange={setTagOpen} contactIds={[c.id]} who={name} />
      <AddToListDialog appId={appId} open={listOpen} onOpenChange={setListOpen} contactIds={[c.id]} who={name} />
      <ConsentDialog contact={c} channel={consentFor} onClose={() => setConsentFor(null)} />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title="Delete this contact?"
        description="Their data, consent history and activity will be erased. If they unsubscribed, they stay on the suppression list."
        confirmLabel="Delete contact"
        destructive
        loading={busy}
        onConfirm={async () => {
          setBusy(true)
          try {
            await api.deleteContact(c.id)
            await qc.invalidateQueries({ queryKey: aqk.all(appId) })
            toast.success('Contact deleted')
            navigate(`${base}/contacts`, { replace: true })
          } catch (e) {
            toast.error(errorMessage(e))
          } finally {
            setBusy(false)
          }
        }}
      />
    </>
  )
}
