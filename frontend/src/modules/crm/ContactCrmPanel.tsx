import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { cqk, crmApi, useContactCrm, useDeals } from '@/api/crm'
import { ErrorState, LoadingRows } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, Select } from '@/components/ui/form-controls'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { Channel } from '@/types/audience'
import type { ContactCrmUpdate, Lifecycle, Reach } from '@/types/crm'
import { CompanyPicker, DealFormDialog, GradeBadge, HotBadge, OwnerSelect, SectionTitle, SlaStatus } from './components'
import { DealStatusBadge } from './DealsPage'
import { LIFECYCLE_LABEL, LIFECYCLES, moneyCompact } from './format'
import { RecordActivity } from './Timeline'
import { ReachChips } from './connect'

/** CRM tab on the contact profile: ownership, lifecycle, score, SLA, deals and the activity timeline. */
export function ContactCrmPanel({
  contactId,
  contactName,
  reach,
  showActivity = true,
}: {
  contactId: string
  contactName: string
  /** Reachability from the contact's eligibility, shown as chips (see reachFromEligibility). */
  reach?: { reach: Reach; reasons?: Partial<Record<Channel, string[]>> } | null
  /** The profile page shows its own merged timeline; pass false there to avoid a second feed. */
  showActivity?: boolean
}) {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const qc = useQueryClient()
  const q = useContactCrm(appId, contactId)
  const deals = useDeals(appId, { contact_id: contactId, page: 1, page_size: 50 })
  const [newDeal, setNewDeal] = useState(false)
  const writable = can('crm.write')
  const base = `/apps/${appId}`

  const save = async (body: ContactCrmUpdate) => {
    try {
      const r = await crmApi(appId).updateContactCrm(contactId, body)
      qc.setQueryData(cqk.contact(appId, contactId), r)
      void qc.invalidateQueries({ queryKey: cqk.timeline(appId) })
      void qc.invalidateQueries({ queryKey: cqk.leads(appId) })
      void qc.invalidateQueries({ queryKey: ['aud', appId] })
      toast.success('Saved')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  if (q.isLoading) return <LoadingRows />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const c = q.data!

  return (
    <div className={showActivity ? 'grid gap-6 lg:grid-cols-3' : 'grid gap-6 md:grid-cols-2'} data-testid="crm-panel">
      <div className={showActivity ? 'min-w-0 space-y-6' : 'contents'}>
        <Card>
          <CardContent className="space-y-4 pt-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-muted-foreground">Lead score</div>
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-semibold tabular-nums">{c.lead_score}</span>
                  <GradeBadge grade={c.grade} fit={c.fit_score} engagement={c.engagement_score} score={c.lead_score} />
                  {c.hot && <HotBadge />}
                </div>
                <div className="text-xs text-muted-foreground">
                  Fit {c.fit_score} · Engagement {c.engagement_score}
                </div>
              </div>
              <div className="text-right">
                <div className="mb-1 text-xs text-muted-foreground">First response</div>
                <SlaStatus due={c.sla_due_at} breached={c.sla_breached_at} responded={c.first_response_at} />
              </div>
            </div>
            {reach && (
              <div>
                <div className="mb-1 text-xs text-muted-foreground">Reachable on</div>
                <ReachChips reach={reach.reach} reasons={reach.reasons} />
              </div>
            )}
            <fieldset disabled={!writable} className="space-y-3">
              <Field label="Owner" htmlFor="crm-owner">
                <OwnerSelect appId={appId} id="crm-owner" value={c.owner?.id ?? ''} onChange={(v) => void save(v ? { owner_id: v } : { clear_owner: true })} />
              </Field>
              <Field label="Lifecycle stage" htmlFor="crm-lifecycle">
                <Select id="crm-lifecycle" value={c.lifecycle_stage} onChange={(e) => void save({ lifecycle_stage: e.target.value as Lifecycle })}>
                  {LIFECYCLES.map((l) => (
                    <option key={l} value={l}>
                      {LIFECYCLE_LABEL[l]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Company" htmlFor="crm-company">
                <CompanyPicker appId={appId} id="crm-company" disabled={!writable} value={c.company} onChange={(v) => void save(v ? { company_id: v.id } : { clear_company: true })} />
              </Field>
              {c.company && (
                <Link to={`${base}/crm/companies/${c.company.id}`} className="text-xs text-primary hover:underline">
                  Open company
                </Link>
              )}
            </fieldset>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <SectionTitle
              action={
                writable && (
                  <Button size="sm" variant="ghost" onClick={() => setNewDeal(true)}>
                    <Plus /> New deal
                  </Button>
                )
              }
            >
              Deals ({c.open_deals} open)
            </SectionTitle>
            {!deals.data?.items.length ? (
              <p className="text-sm text-muted-foreground">No deals yet.</p>
            ) : (
              <ul className="space-y-2" data-testid="contact-deals">
                {deals.data.items.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                    <Link to={`${base}/crm/deals/${d.id}`} className="min-w-0 truncate font-medium hover:underline">
                      {d.title}
                      <span className="ml-1 font-normal text-muted-foreground">· {d.stage_name}</span>
                    </Link>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="tabular-nums">{moneyCompact(d.amount, d.currency)}</span>
                      <DealStatusBadge status={d.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
      {showActivity && (
        <div className="min-w-0 lg:col-span-2">
          <RecordActivity appId={appId} target={{ contact_id: contactId }} />
        </div>
      )}
      <DealFormDialog appId={appId} open={newDeal} onOpenChange={setNewDeal} defaults={{ contact: { id: contactId, name: contactName }, company: c.company }} />
    </div>
  )
}
