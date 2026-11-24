import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, ExternalLink, Info, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { aqk, audienceApi, useFieldCatalog, useLists, useSegments, useTags } from '@/api/audience'
import type { FlowNode, NodeType } from '@/api/automation'
import { errorMessage } from '@/api/client'
import { useCampaigns, useSenders, useTemplates } from '@/api/email'
import { useSmsSenders, useSmsTemplates } from '@/api/sms'
import { useAudio, useVoiceCampaigns } from '@/api/voice'
import { useForms } from '@/api/forms'
import { useBots } from '@/api/chat'
import { useAssignmentRules, useCrmSettings, useCrmTeam, usePipelines, useScoringRules } from '@/api/crm'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { Checkbox } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn } from '@/lib/utils'
import type { SegmentGroup } from '@/types/audience'
import { GroupEditor } from '../audience/SegmentBuilderPage'
import { SmsComposer } from '../sms/components'
import { CRM_ACTION_LABEL, CRM_TRIGGERS, DEAL_TRIGGERS, ENGAGEMENT_TRIGGERS, NODE_META, TRIGGER_LABEL } from './meta'

type Data = Record<string, unknown>

/** A prerequisite created on another page: opens it in a new tab (the builder keeps your edits) and refreshes the options here. */
function CreateElsewhere({ what, to, onRefresh, refreshing, empty = true }: { what: string; to: string; onRefresh: () => void; refreshing?: boolean; empty?: boolean }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="create-elsewhere">
      {empty ? `No ${what} yet.` : `Need another ${what.replace(/s$/, '')}?`}
      <a className="inline-flex items-center gap-1 font-medium text-primary hover:underline" href={to} target="_blank" rel="noreferrer">
        Create one <ExternalLink className="size-3" />
      </a>
      <button type="button" onClick={onRefresh} className="inline-flex items-center gap-1 font-medium text-primary hover:underline" aria-label={`Refresh ${what}`}>
        <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} /> Refresh
      </button>
    </p>
  )
}

/** Create a tag or list without leaving the builder. */
function InlineCreate({ kind, appId, onCreated }: { kind: 'tag' | 'list'; appId: string; onCreated: (id: string) => void }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  if (!open)
    return (
      <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" onClick={() => setOpen(true)}>
        <Plus className="size-3" /> New {kind}
      </button>
    )
  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const api = audienceApi(appId)
      const created = kind === 'tag' ? await api.createTag({ name: name.trim() }) : await api.createList({ name: name.trim() })
      await qc.invalidateQueries({ queryKey: kind === 'tag' ? aqk.tags(appId) : aqk.lists(appId) })
      onCreated(created.id)
      toast.success(`${kind === 'tag' ? 'Tag' : 'List'} “${name.trim()}” created`)
      setOpen(false)
      setName('')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        autoFocus
        aria-label={`New ${kind} name`}
        placeholder={kind === 'tag' ? 'Tag name' : 'List name'}
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            create()
          }
          if (e.key === 'Escape') setOpen(false)
        }}
        className="h-8"
      />
      <Button type="button" size="sm" loading={busy} onClick={create}>
        Create
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  )
}

function Note({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: React.ReactNode }) {
  const Icon = tone === 'warn' ? AlertTriangle : Info
  return (
    <div className={cn('flex gap-2 rounded-md px-3 py-2 text-xs', tone === 'warn' ? 'border border-warning-border bg-warning-soft text-warning-strong' : 'bg-muted/50 text-muted-foreground')}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="space-y-1">{children}</div>
    </div>
  )
}

const NewTab = ({ to, children }: { to: string; children: React.ReactNode }) => (
  <a className="inline-flex items-center gap-1 font-medium text-primary hover:underline" href={to} target="_blank" rel="noreferrer">
    {children} <ExternalLink className="size-3" />
  </a>
)

