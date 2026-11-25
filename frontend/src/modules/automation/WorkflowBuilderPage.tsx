import '@xyflow/react/dist/style.css'
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  addEdge,
  Background,
  type Connection,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import { AlertTriangle, ArrowLeft, BarChart3, CheckCircle2, Cloud, CloudOff, FlaskConical, Loader2, MoreHorizontal, Pause, Play, Plus, Rocket, Settings2, UserPlus } from 'lucide-react'
import { automationApi, type FlowEdge, type FlowNode, type NodeType, type Workflow, useWorkflow, useWorkflowStats, wqk } from '@/api/automation'
import { useLists, useSegments, useTags } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { useSenders, useTemplates } from '@/api/email'
import { useSmsSenders, useSmsTemplates } from '@/api/sms'
import { useAudio } from '@/api/voice'
import { useAssignmentRules, useCrmTeam, usePipelines } from '@/api/crm'
import { ErrorState, FullPageSpinner } from '@/components/page'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Sheet } from '@/components/ui/sheet'
import { Tooltip } from '@/components/ui/tooltip'
import { Checkbox } from '@/components/audience'
import { useTheme } from '@/hooks/useTheme'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn } from '@/lib/utils'
import { EnrollDialog, SettingsDialog, TestDialog } from './BuilderDialogs'
import { BuilderContext, type BuilderView } from './context'
import { FlowNodeCard } from './FlowNodeCard'
import { Inspector } from './Inspector'
import { COMING_SOON_STEPS, CRM_ACTION_LABEL, DEFAULT_DATA, NODE_META, newId, TRIGGER_LABEL } from './meta'
import { RunsPanel, WorkflowStatusBadge } from './RunsPanel'

const nodeTypes = Object.fromEntries(Object.keys(NODE_META).map((k) => [k, FlowNodeCard]))
const PALETTE: NodeType[] = ['send_email', 'send_sms', 'voice_call', 'wait', 'condition', 'split', 'update_contact', 'crm_action', 'ai_step', 'slack_message', 'end']
const UNTITLED = 'Untitled workflow'
const HISTORY = 30

// Branch outputs are labelled on the node's handles (Yes / No, A / B), so edges carry no second label.
const toFlow = (n: FlowNode): Node => ({ ...n, deletable: n.type !== 'trigger' })
const toEdge = (e: FlowEdge): Edge => ({ ...e, sourceHandle: e.sourceHandle ?? undefined, animated: false })
const fromFlow = (nodes: Node[], edges: Edge[]) => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.type as NodeType, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: n.data })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
})

