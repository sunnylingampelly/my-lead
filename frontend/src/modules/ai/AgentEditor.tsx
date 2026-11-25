import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Hand, Zap } from 'lucide-react'
import { aiApi, aiqk, useAgentTemplates, useAiTools, useSlackChannels, useSlackStatus } from '@/api/ai'
import { useBots } from '@/api/chat'
import { errorMessage } from '@/api/client'
import { useCrmTeam } from '@/api/crm'
import { useForms } from '@/api/forms'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Checkbox } from '@/components/audience'
import { cn } from '@/lib/utils'
import type { Agent, AgentConfig, AgentTrigger } from '@/types/ai'
import { BLANK_AGENT } from './lib'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

const BLANK = BLANK_AGENT

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

/** Create or edit an agent: what starts it, what it may do (and whether it asks first), and where it reports. */
export function AgentEditor({
  appId,
  open,
  onOpenChange,
  initial,
  agent,
  onSaved,
}: {
  appId: string
  open: boolean
  onOpenChange: (o: boolean) => void
  initial: AgentConfig
  agent?: Agent
  onSaved?: (a: Agent) => void
}) {
  const [cfg, setCfg] = useState<AgentConfig>(() => ({ ...BLANK, ...initial, destinations: { ...BLANK.destinations, ...initial.destinations } }))
  const [saving, setSaving] = useState(false)
  const qc = useQueryClient()
  const meta = useAgentTemplates(appId)
  const tools = useAiTools(appId)
  const slack = useSlackStatus(appId)
  const channels = useSlackChannels(appId, !!slack.data?.connected)
  const team = useCrmTeam(appId)
  const forms = useForms(appId)
  const bots = useBots(appId)
  const set = (patch: Partial<AgentConfig>) => setCfg((c) => ({ ...c, ...patch }))
  const t = cfg.trigger
  const setTrigger = (patch: Partial<AgentTrigger> | AgentTrigger) => set({ trigger: { ...t, ...patch } as AgentTrigger })
  const events = meta.data?.events ?? []
  const evSel = t.type === 'event' ? t.events : []
  const filters = (t.type === 'event' ? t.filters : undefined) ?? {}
  const hasWrite = useMemo(() => cfg.allowed_tools.some((n) => tools.data?.find((x) => x.name === n)?.kind === 'write'), [cfg.allowed_tools, tools.data])

  const save = async () => {
    setSaving(true)
    try {
      const body = { ...cfg }
      delete body.simulated
      const a = agent ? await aiApi(appId).updateAgent(agent.id, body) : await aiApi(appId).createAgent(body)
      qc.invalidateQueries({ queryKey: aiqk.all(appId) })
      toast.success(agent ? 'Agent saved' : 'Agent created. Switch it on when you’re ready.')
      onOpenChange(false)
      onSaved?.(a)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const toggleTool = (name: string, on: boolean) => set({ allowed_tools: on ? [...cfg.allowed_tools, name] : cfg.allowed_tools.filter((n) => n !== name) })
  const selectedChannels = cfg.destinations.slack_channels ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] max-w-2xl flex-col gap-0 p-0" data-testid="agent-editor">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>{agent ? `Edit ${agent.name}` : 'New AI agent'}</DialogTitle>
          <DialogDescription>Agents run with your permissions and only use the tools you allow.</DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {cfg.simulated && (
            <p className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning-strong">
              Simulation mode: this draft was picked from the closest template. With an OpenAI key, the AI writes the configuration from your description.
            </p>
          )}
          <Section title="Basics">
            <Field label="Name" htmlFor="ag-name">
              <Input id="ag-name" value={cfg.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} data-testid="agent-name" />
            </Field>
            <Field label="Instructions" htmlFor="ag-ins" hint="What the agent should do, step by step, and what its report should contain.">
              <Textarea id="ag-ins" value={cfg.instructions} onChange={(e) => set({ instructions: e.target.value })} maxLength={4000} className="min-h-[110px]" />
            </Field>
          </Section>

          <Section title="What starts it">
            <div className="inline-flex rounded-lg border p-0.5" role="radiogroup" aria-label="Trigger type">
              {(['event', 'schedule'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={t.type === k}
                  onClick={() => set({ trigger: k === 'event' ? { type: 'event', events: ['form_submitted'], filters: {} } : { type: 'schedule', every: 'daily', time: '09:00' } })}
                  className={cn('rounded-md px-3 py-1 text-sm', t.type === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  {k === 'event' ? 'When something happens' : 'On a schedule'}
                </button>
              ))}
            </div>
            {t.type === 'event' ? (
              <div className="space-y-3">
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {events.map((ev) => (
                    <label key={ev.key} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                      <Checkbox
                        checked={evSel.includes(ev.key)}
                        onChange={(e) => setTrigger({ type: 'event', events: e.target.checked ? [...evSel, ev.key] : evSel.filter((x) => x !== ev.key), filters })}
                      />
                      {ev.label}
                    </label>
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {evSel.includes('form_submitted') && (
                    <Field label="Only for form" htmlFor="ag-form">
                      <Select id="ag-form" value={(filters.form_id as string) ?? ''} onChange={(e) => setTrigger({ type: 'event', events: evSel, filters: { ...filters, form_id: e.target.value || undefined } })}>
                        <option value="">Any form</option>
                        {forms.data?.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {(evSel.includes('chat_lead_captured') || evSel.includes('chat_conversation_closed')) && (
                    <Field label="Only for chatbot" htmlFor="ag-bot">
                      <Select id="ag-bot" value={(filters.bot_id as string) ?? ''} onChange={(e) => setTrigger({ type: 'event', events: evSel, filters: { ...filters, bot_id: e.target.value || undefined } })}>
                        <option value="">Any chatbot</option>
                        {bots.data?.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {evSel.includes('ai_call_completed') && (
                    <Field label="AI call interest" htmlFor="ag-int">
                      <Select id="ag-int" value={(filters.interest as string) ?? ''} onChange={(e) => setTrigger({ type: 'event', events: evSel, filters: { ...filters, interest: e.target.value || undefined } })}>
                        <option value="">Any outcome</option>
                        <option value="hot">Hot</option>
                        <option value="warm">Warm</option>
                        <option value="cold">Cold</option>
                        <option value="not_interested">Not interested</option>
                      </Select>
                    </Field>
                  )}
                  {evSel.includes('campaign_completed') && (
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={!!filters.failed_only} onChange={(e) => setTrigger({ type: 'event', events: evSel, filters: { ...filters, failed_only: e.target.checked } })} />
                      Only campaigns with many failures
                    </label>
                  )}
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Repeat" htmlFor="ag-every">
                  <Select id="ag-every" value={t.every} onChange={(e) => setTrigger({ type: 'schedule', every: e.target.value as 'daily', time: t.time ?? '09:00', day: t.day ?? 0, hours: t.hours ?? 4 })}>
                    <option value="daily">Every day</option>
                    <option value="weekly">Every week</option>
                    <option value="hours">Every few hours</option>
                  </Select>
                </Field>
                {t.every === 'weekly' && (
                  <Field label="Day" htmlFor="ag-day">
                    <Select id="ag-day" value={String(t.day ?? 0)} onChange={(e) => setTrigger({ ...t, day: Number(e.target.value) })}>
                      {DAYS.map((d, i) => (
                        <option key={d} value={i}>
                          {d}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                {t.every === 'hours' ? (
                  <Field label="Every (hours)" htmlFor="ag-hours">
                    <Input id="ag-hours" type="number" min={1} max={168} value={String(t.hours ?? 4)} onChange={(e) => setTrigger({ ...t, hours: Number(e.target.value) })} />
                  </Field>
                ) : (
                  <Field label="At" htmlFor="ag-time" hint="In the application's time zone">
                    <Input id="ag-time" type="time" value={t.time ?? '09:00'} onChange={(e) => setTrigger({ ...t, time: e.target.value })} />
                  </Field>
                )}
              </div>
            )}
          </Section>

          <Section title="What it may do" hint="Read tools look things up. Write tools change data; nothing can send campaigns, delete, spend or change roles.">
            <div className="grid gap-1.5 sm:grid-cols-2">
              {tools.data?.map((tool) => (
                <label key={tool.name} className={cn('flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-sm', !tool.allowed && 'opacity-50')} title={tool.description}>
                  <Checkbox className="mt-0.5" checked={cfg.allowed_tools.includes(tool.name)} disabled={!tool.allowed} onChange={(e) => toggleTool(tool.name, e.target.checked)} />
                  <span className="min-w-0">
                    <span className="block">{tool.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{tool.kind === 'write' ? 'Changes data' : 'Read only'}{!tool.allowed && ' · your role can’t use this'}</span>
                  </span>
                </label>
              ))}
            </div>
            {hasWrite && (
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Mode">
                {([
                  ['approve', Hand, 'Ask for approval', 'Changes wait in Approvals (and Slack) until someone approves them.'],
                  ['auto', Zap, 'Act on its own', 'Changes happen right away, as you.'],
                ] as const).map(([k, Icon, label, hint]) => (
                  <button key={k} type="button" role="radio" aria-checked={cfg.mode === k} onClick={() => set({ mode: k })} className={cn('flex gap-2 rounded-lg border p-3 text-left', cfg.mode === k ? 'border-primary ring-2 ring-primary/20' : 'hover:border-primary/40')}>
                    <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                    <span>
                      <span className="block text-sm font-medium">{label}</span>
                      <span className="block text-xs text-muted-foreground">{hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section title="Where it reports">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={cfg.destinations.in_app} onChange={(e) => set({ destinations: { ...cfg.destinations, in_app: e.target.checked } })} />
              In-app notification to me
            </label>
            {slack.data?.connected ? (
              <div className="space-y-1.5">
                <div className="text-xs font-medium">Slack channels {slack.data.simulated && <span className="text-muted-foreground">(simulated)</span>}</div>
                <div className="flex flex-wrap gap-1.5">
                  {channels.data?.map((ch) => {
                    const on = selectedChannels.some((c) => c.id === ch.id)
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => set({ destinations: { ...cfg.destinations, slack_channels: on ? selectedChannels.filter((c) => c.id !== ch.id) : [...selectedChannels, { id: ch.id, name: ch.name }] } })}
                        className={cn('rounded-full border px-2.5 py-0.5 text-xs', on ? 'border-primary bg-primary text-primary-foreground' : 'hover:border-primary/50')}
                        data-testid={`slack-channel-${ch.name}`}
                      >
                        #{ch.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                <Link to={`/apps/${appId}/ai/integrations`} className="font-medium text-primary hover:underline" onClick={() => onOpenChange(false)}>
                  Connect Slack
                </Link>{' '}
                to post reports and approval requests to a channel.
              </p>
            )}
            {team.data && team.data.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium">Email the report to</div>
                <div className="flex flex-wrap gap-1.5">
                  {team.data.map((u) => {
                    const on = cfg.destinations.email_user_ids.includes(u.id)
                    return (
                      <button
                        key={u.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => set({ destinations: { ...cfg.destinations, email_user_ids: on ? cfg.destinations.email_user_ids.filter((x) => x !== u.id) : [...cfg.destinations.email_user_ids, u.id] } })}
                        className={cn('rounded-full border px-2.5 py-0.5 text-xs', on ? 'border-primary bg-primary text-primary-foreground' : 'hover:border-primary/50')}
                      >
                        {u.full_name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </Section>
        </div>
        <DialogFooter className="border-t px-6 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!cfg.name.trim() || !cfg.allowed_tools.length} data-testid="agent-save">
            {agent ? 'Save' : 'Create agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "Describe what you want": the AI drafts a configuration for review in the editor. */
export function DescribeDialog({ appId, open, onOpenChange, onDraft }: { appId: string; open: boolean; onOpenChange: (o: boolean) => void; onDraft: (c: AgentConfig) => void }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      const cfg = await aiApi(appId).draft(prompt)
      onOpenChange(false)
      setPrompt('')
      onDraft(cfg)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Describe what you want</DialogTitle>
          <DialogDescription>The AI drafts the agent; you review and edit it before anything is saved.</DialogDescription>
        </DialogHeader>
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Every Friday at 4 pm, send the sales team a summary of deals that moved stage this week…" className="min-h-[120px]" maxLength={2000} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={go} loading={busy} disabled={prompt.trim().length < 3}>
            Draft agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
