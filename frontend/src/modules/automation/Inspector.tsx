import { Link } from 'react-router-dom'
import { Trash2, X } from 'lucide-react'
import { useFieldCatalog, useLists, useSegments, useTags } from '@/api/audience'
import type { FlowNode, NodeType } from '@/api/automation'
import { useSenders, useTemplates } from '@/api/email'
import { useSmsSenders, useSmsTemplates } from '@/api/sms'
import { useAudio, useCallers } from '@/api/voice'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { Checkbox } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { SegmentGroup } from '@/types/audience'
import { GroupEditor } from '../audience/SegmentBuilderPage'
import { SmsComposer } from '../sms/components'
import { NODE_META, TRIGGER_LABEL } from './meta'

type Data = Record<string, unknown>

function Missing({ what, to }: { what: string; to: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      No {what} yet.{' '}
      <Link className="font-medium text-primary hover:underline" to={to}>
        Create one
      </Link>
    </p>
  )
}

export function Inspector({
  node,
  nodes,
  issues,
  onChange,
  onDelete,
  onClose,
  readOnly,
}: {
  node: FlowNode
  nodes: FlowNode[]
  issues: string[]
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
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l bg-card" aria-label="Step settings" data-testid="inspector">
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
          <ul className="space-y-1 rounded-lg border border-danger-border bg-danger-soft p-3 text-xs text-danger-strong">
            {issues.map((i) => (
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

function Body({ type, d, set, str, appId, base, nodes, nodeId }: { type: NodeType; d: Data; set: (p: Data) => void; str: (k: string) => string; appId: string; base: string; nodes: FlowNode[]; nodeId: string }) {
  switch (type) {
    case 'trigger':
      return <TriggerForm d={d} set={set} str={str} appId={appId} base={base} />
    case 'send_email':
      return <EmailForm set={set} str={str} appId={appId} base={base} />
    case 'send_sms':
      return <SmsForm d={d} set={set} str={str} appId={appId} base={base} />
    case 'voice_call':
      return <VoiceForm d={d} set={set} str={str} appId={appId} base={base} />
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
      return <UpdateForm d={d} set={set} str={str} appId={appId} />
    default:
      return <p className="text-sm text-muted-foreground">The journey ends here for this person.</p>
  }
}

function TriggerForm({ set, str, appId, base }: { d?: Data; set: (p: Data) => void; str: (k: string) => string; appId: string; base: string }) {
  const lists = useLists(appId)
  const tags = useTags(appId)
  const segments = useSegments(appId)
  const kind = str('kind') || 'contact_created'
  return (
    <>
      <Field label="Start when" htmlFor="t-kind">
        <Select id="t-kind" value={kind} onChange={(e) => set({ kind: e.target.value })}>
          {Object.entries(TRIGGER_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      {kind === 'added_to_list' && (
        <Field label="List" htmlFor="t-list">
          <Select id="t-list" value={str('list_id')} onChange={(e) => set({ list_id: e.target.value })}>
            <option value="">Choose…</option>
            {lists.data?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {kind === 'tag_added' && (
        <Field label="Tag" htmlFor="t-tag">
          <Select id="t-tag" value={str('tag_id')} onChange={(e) => set({ tag_id: e.target.value })}>
            <option value="">Choose…</option>
            {tags.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
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
          {segments.data?.length === 0 && <Missing what="segments" to={`${base}/audience/segments/new`} />}
        </>
      )}
      <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {kind === 'segment_entered'
          ? 'Everyone in the segment when you activate is enrolled, then anyone who joins later. Checked every few seconds.'
          : 'Only events after activation start the journey. Imports and bulk actions count too.'}
      </p>
    </>
  )
}

function EmailForm({ set, str, appId, base }: { set: (p: Data) => void; str: (k: string) => string; appId: string; base: string }) {
  const senders = useSenders(appId)
  const templates = useTemplates(appId)
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
      {templates.data?.length === 0 && <Missing what="email templates" to={`${base}/email/templates`} />}
      <Field label="Subject override (optional)" htmlFor="e-subj" hint="Leave empty to use the template’s subject.">
        <Input id="e-subj" value={str('subject')} onChange={(e) => set({ subject: e.target.value })} />
      </Field>
      <p className="text-xs text-muted-foreground">Each person receives this email at most once. Consent and suppression are checked at send time.</p>
    </>
  )
}

function SmsForm({ d, set, str, appId, base }: { d: Data; set: (p: Data) => void; str: (k: string) => string; appId: string; base: string }) {
  const senders = useSmsSenders(appId)
  const templates = useSmsTemplates(appId)
  const sender = senders.data?.find((s) => s.id === str('sender_ref'))
  return (
    <>
      <Field label="Sender ID" htmlFor="s-sender">
        <Select id="s-sender" value={str('sender_ref')} onChange={(e) => set({ sender_ref: e.target.value })}>
          <option value="">Choose…</option>
          {senders.data?.map((s) => (
            <option key={s.id} value={s.id} disabled={s.status !== 'active'}>
              {s.sender_id} ({s.country}){s.status !== 'active' ? ' · not confirmed' : ''}
            </option>
          ))}
        </Select>
      </Field>
      {senders.data?.length === 0 && <Missing what="sender IDs" to={`${base}/sms/senders`} />}
      <Field label="Type" htmlFor="s-cat">
        <Select id="s-cat" value={str('category') || 'promotional'} onChange={(e) => set({ category: e.target.value })}>
          <option value="promotional">Promotional</option>
          <option value="transactional">Transactional</option>
          <option value="service">Service</option>
        </Select>
      </Field>
      <Field label={sender?.country === 'IN' ? 'DLT template' : 'Template (optional)'} htmlFor="s-tpl">
        <Select
          id="s-tpl"
          value={str('template_id')}
          onChange={(e) => {
            const t = templates.data?.find((x) => x.id === e.target.value)
            set({ template_id: e.target.value || null, body: t ? t.body : str('body') })
          }}
        >
          <option value="">{sender?.country === 'IN' ? 'Choose…' : 'Write my own'}</option>
          {templates.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.dlt_template_id ? ' · DLT' : ''}
            </option>
          ))}
        </Select>
      </Field>
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

function VoiceForm({ d, set, str, appId, base }: { d: Data; set: (p: Data) => void; str: (k: string) => string; appId: string; base: string }) {
  const callers = useCallers(appId)
  const audio = useAudio(appId)
  return (
    <>
      <Field label="Caller ID" htmlFor="v-caller">
        <Select id="v-caller" value={str('caller_ref')} onChange={(e) => set({ caller_ref: e.target.value })}>
          <option value="">Choose…</option>
          {callers.data?.map((c) => (
            <option key={c.id} value={c.id} disabled={c.status !== 'active'}>
              {c.number} ({c.country}){c.status !== 'active' ? ' · not confirmed' : ''}
            </option>
          ))}
        </Select>
      </Field>
      {callers.data?.length === 0 && <Missing what="caller IDs" to={`${base}/voice/callers`} />}
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
      {audio.data?.length === 0 && <Missing what="messages" to={`${base}/voice/audio`} />}
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

function UpdateForm({ set, str, appId }: { d: Data; set: (p: Data) => void; str: (k: string) => string; appId: string }) {
  const tags = useTags(appId)
  const lists = useLists(appId)
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
      <Field label={isTag ? 'Tag' : 'List'} htmlFor="u-target">
        <Select id="u-target" value={isTag ? str('tag_id') : str('list_id')} onChange={(e) => set(isTag ? { tag_id: e.target.value } : { list_id: e.target.value })}>
          <option value="">Choose…</option>
          {(isTag ? tags.data : lists.data)?.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </Select>
      </Field>
    </>
  )
}