function useSummaries(appId: string) {
  const senders = useSenders(appId)
  const templates = useTemplates(appId)
  const smsSenders = useSmsSenders(appId)
  const audio = useAudio(appId)
  const lists = useLists(appId)
  const tags = useTags(appId)
  const segments = useSegments(appId)
  useSmsTemplates(appId)
  const pipelines = usePipelines(appId, true)
  const team = useCrmTeam(appId)
  const rules = useAssignmentRules(appId)
  return useCallback(
    (_id: string, type: NodeType, d: Record<string, unknown>): string => {
      const name = <T extends { id: string }>(xs: T[] | undefined, id: unknown, f: (x: T) => string) => {
        const x = xs?.find((y) => y.id === id)
        return x ? f(x) : ''
      }
      switch (type) {
        case 'trigger': {
          const k = (d.kind as string) || 'contact_created'
          const stage = pipelines.data?.flatMap((p) => p.stages).find((st) => st.id === d.stage_id)
          const target =
            k === 'added_to_list'
              ? name(lists.data, d.list_id, (l) => l.name)
              : k === 'tag_added'
                ? name(tags.data, d.tag_id, (t) => t.name)
                : k === 'segment_entered'
                  ? name(segments.data, d.segment_id, (s) => s.name)
                  : k === 'sms_replied'
                    ? ((d.keyword as string) || '').toUpperCase()
                    : k === 'unsubscribed'
                      ? ((d.channel as string) || '')
                      : [name(pipelines.data, d.pipeline_id, (p) => p.name), stage?.name].filter(Boolean).join(' → ')
          return `${TRIGGER_LABEL[k] ?? k}${target ? `: ${target}` : ''}`
        }
        case 'send_email':
          return name(templates.data, d.template_id, (t) => t.name) || 'Choose a template'
        case 'send_sms': {
          const s = name(smsSenders.data, d.sender_ref, (x) => x.sender_id)
          const body = (d.body as string) || ''
          return [s, body.slice(0, 40)].filter(Boolean).join(' · ') || 'Write the message'
        }
        case 'voice_call':
          return name(audio.data, d.audio_id, (a) => a.name) || 'Choose a message'
        case 'wait':
          return `Wait ${d.amount ?? 1} ${d.unit ?? 'days'}`
        case 'condition':
          return d.kind === 'rules' ? 'Contact matches rules' : d.event ? `If the earlier message ${d.event === 'answered' ? 'was answered' : `was ${d.event}`}` : 'Choose what to check'
        case 'split':
          return `${d.percent_a ?? 50}% A · ${100 - Number(d.percent_a ?? 50)}% B`
        case 'update_contact': {
          const a = (d.action as string) || 'add_tag'
          const target = a.endsWith('tag') ? name(tags.data, d.tag_id, (t) => t.name) : name(lists.data, d.list_id, (l) => l.name)
          return `${{ add_tag: 'Add tag', remove_tag: 'Remove tag', add_to_list: 'Add to list', remove_from_list: 'Remove from list' }[a]}${target ? `: ${target}` : ''}`
        }
        case 'crm_action': {
          const a = (d.action as string) || 'create_task'
          const stageName = pipelines.data?.flatMap((p) => p.stages).find((st) => st.id === d.stage_id)?.name
          const detail =
            a === 'create_task' || a === 'create_deal'
              ? (d.title as string) || ''
              : a === 'assign_owner'
                ? d.rule_id
                  ? `rule ${name(rules.data, d.rule_id, (r) => r.name)}`
                  : name(team.data, d.user_id, (u) => u.full_name)
                : a === 'move_deal'
                  ? (stageName ?? '')
                  : a === 'set_lifecycle'
                    ? String(d.lifecycle_stage ?? '')
                    : ''
          return `${CRM_ACTION_LABEL[a] ?? 'CRM action'}${detail ? `: ${detail}` : ''}`
        }
        case 'ai_step': {
          const mode = (d.mode as string) || 'classify'
          return `${mode[0]!.toUpperCase()}${mode.slice(1)}${d.output_field ? ` → ${d.output_field as string}` : ': choose a field'}`
        }
        case 'slack_message':
          return d.channel_name ? `#${d.channel_name as string}` : 'Choose a channel'
        default:
          return 'Journey ends'
      }
    },
    [senders.data, templates.data, smsSenders.data, audio.data, lists.data, tags.data, segments.data, pipelines.data, team.data, rules.data], // eslint-disable-line react-hooks/exhaustive-deps
  )
}

