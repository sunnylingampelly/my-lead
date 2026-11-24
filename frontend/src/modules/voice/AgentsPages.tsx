/** AI calling agents: list, templates, the editor and the Test & train chat. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useBlocker, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bot,
  Copy,
  FileUp,
  MessageSquarePlus,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useAgents, useAiStatus, useVoiceOptions, voiceApi, vqk } from '@/api/voice'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, FullPageSpinner, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn, timeAgo } from '@/lib/utils'
import { formatOutcome, INTEREST, SENTIMENT } from './format'
import type { CallEvaluation, ChatMessage, OutcomeField, OutcomeFieldType, VoiceAgent, VoiceLanguage } from '@/types/voice'

const MAX_INSTRUCTIONS = 8000
const MAX_KNOWLEDGE = 60000
const FIELD_TYPES: Record<OutcomeFieldType, string> = { text: 'Text', yes_no: 'Yes / no', number: 'Number', date: 'Date', choice: 'Choice' }
function useCrumbs(label: string, extra?: { label: string; to: string }) {
  const { app, org } = useWorkspace()
  return [
    { label: org?.name ?? '' },
    { label: app!.name, to: `/apps/${app!.id}` },
    { label: 'Voice', to: `/apps/${app!.id}/voice` },
    ...(extra ? [extra] : []),
    { label },
  ]
}

// ------------------------------------------------------------------ list

export function NewAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { app } = useWorkspace()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const templates = useQuery({ queryKey: ['voice', app!.id, 'agent-templates'], queryFn: () => voiceApi(app!.id).agentTemplates(), enabled: open, staleTime: 600_000 })
  const [template, setTemplate] = useState<string>('lead_qualification')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setName('')
  }, [open])
  const options = [...(templates.data ?? []), { key: '', name: 'Start from scratch', description: 'An empty agent you teach yourself.', goal: '', outcome_fields: [] }]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New AI agent</DialogTitle>
          <DialogDescription>Start from a template: it comes with instructions and the fields to capture, which you can change.</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Template">
            {options.map((t) => (
              <button
                key={t.key || 'blank'}
                role="radio"
                aria-checked={template === t.key}
                onClick={() => setTemplate(t.key)}
                className={cn('min-w-0 rounded-lg border p-3 text-left transition', template === t.key ? 'border-primary bg-accent/40' : 'hover:bg-muted')}
              >
                <div className="text-sm font-medium">{t.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{t.description}</div>
              </button>
            ))}
          </div>
          <Field label="Agent name" htmlFor="na-name" hint="Internal, and what the agent may call itself if your instructions say so.">
            <Input id="na-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Maya – lead qualification" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!name.trim()}
            data-testid="create-agent"
            onClick={async () => {
              setBusy(true)
              try {
                const a = await voiceApi(app!.id).createAgent({ name: name.trim(), template: template || null })
                await qc.invalidateQueries({ queryKey: vqk.agents(app!.id) })
                onOpenChange(false)
                navigate(`/apps/${app!.id}/voice/agents/${a.id}`)
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Create agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function VoiceAgentsPage() {
  const { app, can } = useWorkspace()
  const q = useAgents(app!.id)
  const ai = useAiStatus(app!.id)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [del, setDel] = useState<{ id: string; name: string } | null>(null)
  const write = can('campaigns.write')
  const base = `/apps/${app!.id}/voice/agents`
  return (
    <>
      <PageHeader
        breadcrumbs={useCrumbs('AI agents')}
        title="AI agents"
        description="Agents you teach to hold real phone conversations. Use them in voice campaigns: when someone answers, the agent talks with them and the results land in your CRM."
        actions={write && <Button onClick={() => setCreating(true)} data-testid="new-agent"><Plus /> New agent</Button>}
      />
      {ai.data && !ai.data.configured && (
        <p className="mb-4 rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
          <Badge variant="secondary" className="mr-2">Simulated</Badge>
          The platform’s AI service isn’t connected yet, so test chats and simulated calls use a scripted stand-in. Everything else works the same.
        </p>
      )}
      {q.isLoading ? (
        <Card><LoadingRows /></Card>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.length ? (
        <Card>
          <EmptyState icon={Bot} title="No AI agents yet" description="Create an agent from a template (lead qualification, appointments, feedback or payment reminders), teach it about your business and try it in the browser before it calls anyone." action={write && <Button variant="outline" onClick={() => setCreating(true)}>New agent</Button>} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {q.data.map((a) => (
            <Card key={a.id} className="flex min-w-0 flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <Link to={`${base}/${a.id}`} className="min-w-0">
                    <CardTitle className="truncate text-base hover:text-primary">{a.name}</CardTitle>
                    <CardDescription className="line-clamp-2">{a.goal || 'No goal yet'}</CardDescription>
                  </Link>
                  <Badge variant={a.status === 'active' ? 'success' : 'secondary'}>{a.status === 'active' ? 'Active' : 'Draft'}</Badge>
                </div>
              </CardHeader>
              <CardContent className="mt-auto space-y-3 text-xs text-muted-foreground">
                <div>
                  {a.language} · v{a.version} · edited {timeAgo(a.updated_at)}
                </div>
                {a.used_by.length > 0 && (
                  <div className="min-w-0 truncate">
                    Used by{' '}
                    {a.used_by.slice(0, 2).map((u, i) => (
                      <span key={u.id}>
                        {i > 0 && ', '}
                        <Link className="font-medium text-primary hover:underline" to={`/apps/${app!.id}/voice/campaigns/${u.id}`}>
                          {u.name}
                        </Link>
                      </span>
                    ))}
                    {a.used_by.length > 2 && ` +${a.used_by.length - 2}`}
                  </div>
                )}
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="outline" asChild>
                    <Link to={`${base}/${a.id}`}>Open</Link>
                  </Button>
                  {write && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${a.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={async () => {
                            try {
                              const d = await voiceApi(app!.id).duplicateAgent(a.id)
                              await qc.invalidateQueries({ queryKey: vqk.agents(app!.id) })
                              navigate(`${base}/${d.id}`)
                            } catch (e) {
                              toast.error(errorMessage(e))
                            }
                          }}
                        >
                          <Copy /> Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive" onSelect={() => setDel(a)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <NewAgentDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete “${del?.name}”?`}
        description="Finished campaigns keep their call transcripts. Agents used by scheduled or running campaigns can’t be deleted."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          try {
            await voiceApi(app!.id).deleteAgent(del!.id)
            await qc.invalidateQueries({ queryKey: vqk.agents(app!.id) })
            toast.success('Agent deleted')
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

// ------------------------------------------------------------------ editor

type Draft = Pick<VoiceAgent, 'name' | 'language' | 'voice' | 'goal' | 'greeting' | 'instructions' | 'knowledge' | 'outcome_fields' | 'transfer_number' | 'max_call_minutes'>
const pick = (a: VoiceAgent): Draft => ({
  name: a.name,
  language: a.language,
  voice: a.voice,
  goal: a.goal ?? '',
  greeting: a.greeting,
  instructions: a.instructions,
  knowledge: a.knowledge ?? '',
  outcome_fields: a.outcome_fields,
  transfer_number: a.transfer_number ?? '',
  max_call_minutes: a.max_call_minutes,
})

const GOOD_EXAMPLES = [
  'You are Maya, a friendly assistant for Acme Solar. Your goal is to find out whether the person wants a free rooftop survey.',
  'Ask one question at a time. Keep answers under two sentences.',
  'If they ask about price, say a 5kW system starts at ₹2.5 lakh and the survey is free. Don’t give other prices.',
  'Don’t: pressure people, talk about competitors or promise installation dates.',
]

function OutcomeFieldsEditor({ value, onChange }: { value: OutcomeField[]; onChange: (v: OutcomeField[]) => void }) {
  const set = (i: number, p: Partial<OutcomeField>) => onChange(value.map((f, j) => (j === i ? { ...f, ...p } : f)))
  const move = (i: number, d: -1 | 1) => {
    const next = [...value]
    const [f] = next.splice(i, 1)
    next.splice(i + d, 0, f!)
    onChange(next)
  }
  const keyFrom = (label: string) =>
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'f_$1')
      .slice(0, 40) || 'field'
  return (
    <div className="space-y-3">
      {value.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Nothing extra is captured yet. Every call already gets a summary, sentiment, interest level, next step and callback time.</p>}
      {value.map((f, i) => (
        <div key={i} className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_140px_auto]" data-testid="outcome-field">
          <Field label="Label" htmlFor={`of-label-${i}`}>
            <Input
              id={`of-label-${i}`}
              value={f.label}
              maxLength={80}
              onChange={(e) => set(i, { label: e.target.value, ...(f.key === keyFrom(f.label) || !f.key ? { key: keyFrom(e.target.value) } : {}) })}
            />
          </Field>
          <Field label="Type" htmlFor={`of-type-${i}`}>
            <Select id={`of-type-${i}`} value={f.type} onChange={(e) => set(i, { type: e.target.value as OutcomeFieldType, options: e.target.value === 'choice' ? (f.options?.length ? f.options : ['', '']) : null })}>
              {Object.entries(FIELD_TYPES).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end gap-1">
            <Button size="icon" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp />
            </Button>
            <Button size="icon" variant="ghost" aria-label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown />
            </Button>
            <Button size="icon" variant="ghost" aria-label={`Remove ${f.label || 'field'}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 />
            </Button>
          </div>
          <Field label="What to listen for (optional)" htmlFor={`of-desc-${i}`} className="sm:col-span-3">
            <Input id={`of-desc-${i}`} value={f.description ?? ''} maxLength={300} onChange={(e) => set(i, { description: e.target.value })} placeholder="e.g. The budget they mention, in rupees" />
          </Field>
          {f.type === 'choice' && (
            <Field label="Options (comma separated)" htmlFor={`of-opt-${i}`} className="sm:col-span-3">
              <Input id={`of-opt-${i}`} value={(f.options ?? []).join(', ')} onChange={(e) => set(i, { options: e.target.value.split(',').map((x) => x.trimStart()) })} placeholder="This month, Later, Not sure" />
            </Field>
          )}
          <div className="text-xs text-muted-foreground sm:col-span-3">
            Key: <code>{f.key || '—'}</code>
          </div>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...value, { key: '', label: '', type: 'text', options: null, description: '' }])} data-testid="add-outcome-field">
        <Plus /> Add a field
      </Button>
    </div>
  )
}

function TestPanel({ agent, dirty, save, onAddRule }: { agent: VoiceAgent; dirty: boolean; save: () => Promise<boolean>; onAddRule: (rule: string) => void }) {
  const { app } = useWorkspace()
  const ai = useAiStatus(app!.id)
  const api = voiceApi(app!.id)
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [ended, setEnded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [simulated, setSimulated] = useState(false)
  const [evalBusy, setEvalBusy] = useState(false)
  const [evaluation, setEvaluation] = useState<CallEvaluation | null>(null)
  const [rule, setRule] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const ask = async (history: ChatMessage[]) => {
    setBusy(true)
    try {
      if (dirty && !(await save())) return
      const r = await api.testAgent(agent.id, history)
      setSimulated(r.simulated)
      setMsgs([...history, { role: 'assistant', content: r.reply }])
      setEnded(r.end_call || r.transfer)
      if (r.error) toast.error(r.error)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const restart = () => {
    setMsgs([])
    setEnded(false)
    setEvaluation(null)
    void ask([])
  }
  useEffect(() => {
    void ask([]) // the agent speaks first
  }, [agent.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect must not return one.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [msgs])
  const send = () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const history = [...msgs, { role: 'user' as const, content: text }]
    setMsgs(history)
    void ask(history)
  }
  return (
    <Card className="min-w-0" data-testid="test-panel">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4" /> Test &amp; train
          </CardTitle>
          <div className="flex items-center gap-2">
            {(simulated || (ai.data && !ai.data.configured)) && <Badge variant="secondary" data-testid="simulated-badge">Simulated</Badge>}
            <Button size="sm" variant="ghost" onClick={restart} disabled={busy}>
              <RotateCcw /> Restart conversation
            </Button>
          </div>
        </div>
        <CardDescription>You play the customer. Nothing is called and no credit is used.{dirty && ' Unsaved changes are saved before each reply.'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-h-[420px] min-h-[200px] space-y-2 overflow-y-auto rounded-lg bg-muted/40 p-3" aria-live="polite" data-testid="chat">
          {msgs.map((m, i) => (
            <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={cn('max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm', m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-card shadow-sm ring-1 ring-border')}
                data-testid={m.role === 'user' ? 'chat-user' : 'chat-agent'}
              >
                {m.content}
              </div>
            </div>
          ))}
          {busy && <div className="text-xs text-muted-foreground">The agent is replying…</div>}
          {ended && <div className="text-center text-xs text-muted-foreground" data-testid="call-ended">The agent ended the call.</div>}
          <div ref={endRef} />
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <Input className="min-w-0" value={input} disabled={ended} onChange={(e) => setInput(e.target.value)} placeholder={ended ? 'Restart to try again' : 'Reply as the customer…'} aria-label="Your reply" />
          <Button type="submit" size="icon" disabled={!input.trim() || busy || ended} aria-label="Send">
            <Send />
          </Button>
        </form>
        <Button
          variant="outline"
          className="w-full"
          loading={evalBusy}
          disabled={!msgs.some((m) => m.role === 'user')}
          data-testid="evaluate"
          onClick={async () => {
            setEvalBusy(true)
            try {
              setEvaluation(await api.evaluateAgent(agent.id, msgs))
            } catch (e) {
              toast.error(errorMessage(e))
            } finally {
              setEvalBusy(false)
            }
          }}
        >
          See what would be captured
        </Button>
        {evaluation && (
          <div className="space-y-2 rounded-lg border p-3 text-sm" data-testid="evaluation">
            <p>{evaluation.summary}</p>
            <div className="flex flex-wrap gap-1.5">
              {evaluation.interest && <Badge variant={INTEREST[evaluation.interest]?.variant ?? 'secondary'}>Interest: {INTEREST[evaluation.interest]?.label ?? evaluation.interest}</Badge>}
              {evaluation.sentiment && <Badge variant={SENTIMENT[evaluation.sentiment]?.variant ?? 'secondary'}>{SENTIMENT[evaluation.sentiment]?.label ?? evaluation.sentiment}</Badge>}
              {evaluation.do_not_call && <Badge variant="destructive">Do not call</Badge>}
            </div>
            {evaluation.next_step && <p className="text-xs text-muted-foreground">Next step: {evaluation.next_step}</p>}
            {evaluation.callback_requested_at && <p className="text-xs text-muted-foreground">Call back: {new Date(evaluation.callback_requested_at).toLocaleString()}</p>}
            <dl className="divide-y text-xs">
              {agent.outcome_fields.map((f) => (
                <div key={f.key} className="flex justify-between gap-3 py-1.5">
                  <dt className="text-muted-foreground">{f.label}</dt>
                  <dd className="min-w-0 truncate text-right font-medium">{formatOutcome(evaluation.outcomes[f.key], f.type)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        <div className="space-y-1.5 border-t pt-3">
          <label htmlFor="add-rule" className="flex items-center gap-1.5 text-sm font-medium">
            <MessageSquarePlus className="size-4" /> Add this as a rule
          </label>
          <p className="text-xs text-muted-foreground">Didn’t like a reply? Write what the agent should do instead. It’s added to the instructions.</p>
          <div className="flex gap-2">
            <Input id="add-rule" className="min-w-0" value={rule} maxLength={300} onChange={(e) => setRule(e.target.value)} placeholder="e.g. Always offer the free site survey before ending" />
            <Button
              variant="outline"
              disabled={!rule.trim()}
              data-testid="add-rule-button"
              onClick={() => {
                onAddRule(rule.trim())
                setRule('')
                toast.success('Rule added to the instructions. Save to keep it.')
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function VoiceAgentEditorPage() {
  const { agentId } = useParams()
  const { app, can } = useWorkspace()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const options = useVoiceOptions(app!.id)
  const q = useQuery({ queryKey: vqk.agent(app!.id, agentId!), queryFn: () => voiceApi(app!.id).agent(agentId!) })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const write = can('campaigns.write')
  useEffect(() => {
    if (q.data && !draft) setDraft(pick(q.data))
  }, [q.data, draft])
  const dirty = useMemo(() => !!(q.data && draft && JSON.stringify(pick(q.data)) !== JSON.stringify(draft)), [q.data, draft])
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname)
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])
  const crumbs = useCrumbs(q.data?.name ?? 'Agent', { label: 'AI agents', to: `/apps/${app!.id}/voice/agents` })

  if (q.isLoading || (q.data && !draft)) return <FullPageSpinner />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const agent = q.data!
  const d = draft!
  const set = (p: Partial<Draft>) => setDraft({ ...d, ...p })

  const save = async (): Promise<boolean> => {
    setSaving(true)
    setErrors(null)
    try {
      const body = {
        ...d,
        goal: d.goal || null,
        knowledge: d.knowledge || null,
        transfer_number: d.transfer_number || null,
        outcome_fields: d.outcome_fields.map((f) => ({ ...f, options: f.type === 'choice' ? (f.options ?? []).map((o) => o.trim()).filter(Boolean) : null })),
      }
      const saved = await voiceApi(app!.id).updateAgent(agent.id, body)
      qc.setQueryData(vqk.agent(app!.id, agent.id), saved)
      setDraft(pick(saved))
      await qc.invalidateQueries({ queryKey: vqk.agents(app!.id) })
      return true
    } catch (e) {
      setErrors(errorMessage(e))
      toast.error(errorMessage(e))
      return false
    } finally {
      setSaving(false)
    }
  }
  const toggle = async () => {
    try {
      if (dirty && !(await save())) return
      const out = agent.status === 'active' ? await voiceApi(app!.id).deactivateAgent(agent.id) : await voiceApi(app!.id).activateAgent(agent.id)
      qc.setQueryData(vqk.agent(app!.id, agent.id), out)
      await qc.invalidateQueries({ queryKey: vqk.agents(app!.id) })
      toast.success(out.status === 'active' ? 'Agent activated' : 'Agent switched off')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={d.name || 'Untitled agent'}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={agent.status === 'active' ? 'success' : 'secondary'} data-testid="agent-status">{agent.status === 'active' ? 'Active' : 'Draft'}</Badge>
            <span>Version {agent.version}</span>
            {dirty && <span className="text-warning-strong">Unsaved changes</span>}
          </span>
        }
        actions={
          write && (
            <>
              <Button variant="outline" onClick={toggle} data-testid="toggle-agent">
                {agent.status === 'active' ? 'Switch off' : 'Activate'}
              </Button>
              <Button loading={saving} disabled={!dirty} onClick={() => void save()} data-testid="save-agent">
                Save
              </Button>
            </>
          )
        }
      />
      {agent.used_by.length > 0 && (
        <p className="mb-4 text-sm text-muted-foreground">
          Used by:{' '}
          {agent.used_by.map((u, i) => (
            <span key={u.id}>
              {i > 0 && ', '}
              <Link className="font-medium text-primary hover:underline" to={`/apps/${app!.id}/voice/campaigns/${u.id}`}>
                {u.name}
              </Link>{' '}
              <span className="text-xs">({u.status})</span>
            </span>
          ))}
          . Running campaigns keep the version they started with.
        </p>
      )}
      {errors && <p role="alert" className="mb-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-strong">{errors}</p>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card className="min-w-0">
          <CardContent className="pt-4">
            <Tabs defaultValue="behavior">
              <div className="overflow-x-auto">
                <TabsList className="min-w-max">
                  <TabsTrigger value="behavior">Behavior</TabsTrigger>
                  <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
                  <TabsTrigger value="capture">What to capture</TabsTrigger>
                  <TabsTrigger value="voice">Voice &amp; language</TabsTrigger>
                  <TabsTrigger value="handoff">Handoff &amp; limits</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="behavior" className="space-y-4">
                <Field label="Name" htmlFor="ag-name">
                  <Input id="ag-name" value={d.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} disabled={!write} />
                </Field>
                <Field label="Goal" htmlFor="ag-goal" hint="One sentence: what a successful call achieves.">
                  <Input id="ag-goal" value={d.goal ?? ''} maxLength={300} onChange={(e) => set({ goal: e.target.value })} disabled={!write} placeholder="Book a free site survey with interested homeowners" />
                </Field>
                <Field label="Greeting" htmlFor="ag-greeting" hint="The first sentence, spoken as soon as they answer. Say who is calling. {{first_name}} and {{business_name}} are filled in.">
                  <Textarea id="ag-greeting" rows={2} value={d.greeting} maxLength={500} onChange={(e) => set({ greeting: e.target.value })} disabled={!write} />
                </Field>
                <Field label="Instructions" htmlFor="ag-instructions" hint={`${d.instructions.length.toLocaleString()} / ${MAX_INSTRUCTIONS.toLocaleString()} characters. Role, tone, goal, what to ask, do’s and don’ts.`}>
                  <Textarea id="ag-instructions" rows={12} value={d.instructions} maxLength={MAX_INSTRUCTIONS} onChange={(e) => set({ instructions: e.target.value })} disabled={!write} className="font-mono text-xs" />
                </Field>
                <details className="rounded-lg bg-muted/50 p-3 text-sm">
                  <summary className="cursor-pointer font-medium">Examples of good instructions</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                    {GOOD_EXAMPLES.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">The platform always adds safety rules: the agent says it’s an AI if asked, never asks for card numbers or OTPs, stops when someone asks not to be called, and doesn’t make up facts.</p>
                </details>
              </TabsContent>
              <TabsContent value="knowledge" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">Products, prices, FAQs and policies the agent may use. It won’t invent anything that isn’t here.</p>
                  {write && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                        <FileUp /> Upload .txt or .md
                      </Button>
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".txt,.md,text/plain,text/markdown"
                        className="hidden"
                        data-testid="knowledge-file"
                        onChange={async (e) => {
                          const f = e.target.files?.[0]
                          e.target.value = ''
                          if (!f) return
                          const text = await f.text()
                          const next = (d.knowledge ? `${d.knowledge}\n\n` : '') + text
                          if (next.length > MAX_KNOWLEDGE) toast.error(`That would be ${next.length.toLocaleString()} characters; the limit is ${MAX_KNOWLEDGE.toLocaleString()}.`)
                          else set({ knowledge: next })
                        }}
                      />
                    </>
                  )}
                </div>
                <Textarea id="ag-knowledge" aria-label="Knowledge" rows={18} value={d.knowledge ?? ''} maxLength={MAX_KNOWLEDGE} onChange={(e) => set({ knowledge: e.target.value })} disabled={!write} className="font-mono text-xs" />
                <p className={cn('text-right text-xs', (d.knowledge ?? '').length > MAX_KNOWLEDGE * 0.9 ? 'text-warning-strong' : 'text-muted-foreground')} data-testid="knowledge-count">
                  {(d.knowledge ?? '').length.toLocaleString()} / {MAX_KNOWLEDGE.toLocaleString()} characters
                </p>
              </TabsContent>
              <TabsContent value="capture" className="space-y-3">
                <p className="text-sm text-muted-foreground">After each call the conversation is reviewed and these fields are filled in, then saved on the call and the contact’s CRM timeline.</p>
                <OutcomeFieldsEditor value={d.outcome_fields} onChange={(v) => set({ outcome_fields: v })} />
              </TabsContent>
              <TabsContent value="voice" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Language" htmlFor="ag-lang" hint="What the agent speaks and understands.">
                  <Select id="ag-lang" value={d.language} onChange={(e) => set({ language: e.target.value as VoiceLanguage })} disabled={!write}>
                    {Object.entries(options.data?.languages ?? { 'en-IN': 'English (India)', 'en-US': 'English (US)' }).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Voice" htmlFor="ag-voice">
                  <Select id="ag-voice" value={d.voice} onChange={(e) => set({ voice: e.target.value as 'female' | 'male' })} disabled={!write}>
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                  </Select>
                </Field>
              </TabsContent>
              <TabsContent value="handoff" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Transfer to a person (optional)" htmlFor="ag-transfer" hint="If someone asks for a human, the agent connects them to this number. Leave empty to offer a call back instead.">
                  <Input id="ag-transfer" value={d.transfer_number ?? ''} maxLength={20} onChange={(e) => set({ transfer_number: e.target.value })} disabled={!write} placeholder="+91 98765 43210" />
                </Field>
                <Field label="Longest call" htmlFor="ag-max" hint="The agent wraps up politely when time runs out. AI calls are charged per started minute.">
                  <Select id="ag-max" value={d.max_call_minutes} onChange={(e) => set({ max_call_minutes: Number(e.target.value) })} disabled={!write}>
                    {[2, 3, 5, 8, 10, 15].map((m) => (
                      <option key={m} value={m}>
                        {m} minutes
                      </option>
                    ))}
                  </Select>
                </Field>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
        <div className="min-w-0 xl:sticky xl:top-20 xl:h-fit">
          {write ? (
            <TestPanel agent={agent} dirty={dirty} save={save} onAddRule={(r) => set({ instructions: `${d.instructions.trimEnd()}\n- ${r}` })} />
          ) : (
            <Card>
              <CardContent className="pt-6 text-sm text-muted-foreground">You can view this agent. Ask an editor to test or change it.</CardContent>
            </Card>
          )}
        </div>
      </div>
      <div className="mt-6">
        <Button variant="ghost" onClick={() => navigate(`/apps/${app!.id}/voice/agents`)}>
          <ArrowLeft /> All agents
        </Button>
      </div>
      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(o) => !o && blocker.state === 'blocked' && blocker.reset()}
        title="Leave without saving?"
        description="Your changes to this agent haven’t been saved."
        confirmLabel="Leave"
        destructive
        onConfirm={() => blocker.state === 'blocked' && blocker.proceed()}
      />
    </>
  )
}