export function Inspector({
  node,
  nodes,
  issues,
  warnings = [],
  onChange,
  onDelete,
  onClose,
  readOnly,
}: {
  node: FlowNode
  nodes: FlowNode[]
  issues: string[]
  warnings?: string[]
  onChange: (data: Data) => void
  onDelete: () => void
  onClose: () => void
  readOnly: boolean
}) {
  const { app } = useWorkspace()
  const id = app!.id
  const d = node.data
  const set = (patch: Data) => onChange({ ...d, ...patch })
  const meta = NODE_META[node.type]
  const Icon = meta.icon
  const base = `/apps/${id}`
  const str = (k: string) => (d[k] as string | undefined) ?? ''

  return (
    <aside
      className={cn(
        // Bottom sheet on small screens, side panel from md up.
        'fixed inset-x-0 bottom-0 z-30 flex max-h-[72vh] w-full flex-col rounded-t-2xl border-t bg-card shadow-pop',
        'md:static md:z-auto md:h-full md:max-h-none md:w-[340px] md:shrink-0 md:rounded-none md:border-l md:border-t-0 md:shadow-none',
      )}
      aria-label="Step settings"
      data-testid="inspector"
    >
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <span className={`flex size-7 items-center justify-center rounded-md ${meta.tone}`}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{meta.label}</div>
          <div className="text-xs text-muted-foreground">{meta.description}</div>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close settings" onClick={onClose}>
          <X />
        </Button>
      </div>
      <fieldset disabled={readOnly} className="flex-1 space-y-4 overflow-y-auto p-4">
        {issues.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-danger-border bg-danger-soft p-3 text-xs text-danger-strong" data-testid="inspector-issues">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        {warnings.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-warning-border bg-warning-soft p-3 text-xs text-warning-strong" data-testid="inspector-warnings">
            {warnings.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        {node.type !== 'trigger' && node.type !== 'end' && (
          <Field label="Step name (optional)" htmlFor="n-label">
            <Input id="n-label" value={str('label')} onChange={(e) => set({ label: e.target.value })} maxLength={80} />
          </Field>
        )}
        <Body type={node.type} d={d} set={set} str={str} appId={id} base={base} nodes={nodes} nodeId={node.id} />
      </fieldset>
      {node.type !== 'trigger' && !readOnly && (
        <div className="border-t p-3">
          <Button variant="outline" className="w-full text-destructive" onClick={onDelete}>
            <Trash2 /> Delete step
          </Button>
        </div>
      )}
    </aside>
  )
}

type FormProps = { d: Data; set: (p: Data) => void; str: (k: string) => string; appId: string; base: string }

function Body({ type, d, set, str, appId, base, nodes, nodeId }: FormProps & { type: NodeType; nodes: FlowNode[]; nodeId: string }) {
  const p = { d, set, str, appId, base }
  switch (type) {
    case 'trigger':
      return <TriggerForm {...p} />
    case 'send_email':
      return <EmailForm {...p} />
    case 'send_sms':
      return <SmsForm {...p} />
    case 'voice_call':
      return <VoiceForm {...p} />
    case 'wait':
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Wait for" htmlFor="w-amount">
            <Input id="w-amount" type="number" min={1} value={String(d.amount ?? 1)} onChange={(e) => set({ amount: Number(e.target.value) })} />
          </Field>
          <Field label="Unit" htmlFor="w-unit">
            <Select id="w-unit" value={str('unit') || 'days'} onChange={(e) => set({ unit: e.target.value })}>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </Select>
          </Field>
        </div>
      )
    case 'condition':
      return <ConditionForm d={d} set={set} str={str} appId={appId} nodes={nodes} nodeId={nodeId} />
    case 'split':
      return (
        <Field label="Share of people on path A" htmlFor="s-pct" hint={`Path B gets the remaining ${100 - Number(d.percent_a ?? 50)}%. Each person is assigned at random.`}>
          <div className="flex items-center gap-3">
            <input id="s-pct" type="range" min={1} max={99} value={Number(d.percent_a ?? 50)} onChange={(e) => set({ percent_a: Number(e.target.value) })} className="flex-1 accent-[hsl(var(--primary))]" />
            <span className="w-12 text-right text-sm tabular-nums">{Number(d.percent_a ?? 50)}%</span>
          </div>
        </Field>
      )
    case 'update_contact':
      return <UpdateForm {...p} />
    case 'crm_action':
      return <CrmActionForm {...p} />
    default:
      return <p className="text-sm text-muted-foreground">The journey ends here for this person.</p>
  }
}

function TagPicker({ id, label, value, onChange, appId }: { id: string; label: string; value: string; onChange: (v: string) => void; appId: string }) {
  const tags = useTags(appId)
  return (
    <Field label={label} htmlFor={id} action={<InlineCreate kind="tag" appId={appId} onCreated={onChange} />}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{tags.data?.length === 0 ? 'No tags yet: create one' : 'Choose…'}</option>
        {tags.data?.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
    </Field>
  )
}

function ListPicker({ id, label, value, onChange, appId }: { id: string; label: string; value: string; onChange: (v: string) => void; appId: string }) {
  const lists = useLists(appId)
  return (
    <Field label={label} htmlFor={id} action={<InlineCreate kind="list" appId={appId} onCreated={onChange} />}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{lists.data?.length === 0 ? 'No lists yet: create one' : 'Choose…'}</option>
        {lists.data?.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </Select>
    </Field>
  )
}

function TriggerForm({ set, str, appId, base }: FormProps) {
  const segments = useSegments(appId)
  const kind = str('kind') || 'contact_created'
  const audience = Object.keys(TRIGGER_LABEL).filter((k) => !CRM_TRIGGERS.includes(k) && !ENGAGEMENT_TRIGGERS.includes(k))
  return (
    <>
      <Field label="Start when" htmlFor="t-kind">
        <Select id="t-kind" value={kind} onChange={(e) => set({ kind: e.target.value, pipeline_id: null, stage_id: null })}>
          {(
            [
              ['Audience', audience],
              ['Engagement', ENGAGEMENT_TRIGGERS],
              ['CRM', CRM_TRIGGERS],
            ] as const
          ).map(([group, keys]) => (
            <optgroup key={group} label={group}>
              {keys.map((k) => (
                <option key={k} value={k}>
                  {TRIGGER_LABEL[k]}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      {DEAL_TRIGGERS.includes(kind) && <PipelineStagePicker appId={appId} str={str} set={set} withStage={kind === 'deal_stage_changed'} optional />}
      {kind === 'added_to_list' && <ListPicker id="t-list" label="List" value={str('list_id')} onChange={(v) => set({ list_id: v })} appId={appId} />}
      {kind === 'tag_added' && <TagPicker id="t-tag" label="Tag" value={str('tag_id')} onChange={(v) => set({ tag_id: v })} appId={appId} />}
      {kind === 'segment_entered' && (
        <>
          <Field label="Segment" htmlFor="t-seg">
            <Select id="t-seg" value={str('segment_id')} onChange={(e) => set({ segment_id: e.target.value })}>
              <option value="">Choose…</option>
              {segments.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <CreateElsewhere what="segments" empty={segments.data?.length === 0} to={`${base}/audience/segments/new`} onRefresh={() => segments.refetch()} refreshing={segments.isFetching} />
        </>
      )}
      {kind === 'sms_replied' && (
        <Field label="Keyword (optional)" htmlFor="t-keyword" hint="Only replies whose first word matches, e.g. YES. Leave empty for any reply. STOP, START and HELP are handled automatically.">
          <Input id="t-keyword" value={str('keyword')} maxLength={20} onChange={(e) => set({ keyword: e.target.value.trim() })} placeholder="Any reply" />
        </Field>
      )}
      {kind === 'email_clicked' && <CampaignPicker channel="email" appId={appId} value={str('campaign_id')} onChange={(v) => set({ campaign_id: v || null })} />}
      {kind === 'call_answered' && <CampaignPicker channel="voice" appId={appId} value={str('campaign_id')} onChange={(v) => set({ campaign_id: v || null })} />}
      {kind === 'unsubscribed' && (
        <Field label="Channel" htmlFor="t-channel">
          <Select id="t-channel" value={str('channel')} onChange={(e) => set({ channel: e.target.value || null })}>
            <option value="">Any channel</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="voice">Calls</option>
          </Select>
        </Field>
      )}
      {(kind === 'score_reached' || kind === 'sla_breached') && <CrmTriggerPrereq kind={kind} appId={appId} base={base} />}
      {kind === 'form_submitted' && <FormTriggerPicker appId={appId} base={base} value={str('form_id')} onChange={(v) => set({ form_id: v || null })} />}
      {(kind === 'chat_lead_captured' || kind === 'chat_conversation_closed') && <ChatBotPicker appId={appId} value={str('bot_id')} onChange={(v) => set({ bot_id: v || null })} />}
      {kind === 'chat_conversation_closed' && (
        <Field label="Lead quality (AI summary)" htmlFor="t-quality">
          <Select id="t-quality" value={str('lead_quality')} onChange={(e) => set({ lead_quality: e.target.value || null })}>
            <option value="">Any</option>
            <option value="hot">Hot</option>
            <option value="warm">Warm</option>
            <option value="cold">Cold</option>
          </Select>
        </Field>
      )}
      {kind === 'ai_call_completed' && (
        <Field label="Interest" htmlFor="t-interest">
          <Select id="t-interest" value={str('interest')} onChange={(e) => set({ interest: e.target.value || null })}>
            <option value="">Any outcome</option>
            <option value="hot">Hot</option>
            <option value="warm">Warm</option>
            <option value="cold">Cold</option>
            <option value="not_interested">Not interested</option>
          </Select>
        </Field>
      )}
      <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {CRM_TRIGGERS.includes(kind)
          ? 'Starts for the contact linked to the event (for deals, the primary contact). Events without a contact are skipped.'
          : kind === 'segment_entered'
            ? 'Everyone in the segment when you activate is enrolled, then anyone who joins later. Checked every few seconds.'
            : kind === 'sms_replied'
              ? 'Replies are matched to contacts by phone number. Only replies after activation count.'
              : kind === 'unsubscribed'
                ? 'Starts when someone withdraws consent. Messages on that channel will no longer reach them; use this to update records or alert the team.'
                : kind === 'form_submitted'
                  ? 'Starts for each submission after activation, for the contact the submission creates or updates.'
                  : 'Only events after activation start the journey. Imports and bulk actions count too. You can also enroll people manually once it is active.'}
      </p>
    </>
  )
}

function ChatBotPicker({ appId, value, onChange }: { appId: string; value: string; onChange: (v: string) => void }) {
  const bots = useBots(appId)
  return (
    <Field label="Chatbot" htmlFor="t-bot">
      <Select id="t-bot" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Any chatbot</option>
        {bots.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </Select>
    </Field>
  )
}

function FormTriggerPicker({ appId, base, value, onChange }: { appId: string; base: string; value: string; onChange: (v: string) => void }) {
  const { can } = useWorkspace()
  const forms = useForms(appId, can('forms.read'))
  return (
    <>
      <Field label="Which form" htmlFor="t-form" hint="Leave as “Any form” to start on every lead form in this application.">
        <Select id="t-form" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Any form</option>
          {forms.data?.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      </Field>
      {forms.data?.length === 0 && <CreateElsewhere what="forms" to={`${base}/forms`} onRefresh={() => forms.refetch()} refreshing={forms.isFetching} />}
    </>
  )
}

function CampaignPicker({ channel, appId, value, onChange }: { channel: 'email' | 'voice'; appId: string; value: string; onChange: (v: string) => void }) {
  const email = useCampaigns(appId, { page: 1, page_size: 100 })
  const voice = useVoiceCampaigns(appId, { page: 1, page_size: 100 })
  const items = (channel === 'email' ? email.data?.items : voice.data?.items) as { id: string; name: string }[] | undefined
  return (
    <Field label={channel === 'email' ? 'Campaign (optional)' : 'Call campaign (optional)'} htmlFor="t-campaign" hint="Leave as “any” to include messages sent by workflows too.">
      <Select id="t-campaign" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{channel === 'email' ? 'Any email' : 'Any call'}</option>
        {items?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
    </Field>
  )
}

function CrmTriggerPrereq({ kind, appId, base }: { kind: string; appId: string; base: string }) {
  const settings = useCrmSettings(appId)
  const rules = useScoringRules(appId)
  const s = settings.data
  const refresh = (
    <button type="button" className="inline-flex items-center gap-1 font-medium text-primary hover:underline" onClick={() => { settings.refetch(); rules.refetch() }}>
      <RefreshCw className={cn('size-3', (settings.isFetching || rules.isFetching) && 'animate-spin')} /> Refresh
    </button>
  )
  if (!s) return null
  if (kind === 'score_reached') {
    const none = rules.data && rules.data.filter((r) => r.active !== false).length === 0
    return (
      <Note tone={none ? 'warn' : 'info'}>
        <p data-testid="hot-threshold">
          A lead becomes hot at a score of <strong>{s.hot_score_threshold}</strong>.
        </p>
        {none && <p>No lead scoring rules yet, so no one can become hot.</p>}
        <p className="flex flex-wrap gap-3">
          <NewTab to={`${base}/crm/settings`}>{none ? 'Add scoring rules' : 'Change in CRM settings'}</NewTab>
          {refresh}
        </p>
      </Note>
    )
  }
  return (
    <Note tone={s.sla_enabled ? 'info' : 'warn'}>
      <p data-testid="sla-state">
        {s.sla_enabled ? (
          <>
            First-response SLA is on: <strong>{s.sla_minutes} minutes</strong>.
          </>
        ) : (
          'The first-response SLA is off in CRM settings, so this trigger can never fire. Turn it on first.'
        )}
      </p>
      <p className="flex flex-wrap gap-3">
        <NewTab to={`${base}/crm/settings`}>{s.sla_enabled ? 'Change in CRM settings' : 'Turn on in CRM settings'}</NewTab>
        {refresh}
      </p>
    </Note>
  )
}

function EmailForm({ set, str, appId, base }: FormProps) {
  const senders = useSenders(appId)
  const templates = useTemplates(appId)
  const noVerified = senders.data && !senders.data.some((s) => s.status === 'verified')
  return (
    <>
      <Field label="From" htmlFor="e-sender">
        <Select id="e-sender" value={str('sender_id')} onChange={(e) => set({ sender_id: e.target.value })}>
          <option value="">Choose a sender…</option>
          {senders.data?.map((s) => (
            <option key={s.id} value={s.id} disabled={s.status !== 'verified'}>
              {s.from_name} &lt;{s.from_email}&gt;{s.status !== 'verified' ? ' (not verified)' : ''}
            </option>
          ))}
        </Select>
      </Field>
      {noVerified && <CreateElsewhere what="verified senders" to={`${base}/email/senders`} onRefresh={() => senders.refetch()} refreshing={senders.isFetching} />}
      <Field label="Email template" htmlFor="e-tpl">
        <Select id="e-tpl" value={str('template_id')} onChange={(e) => set({ template_id: e.target.value })}>
          <option value="">Choose a template…</option>
          {templates.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <CreateElsewhere what="email templates" empty={templates.data?.length === 0} to={`${base}/email/templates`} onRefresh={() => templates.refetch()} refreshing={templates.isFetching} />
      <Field label="Subject override (optional)" htmlFor="e-subj" hint="Leave empty to use the template’s subject.">
        <Input id="e-subj" value={str('subject')} onChange={(e) => set({ subject: e.target.value })} />
      </Field>
      <p className="text-xs text-muted-foreground">Each person receives this email at most once. Consent and suppression are checked at send time.</p>
    </>
  )
}

function SmsForm({ d, set, str, appId, base }: FormProps) {
  const { app } = useWorkspace()
  const senders = useSmsSenders(appId)
  const templates = useSmsTemplates(appId)
  const sender = senders.data?.find((s) => s.id === str('sender_ref'))
  const india = sender ? sender.country === 'IN' : (app?.default_country ?? 'IN') === 'IN'
  const tpl = templates.data?.find((t) => t.id === str('template_id'))
  return (
    <>
      {india && (
        <Note>
          <p>
            <strong>India (DLT):</strong> every SMS must use a DLT-approved sender ID and match a DLT-registered template exactly. Choose a template that has a DLT ID{tpl ? '' : ' below'}; free text is blocked by operators.
          </p>
          {tpl && <p data-testid="dlt-required">DLT template required: {tpl.dlt_template_id ? <strong>{tpl.dlt_template_id}</strong> : <span className="text-warning-strong">this template has no DLT ID yet</span>}</p>}
        </Note>
      )}
      <Field label="Sender ID" htmlFor="s-sender">
        <Select id="s-sender" value={str('sender_ref')} onChange={(e) => set({ sender_ref: e.target.value })}>
          <option value="">Choose…</option>
          {senders.data?.map((s) => (
            <option key={s.id} value={s.id} disabled={s.status !== 'active'}>
              {s.sender_id} ({s.country}){s.status !== 'active' ? ' · inactive' : ''}
            </option>
          ))}
        </Select>
      </Field>
      <CreateElsewhere what="sender IDs" empty={senders.data?.length === 0} to={`${base}/sms/senders`} onRefresh={() => senders.refetch()} refreshing={senders.isFetching} />
      <Field label="Type" htmlFor="s-cat">
        <Select id="s-cat" value={str('category') || 'promotional'} onChange={(e) => set({ category: e.target.value })}>
          <option value="promotional">Promotional</option>
          <option value="transactional">Transactional</option>
          <option value="service">Service</option>
        </Select>
      </Field>
      <Field label={india ? 'DLT template' : 'Template (optional)'} htmlFor="s-tpl">
        <Select
          id="s-tpl"
          value={str('template_id')}
          onChange={(e) => {
            const t = templates.data?.find((x) => x.id === e.target.value)
            set({ template_id: e.target.value || null, body: t ? t.body : str('body') })
          }}
        >
          <option value="">{india ? 'Choose…' : 'Write my own'}</option>
          {templates.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.dlt_template_id ? ` · DLT ${t.dlt_template_id}` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <CreateElsewhere what="SMS templates" empty={templates.data?.length === 0} to={`${base}/sms/templates`} onRefresh={() => templates.refetch()} refreshing={templates.isFetching} />
      <Field label="Message" htmlFor="s-body">
        <SmsComposer id="s-body" appId={appId} value={str('body')} onChange={(v) => set({ body: v })} />
      </Field>
      {sender?.country === 'US' && str('category') !== 'transactional' && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={d.append_opt_out !== false} onChange={(e) => set({ append_opt_out: e.target.checked })} aria-label="Add opt-out text" />
          Add “Reply STOP to opt out”
        </label>
      )}
    </>
  )
}

function VoiceForm({ d, set, str, appId, base }: FormProps) {
  const audio = useAudio(appId)
  return (
    <>
      <p className="text-xs text-muted-foreground">Calls come from a number Signalcraft manages for the contact’s country.</p>
      <Field label="Message" htmlFor="v-audio">
        <Select id="v-audio" value={str('audio_id')} onChange={(e) => set({ audio_id: e.target.value })}>
          <option value="">Choose…</option>
          {audio.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.kind === 'tts' ? 'text to speech' : 'recording'})
            </option>
          ))}
        </Select>
      </Field>
      <CreateElsewhere what="messages" empty={audio.data?.length === 0} to={`${base}/voice/audio`} onRefresh={() => audio.refetch()} refreshing={audio.isFetching} />
      <Field label="Type" htmlFor="v-cat">
        <Select id="v-cat" value={str('category') || 'promotional'} onChange={(e) => set({ category: e.target.value })}>
          <option value="promotional">Promotional</option>
          <option value="transactional">Transactional</option>
          <option value="service">Service</option>
        </Select>
      </Field>
      <Field label="Introduction" htmlFor="v-intro" hint="Say who is calling. Required for US marketing calls.">
        <Input id="v-intro" value={str('intro_text')} onChange={(e) => set({ intro_text: e.target.value })} placeholder="Hello, this is a call from …" />
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={d.opt_out_keypress !== false} onChange={(e) => set({ opt_out_keypress: e.target.checked })} aria-label="Press 9 to opt out" />
        Offer “press 9 to stop these calls”
      </label>
    </>
  )
}

function ConditionForm({ d, set, str, appId, nodes, nodeId }: { d: Data; set: (p: Data) => void; str: (k: string) => string; appId: string; nodes: FlowNode[]; nodeId: string }) {
  const catalog = useFieldCatalog(appId)
  const kind = str('kind') || 'engagement'
  const sends = nodes.filter((n) => n.id !== nodeId && ['send_email', 'send_sms', 'voice_call'].includes(n.type))
  const src = nodes.find((n) => n.id === str('node_id'))
  const events: Record<string, [string, string][]> = {
    send_email: [['delivered', 'was delivered'], ['opened', 'was opened'], ['clicked', 'was clicked']],
    send_sms: [['delivered', 'was delivered']],
    voice_call: [['answered', 'was answered by a person'], ['delivered', 'connected (person or voicemail)']],
  }
  const rules = (d.rules as SegmentGroup | undefined) ?? { type: 'group', match: 'all', conditions: [{ type: 'condition', field: 'city', operator: 'is', value: '' }] }
  return (
    <>
      <Field label="Check" htmlFor="c-kind">
        <Select id="c-kind" value={kind} onChange={(e) => set({ kind: e.target.value })}>
          <option value="engagement">How they responded to an earlier step</option>
          <option value="rules">Contact details, tags or lists</option>
        </Select>
      </Field>
      {kind === 'engagement' ? (
        <>
          <Field label="Earlier step" htmlFor="c-node">
            <Select id="c-node" value={str('node_id')} onChange={(e) => set({ node_id: e.target.value })}>
              <option value="">Choose…</option>
              {sends.map((n) => (
                <option key={n.id} value={n.id}>
                  {(n.data.label as string) || NODE_META[n.type].label}
                </option>
              ))}
            </Select>
          </Field>
          {src && (
            <Field label="Yes when the message" htmlFor="c-event">
              <Select id="c-event" value={str('event')} onChange={(e) => set({ event: e.target.value })}>
                <option value="">Choose…</option>
                {events[src.type]?.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <p className="text-xs text-muted-foreground">Put a wait before this step so people have time to respond. Email opens are approximate.</p>
        </>
      ) : catalog.data ? (
        <GroupEditor group={rules} catalog={catalog.data} onChange={(g) => set({ rules: g })} depth={0} />
      ) : null}
    </>
  )
}

function UpdateForm({ set, str, appId }: FormProps) {
  const action = str('action') || 'add_tag'
  const isTag = action.endsWith('tag')
  return (
    <>
      <Field label="Change" htmlFor="u-action">
        <Select id="u-action" value={action} onChange={(e) => set({ action: e.target.value })}>
          <option value="add_tag">Add a tag</option>
          <option value="remove_tag">Remove a tag</option>
          <option value="add_to_list">Add to a list</option>
          <option value="remove_from_list">Remove from a list</option>
        </Select>
      </Field>
      {isTag ? (
        <TagPicker id="u-target" label="Tag" value={str('tag_id')} onChange={(v) => set({ tag_id: v })} appId={appId} />
      ) : (
        <ListPicker id="u-target" label="List" value={str('list_id')} onChange={(v) => set({ list_id: v })} appId={appId} />
      )}
    </>
  )
}

function PipelineStagePicker({ appId, str, set, withStage, optional, stageKinds }: { appId: string; str: (k: string) => string; set: (p: Data) => void; withStage: boolean; optional?: boolean; stageKinds?: string[] }) {
  const pipelines = usePipelines(appId)
  const p = pipelines.data?.find((x) => x.id === str('pipeline_id'))
  return (
    <>
      <Field label={optional ? 'Pipeline (optional)' : 'Pipeline'} htmlFor="crm-pipeline">
        <Select id="crm-pipeline" value={str('pipeline_id')} onChange={(e) => set({ pipeline_id: e.target.value || null, stage_id: null })}>
          <option value="">{optional ? 'Any pipeline' : 'Default pipeline'}</option>
          {pipelines.data?.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </Select>
      </Field>
      {withStage && p && (
        <Field label={optional ? 'Stage (optional)' : 'Stage'} htmlFor="crm-stage">
          <Select id="crm-stage" value={str('stage_id')} onChange={(e) => set({ stage_id: e.target.value || null })}>
            <option value="">{optional ? 'Any stage' : 'First stage'}</option>
            {p.stages
              .filter((st) => !stageKinds || stageKinds.includes(st.kind))
              .map((st) => (
                <option key={st.id} value={st.id}>
                  {st.name}
                </option>
              ))}
          </Select>
        </Field>
      )}
    </>
  )
}

function CrmActionForm({ d, set, str, appId, base }: FormProps) {
  const team = useCrmTeam(appId)
  const rules = useAssignmentRules(appId)
  const pipelines = usePipelines(appId)
  const action = str('action') || 'create_task'
  const byRule = d.rule_id !== undefined && d.rule_id !== null
  const fallback = d.fallback_rule_id ? 'rule' : d.fallback_user_id ? 'user' : d.fallback_user_id === '' ? 'user' : d.fallback_rule_id === '' ? 'rule' : 'none'
  return (
    <>
      <Field label="Action" htmlFor="crm-action">
        <Select id="crm-action" value={action} onChange={(e) => set({ action: e.target.value })}>
          {Object.entries(CRM_ACTION_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      {action === 'create_deal' && (
        <>
          <Field label="Deal title" htmlFor="crm-deal-title" hint="Use {{name}} for the contact's name.">
            <Input id="crm-deal-title" value={str('title')} maxLength={200} onChange={(e) => set({ title: e.target.value })} placeholder="{{name}} deal" />
          </Field>
          <PipelineStagePicker appId={appId} str={str} set={set} withStage stageKinds={['open']} />
          <Field label="Amount (optional)" htmlFor="crm-amount">
            <Input id="crm-amount" type="number" min={0} value={str('amount')} onChange={(e) => set({ amount: e.target.value === '' ? null : Number(e.target.value) })} />
          </Field>
          <p className="text-xs text-muted-foreground">Skipped when the contact already has an open deal in that pipeline.</p>
        </>
      )}
      {action === 'create_task' && (
        <>
          <Field label="Task title" htmlFor="crm-task-title" hint="Use {{name}} for the contact's name. Assigned to the contact's owner.">
            <Input id="crm-task-title" value={str('title')} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type" htmlFor="crm-task-type">
              <Select id="crm-task-type" value={str('task_type') || 'follow_up'} onChange={(e) => set({ task_type: e.target.value })}>
                <option value="call">Call</option>
                <option value="email">Email</option>
                <option value="meeting">Meeting</option>
                <option value="follow_up">Follow up</option>
                <option value="todo">To-do</option>
              </Select>
            </Field>
            <Field label="Priority" htmlFor="crm-task-priority">
              <Select id="crm-task-priority" value={str('priority') || 'normal'} onChange={(e) => set({ priority: e.target.value })}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </Select>
            </Field>
          </div>
          <Field label="Due in (hours)" htmlFor="crm-task-due">
            <Input id="crm-task-due" type="number" min={0} max={2160} value={String(d.due_in_hours ?? 24)} onChange={(e) => set({ due_in_hours: Number(e.target.value) })} />
          </Field>
          <Field label="If the contact has no owner" htmlFor="crm-fallback">
            <Select
              id="crm-fallback"
              value={fallback}
              onChange={(e) => set(e.target.value === 'user' ? { fallback_user_id: '', fallback_rule_id: null } : e.target.value === 'rule' ? { fallback_rule_id: '', fallback_user_id: null } : { fallback_user_id: null, fallback_rule_id: null })}
            >
              <option value="none">Leave the task unassigned</option>
              <option value="user">Assign to a team member</option>
              <option value="rule">Assign by an assignment rule’s rotation</option>
            </Select>
          </Field>
          {fallback === 'user' && (
            <Field label="Fallback assignee" htmlFor="crm-fallback-user">
              <Select id="crm-fallback-user" value={str('fallback_user_id')} onChange={(e) => set({ fallback_user_id: e.target.value })}>
                <option value="">Choose…</option>
                {team.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {fallback === 'rule' && (
            <>
              <Field label="Fallback rule" htmlFor="crm-fallback-rule">
                <Select id="crm-fallback-rule" value={str('fallback_rule_id')} onChange={(e) => set({ fallback_rule_id: e.target.value })}>
                  <option value="">Choose…</option>
                  {rules.data?.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <CreateElsewhere what="assignment rules" empty={rules.data?.length === 0} to={`${base}/crm/settings`} onRefresh={() => rules.refetch()} refreshing={rules.isFetching} />
            </>
          )}
        </>
      )}
      {action === 'assign_owner' && (
        <>
          <Field label="Assign using" htmlFor="crm-assign-mode">
            <Select id="crm-assign-mode" value={byRule ? 'rule' : 'user'} onChange={(e) => set(e.target.value === 'rule' ? { rule_id: '', user_id: null } : { rule_id: null, user_id: '' })}>
              <option value="user">A specific person</option>
              <option value="rule">An assignment rule's rotation</option>
            </Select>
          </Field>
          {byRule ? (
            <>
              <Field label="Assignment rule" htmlFor="crm-rule">
                <Select id="crm-rule" value={str('rule_id')} onChange={(e) => set({ rule_id: e.target.value })}>
                  <option value="">Choose…</option>
                  {rules.data?.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <CreateElsewhere what="assignment rules" empty={rules.data?.length === 0} to={`${base}/crm/settings`} onRefresh={() => rules.refetch()} refreshing={rules.isFetching} />
            </>
          ) : (
            <Field label="Owner" htmlFor="crm-user">
              <Select id="crm-user" value={str('user_id')} onChange={(e) => set({ user_id: e.target.value })}>
                <option value="">Choose…</option>
                {team.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </>
      )}
      {action === 'move_deal' && (
        <Field label="Move to stage" htmlFor="crm-move-stage" hint="Moves the contact's newest open deal in that stage's pipeline.">
          <Select id="crm-move-stage" value={str('stage_id')} onChange={(e) => set({ stage_id: e.target.value })}>
            <option value="">Choose…</option>
            {pipelines.data?.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {p.stages
                  .filter((st) => st.kind !== 'lost')
                  .map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
        </Field>
      )}
      {action === 'set_lifecycle' && (
        <Field label="Lifecycle stage" htmlFor="crm-lifecycle">
          <Select id="crm-lifecycle" value={str('lifecycle_stage')} onChange={(e) => set({ lifecycle_stage: e.target.value })}>
            <option value="">Choose…</option>
            <option value="subscriber">Subscriber</option>
            <option value="lead">Lead</option>
            <option value="mql">Marketing qualified</option>
            <option value="sql">Sales qualified</option>
            <option value="opportunity">Opportunity</option>
            <option value="customer">Customer</option>
            <option value="other">Other</option>
          </Select>
        </Field>
      )}
    </>
  )
}