function Palette({ disabled, onAdd, onPicked }: { disabled: boolean; onAdd: (t: NodeType) => void; onPicked?: () => void }) {
  return (
    <>
      {(['Messages', 'Flow', 'Contact', 'CRM', 'AI'] as const).map((group) => (
        <div key={group}>
          <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group}</div>
          <div className="space-y-1">
            {PALETTE.filter((t) => NODE_META[t].group === group).map((t) => {
              const m = NODE_META[t]
              const Icon = m.icon
              // SMS is coming soon in every market: shown, but it can't be added.
              const soon = COMING_SOON_STEPS.includes(t)
              if (soon)
                return (
                  <div key={t} className="flex w-full cursor-not-allowed items-center gap-2 rounded-lg border border-dashed bg-muted/30 px-2 py-1.5 text-left text-sm opacity-70" aria-disabled="true" data-testid={`step-soon-${t}`}>
                    <span className={cn('flex size-6 items-center justify-center rounded-md', m.tone)}>
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium">{m.label}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{m.description}</span>
                    </span>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">Coming soon</Badge>
                  </div>
                )
              return (
                <button
                  key={t}
                  draggable={!disabled}
                  disabled={disabled}
                  onDragStart={(e) => e.dataTransfer.setData('application/x-step', t)}
                  onClick={() => {
                    onAdd(t)
                    onPicked?.()
                  }}
                  className="flex w-full items-center gap-2 rounded-lg border bg-background px-2 py-1.5 text-left text-sm transition hover:border-primary/50 hover:bg-accent/40 disabled:opacity-50"
                  aria-label={`Add ${m.label}`}
                >
                  <span className={cn('flex size-6 items-center justify-center rounded-md', m.tone)}>
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{m.label}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{m.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </>
  )
}

function Builder() {
  const { workflowId } = useParams()
  const { app, can } = useWorkspace()
  const appId = app!.id
  const api = automationApi(appId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { resolved } = useTheme()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'enrollments' ? 'enrollments' : 'builder'
  const q = useWorkflow(appId, workflowId!)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [showStats, setShowStats] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'publish' | 'archive' | 'pause' | null>(null)
  const [dialog, setDialog] = useState<'test' | 'enroll' | 'settings' | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [activateName, setActivateName] = useState('')
  const loaded = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const savedKey = useRef<string | null>(null)
  const latestKey = useRef<string | null>(null)
  const saving = useRef<Promise<void> | null>(null)
  const history = useRef<string[]>([])
  const stableKey = useRef<string | null>(null)
  const restoring = useRef(false)
  const { screenToFlowPosition, fitView, setCenter, getZoom, getNode } = useReactFlow()
  const summary = useSummaries(appId)
  const writable = can('automation.write')
  const w = q.data
  const editable = writable && !!w && w.status !== 'archived'

  const focusNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })))
      setSelected(id)
      const n = getNode(id)
      if (n) setCenter(n.position.x + 130, n.position.y + 40, { zoom: Math.max(getZoom(), 0.9), duration: 400 })
    },
    [setNodes, getNode, setCenter, getZoom],
  )

  useEffect(() => {
    if (w && !loaded.current) {
      loaded.current = true
      const key = JSON.stringify(fromFlow(w.graph.nodes.map(toFlow), w.graph.edges.map(toEdge)))
      savedKey.current = key
      stableKey.current = key
      setNodes(w.graph.nodes.map(toFlow))
      setEdges(w.graph.edges.map(toEdge))
      setName(w.name)
      const target = params.get('node')
      setTimeout(() => {
        if (target && w.graph.nodes.some((n) => n.id === target)) focusNode(target)
        else fitView({ padding: 0.3, maxZoom: 1 })
      }, 80)
    }
  }, [w, setNodes, setEdges, fitView]) // eslint-disable-line react-hooks/exhaustive-deps

  const graphKey = useMemo(() => JSON.stringify(fromFlow(nodes, edges)), [nodes, edges])
  latestKey.current = graphKey

  /** Save the latest graph now (if it changed). Safe to call repeatedly; used before leaving or testing. */
  const saveNow = useCallback(async () => {
    window.clearTimeout(timer.current)
    const key = latestKey.current
    if (!loaded.current || !w || !key || key === savedKey.current || !editable) return
    if (saving.current) await saving.current
    if (key === savedKey.current) return
    setSaveState('saving')
    const p = (async () => {
      try {
        const saved = await api.update(w.id, { graph: JSON.parse(key) })
        savedKey.current = key
        qc.setQueryData(wqk.one(appId, w.id), saved)
        qc.invalidateQueries({ queryKey: wqk.validate(appId, w.id) })
        setSaveState('saved')
      } catch (e) {
        setSaveState('error')
        toast.error(errorMessage(e))
      }
    })()
    saving.current = p
    await p
    saving.current = null
  }, [w, editable, api, qc, appId])
  const saveRef = useRef(saveNow)
  saveRef.current = saveNow

  useEffect(() => {
    if (!loaded.current || !w || savedKey.current === null) return
    if (savedKey.current === graphKey || !editable) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => saveRef.current(), 900)
    // No cleanup here: a pending save must not be dropped. Unmount flushes it below.
  }, [graphKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the builder (route change, back button, link) saves immediately instead of dropping the edit.
  useEffect(() => () => void saveRef.current(), [])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (latestKey.current && savedKey.current !== null && latestKey.current !== savedKey.current) {
        void saveRef.current()
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  // Undo: remember graph states once they settle (so a drag counts as one edit).
  useEffect(() => {
    if (!loaded.current) return
    if (restoring.current) {
      restoring.current = false
      stableKey.current = graphKey
      return
    }
    const t = window.setTimeout(() => {
      if (stableKey.current && stableKey.current !== graphKey) {
        history.current = [...history.current, stableKey.current].slice(-HISTORY)
        stableKey.current = graphKey
      }
    }, 400)
    return () => window.clearTimeout(t)
  }, [graphKey])
  const undo = useCallback(() => {
    const target = latestKey.current !== stableKey.current ? stableKey.current : history.current.pop()
    if (!target) return
    const g = JSON.parse(target) as { nodes: FlowNode[]; edges: FlowEdge[] }
    restoring.current = true
    stableKey.current = target
    setNodes(g.nodes.map(toFlow))
    setEdges(g.edges.map(toEdge))
    setSelected(null)
    toast('Undone', { duration: 1200 })
  }, [setNodes, setEdges])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return
      if (!editable || tab !== 'builder') return
      e.preventDefault()
      undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, editable, tab])

  const validation = useQuery({ queryKey: wqk.validate(appId, workflowId!), queryFn: () => api.validate(workflowId!), enabled: !!w })
  const live = !!w && w.version > 0
  const stats = useWorkflowStats(appId, workflowId!, live && showStats)

  const issues = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const i of validation.data?.issues ?? []) if (i.node_id) (m[i.node_id] ??= []).push(i.message)
    return m
  }, [validation.data])
  const warnings = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const i of validation.data?.warnings ?? []) if (i.node_id) (m[i.node_id] ??= []).push(i.message)
    return m
  }, [validation.data])
  const globalIssues = (validation.data?.issues ?? []).filter((i) => !i.node_id)
  const view: BuilderView = { summary, issues, stats: live && showStats ? (stats.data?.nodes ?? {}) : null, readOnly: !writable }

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((eds) => {
        // One connection per output: a new link from the same output replaces the old one.
        const rest = eds.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null)))
        return addEdge({ ...c, id: `${c.source}-${c.target}-${c.sourceHandle ?? ''}` }, rest)
      }),
    [setEdges],
  )

  const add = (type: NodeType, position?: { x: number; y: number }) => {
    const id = newId(type)
    const from = nodes.find((n) => n.id === selected) ?? nodes[nodes.length - 1]
    // Connect from the selected step's first free output: the single output, or Yes then No / A then B.
    const outs = from ? NODE_META[from.type as NodeType].outputs : []
    const used = new Set(edges.filter((e) => e.source === from?.id).map((e) => e.sourceHandle ?? null))
    const free = position ? undefined : outs.find((h) => !used.has(h))
    const dx = outs.length === 2 && free !== undefined ? (free === outs[0] ? -170 : 170) : 0
    const pos = position ?? (from ? { x: from.position.x + dx, y: from.position.y + 160 } : { x: 0, y: 0 })
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id, type, position: pos, data: { ...DEFAULT_DATA[type] }, selected: true, deletable: true }])
    if (from && free !== undefined) {
      setEdges((eds) => [...eds, { id: `${from.id}-${id}-${free ?? ''}`, source: from.id, target: id, sourceHandle: free ?? undefined }])
    }
    setSelected(id)
    // Bring the new step into view.
    setCenter(pos.x + 130, pos.y + 40, { zoom: Math.max(getZoom(), 0.8), duration: 300 })
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const type = e.dataTransfer.getData('application/x-step') as NodeType
    if (type && !COMING_SOON_STEPS.includes(type)) add(type, screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }

  const sel = nodes.find((n) => n.id === selected)
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try {
      await saveNow()
      await fn()
      await qc.invalidateQueries({ queryKey: wqk.all(appId) })
      toast.success(msg)
    } catch (e) {
      toast.error(errorMessage(e))
      validation.refetch()
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }
  const rename = (value: string) => {
    if (!w || !value.trim() || value.trim() === w.name) return Promise.resolve()
    return api
      .update(w.id, { name: value.trim() })
      .then((x) => {
        qc.setQueryData(wqk.one(appId, w.id), x)
      })
      .catch((e) => {
        toast.error(`Name not saved: ${errorMessage(e)}`)
        setName(w.name)
      })
  }

  if (q.isLoading) return <FullPageSpinner />
  if (q.isError || !w) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const runs = w.runs ?? {}
  const issueList = validation.data?.issues ?? []
  const warningList = validation.data?.warnings ?? []
  const issueCount = issueList.length
  const stepLabel = (id: string | null) => {
    const n = nodes.find((x) => x.id === id)
    if (!n) return 'Workflow'
    return (n.data.label as string) || NODE_META[n.type as NodeType]?.label || 'Step'
  }
  const needsName = w.status === 'draft' && (name.trim() || w.name) === UNTITLED
  const canPublish = writable && w.status !== 'archived' && (w.status === 'draft' || w.has_unpublished_changes)
  const total = Object.values(runs).reduce((a, b) => a + b, 0)

  return (
    <div className="flex h-[calc(100vh-56px)] min-w-0 flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b bg-card px-2 py-2 sm:gap-3 sm:px-4">
        <Button variant="ghost" size="icon" aria-label="Back to workflows" onClick={() => navigate(`/apps/${appId}/automation`)}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1 sm:flex-none">
          <Input
            aria-label="Workflow name"
            value={name}
            disabled={!writable}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => rename(name)}
            className="h-8 w-full border-transparent px-1 text-base font-semibold shadow-none hover:border-input focus:border-input sm:w-64"
          />
          <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
            <WorkflowStatusBadge status={w.status} />
            {w.has_unpublished_changes && w.version > 0 && <Badge variant="warning">Unpublished changes</Badge>}
            <span className="flex items-center gap-1" data-testid="save-state">
              {saveState === 'saving' ? <Loader2 className="size-3 animate-spin" /> : saveState === 'error' ? <CloudOff className="size-3 text-destructive" /> : <Cloud className="size-3" />}
              {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : saveState === 'saved' ? 'Saved' : `Version ${w.version}`}
            </span>
          </div>
        </div>
        <nav className="flex rounded-lg border p-0.5" aria-label="Workflow views">
          {(['builder', 'enrollments'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                void saveNow()
                setParams(t === 'builder' ? {} : { tab: t })
              }}
              className={cn('rounded-md px-3 py-1 text-sm font-medium transition', tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
            >
              {t === 'builder' ? 'Builder' : `Enrollments${total ? ` (${total})` : ''}`}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {live && tab === 'builder' && (
            <label className="hidden items-center gap-2 text-xs text-muted-foreground lg:flex">
              <Checkbox checked={showStats} onChange={(e) => setShowStats(e.target.checked)} aria-label="Show results on steps" />
              <BarChart3 className="size-3.5" /> Results
            </label>
          )}
          <DropdownMenu onOpenChange={(o) => o && validation.refetch()}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" data-testid="issues">
                {validation.isFetching ? <Loader2 className="animate-spin" /> : issueCount ? <AlertTriangle className="text-destructive" /> : <CheckCircle2 className="text-success-strong" />}
                {issueCount ? `${issueCount} to fix` : 'Ready'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[60vh] w-80 overflow-y-auto" data-testid="problems-list">
              {issueCount === 0 && warningList.length === 0 && <div className="px-2 py-3 text-sm text-muted-foreground">No problems. This workflow is ready to activate.</div>}
              {issueCount > 0 && <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Fix to activate</div>}
              {issueList.map((i, k) => (
                <DropdownMenuItem key={`i${k}`} className="flex-col items-start gap-0.5" onSelect={() => i.node_id && focusNode(i.node_id)} data-testid="problem-item">
                  <span className="text-xs font-semibold">{stepLabel(i.node_id)}</span>
                  <span className="text-xs text-destructive">{i.message}</span>
                </DropdownMenuItem>
              ))}
              {warningList.length > 0 && <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Worth checking</div>}
              {warningList.map((i, k) => (
                <DropdownMenuItem key={`w${k}`} className="flex-col items-start gap-0.5" onSelect={() => i.node_id && focusNode(i.node_id)}>
                  <span className="text-xs font-semibold">{stepLabel(i.node_id)}</span>
                  <span className="text-xs text-warning-strong">{i.message}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" onClick={() => setDialog('test')} data-testid="test-workflow" aria-label="Test with a contact">
            <FlaskConical /> <span className="hidden sm:inline">Test</span>
          </Button>
          {writable && w.status === 'active' && (
            <Button variant="outline" size="sm" onClick={() => setDialog('enroll')} data-testid="enroll" aria-label="Enroll contacts">
              <UserPlus /> <span className="hidden sm:inline">Enroll</span>
            </Button>
          )}
          {writable && w.status === 'active' && (
            <Button variant="outline" size="sm" loading={busy} onClick={() => setConfirm('pause')}>
              <Pause /> <span className="hidden sm:inline">Pause</span>
            </Button>
          )}
          {writable && w.status === 'paused' && !w.has_unpublished_changes && (
            <Button size="sm" loading={busy} onClick={() => act(() => api.resume(w.id), 'Workflow resumed')}>
              <Play /> Resume
            </Button>
          )}
          {canPublish && (
            <Tooltip content={issueCount > 0 ? `Fix ${issueCount} problem${issueCount === 1 ? '' : 's'} to activate` : saveState === 'saving' ? 'Saving…' : w.status === 'draft' ? 'Start the journey for people who meet the trigger' : 'Make your edits live'}>
              <span tabIndex={issueCount > 0 ? 0 : -1} data-testid="publish-wrap">
                <Button
                  size="sm"
                  disabled={issueCount > 0 || saveState === 'saving'}
                  onClick={async () => {
                    await saveNow()
                    setActivateName(name === UNTITLED ? '' : name)
                    setConfirm('publish')
                  }}
                  data-testid="publish"
                >
                  <Rocket /> {w.status === 'draft' ? 'Activate' : 'Publish changes'}
                </Button>
              </span>
            </Tooltip>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More workflow actions" data-testid="more-actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setDialog('settings')}>
                <Settings2 className="size-4" /> Workflow settings
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setDialog('test')}>
                <FlaskConical className="size-4" /> Test with a contact
              </DropdownMenuItem>
              {writable && (
                <DropdownMenuItem disabled={w.status !== 'active'} onSelect={() => setDialog('enroll')}>
                  <UserPlus className="size-4" /> Enroll contacts{w.status !== 'active' ? ' (activate first)' : ''}
                </DropdownMenuItem>
              )}
              {writable && w.status !== 'archived' && w.version > 0 && (
                <DropdownMenuItem className="text-destructive" onSelect={() => setConfirm('archive')}>
                  Archive
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {tab === 'enrollments' ? (
        <div className="flex-1 overflow-y-auto p-3 sm:p-6">
          <RunsPanel workflowId={w.id} canStop={writable} onEnroll={writable && w.status === 'active' ? () => setDialog('enroll') : undefined} />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1">
          <aside className="hidden w-56 shrink-0 space-y-4 overflow-y-auto border-r bg-card p-3 md:block" aria-label="Steps">
            <Palette disabled={!editable} onAdd={add} />
            <p className="px-1 text-[11px] text-muted-foreground">
              Click to add after the selected step (on a condition or split, it fills Yes then No). Or drag onto the canvas and connect by dragging from a dot. Ctrl+Z undoes.
            </p>
          </aside>
          <div className="relative min-w-0 flex-1" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            {editable && (
              <Button size="sm" className="absolute left-3 top-3 z-20 shadow-pop md:hidden" onClick={() => setPaletteOpen(true)} data-testid="add-step">
                <Plus /> Add step
              </Button>
            )}
            {(w.status === 'active' || w.status === 'paused') && w.has_unpublished_changes && (
              <div className="absolute left-1/2 top-3 z-10 w-[min(90%,32rem)] -translate-x-1/2 rounded-2xl border border-warning-border bg-warning-soft px-3 py-1 text-center text-xs text-warning-strong shadow-sm">
                Edits apply to new steps only after you publish. People keep following version {w.version} until then.
              </div>
            )}
            {globalIssues.length > 0 && (
              <div className="absolute bottom-14 left-1/2 z-10 w-[min(90%,28rem)] -translate-x-1/2 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-xs text-danger-strong shadow-sm md:bottom-3">
                {globalIssues.map((i) => (
                  <div key={i.message}>{i.message}</div>
                ))}
              </div>
            )}
            <BuilderContext.Provider value={view}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={writable ? onNodesChange : undefined}
                onEdgesChange={writable ? onEdgesChange : undefined}
                onConnect={writable ? onConnect : undefined}
                onSelectionChange={({ nodes: s }) => setSelected(s[0]?.id ?? null)}
                nodesDraggable={writable}
                nodesConnectable={writable}
                colorMode={resolved}
                fitView
                minZoom={0.3}
                maxZoom={1.5}
                deleteKeyCode={['Backspace', 'Delete']}
                defaultEdgeOptions={{ type: 'smoothstep', style: { strokeWidth: 2 } }}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={20} size={1} />
                <Controls showInteractive={false} className="!hidden sm:!block" />
                {!sel && <MiniMap pannable zoomable className="!hidden 2xl:!block" />}
              </ReactFlow>
            </BuilderContext.Provider>
          </div>
          {sel && (
            <Inspector
              key={sel.id}
              node={{ id: sel.id, type: sel.type as NodeType, position: sel.position, data: sel.data }}
              nodes={nodes.map((n) => ({ id: n.id, type: n.type as NodeType, position: n.position, data: n.data }))}
              issues={issues[sel.id] ?? []}
              warnings={warnings[sel.id] ?? []}
              readOnly={!editable}
              onChange={(data) => setNodes((ns) => ns.map((n) => (n.id === sel.id ? { ...n, data } : n)))}
              onDelete={() => {
                setNodes((ns) => ns.filter((n) => n.id !== sel.id))
                setEdges((es) => es.filter((e) => e.source !== sel.id && e.target !== sel.id))
                setSelected(null)
              }}
              onClose={() => {
                setNodes((ns) => ns.map((n) => ({ ...n, selected: false })))
                setSelected(null)
              }}
            />
          )}
        </div>
      )}

      <Sheet open={paletteOpen} onOpenChange={setPaletteOpen} title="Add a step" description={sel ? `Adds after “${stepLabel(sel.id)}”.` : 'Adds after the last step.'}>
        <div className="space-y-4">
          <Palette disabled={!editable} onAdd={add} onPicked={() => setPaletteOpen(false)} />
        </div>
      </Sheet>

      <ConfirmDialog
        open={confirm === 'publish'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={w.status === 'draft' ? 'Activate this workflow?' : 'Publish your changes?'}
        description={
          w.status === 'draft'
            ? 'From now on, people who meet the trigger start the journey and receive its messages. Consent, suppression, quiet hours and calling windows are checked before every message.'
            : 'New steps go live now. People part-way through continue from where they are; anyone on a step you removed leaves the journey.'
        }
        confirmLabel={w.status === 'draft' ? 'Activate' : 'Publish'}
        confirmDisabled={needsName && !activateName.trim()}
        loading={busy}
        onConfirm={() =>
          act(async () => {
            if (needsName) {
              await rename(activateName)
              setName(activateName.trim())
            }
            await api.publish(w.id, true)
          }, w.status === 'draft' ? 'Workflow is live' : 'Changes published')
        }
      >
        {needsName && (
          <Field label="Give it a name first" htmlFor="activate-name" hint="So your team can tell your workflows apart.">
            <Input id="activate-name" autoFocus value={activateName} maxLength={160} onChange={(e) => setActivateName(e.target.value)} placeholder="e.g. Welcome new subscribers" />
          </Field>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'pause'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Pause this workflow?"
        description="No one new enters while it’s paused, and people already on the journey wait where they are: no messages go out until you resume. Nobody is removed."
        confirmLabel="Pause"
        loading={busy}
        onConfirm={() => act(() => api.pause(w.id), 'Workflow paused')}
      />
      <ConfirmDialog
        open={confirm === 'archive'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Archive this workflow?"
        description="It stops for good. People part-way through leave the journey. Results stay available."
        confirmLabel="Archive"
        destructive
        loading={busy}
        onConfirm={() => act(() => api.archive(w.id), 'Workflow archived')}
      />
      <TestDialog open={dialog === 'test'} onOpenChange={(o) => setDialog(o ? 'test' : null)} workflow={w} appId={appId} onSelectStep={(id) => { setParams({}); setTimeout(() => focusNode(id), 50) }} beforeRun={saveNow} />
      {writable && <EnrollDialog open={dialog === 'enroll'} onOpenChange={(o) => setDialog(o ? 'enroll' : null)} workflow={w} appId={appId} />}
      <SettingsDialog
        open={dialog === 'settings'}
        onOpenChange={(o) => setDialog(o ? 'settings' : null)}
        workflow={w}
        appId={appId}
        readOnly={!editable}
        onSaved={(x: Workflow) => {
          qc.setQueryData(wqk.one(appId, w.id), x)
          setName(x.name)
        }}
      />
    </div>
  )
}

export function WorkflowBuilderPage() {
  return (
    <ReactFlowProvider>
      <Builder />
    </ReactFlowProvider>
  )
}
