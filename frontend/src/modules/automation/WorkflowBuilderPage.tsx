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
import { AlertTriangle, ArrowLeft, BarChart3, CheckCircle2, Cloud, CloudOff, Loader2, Pause, Play, Rocket } from 'lucide-react'
import { automationApi, type FlowEdge, type FlowNode, type NodeType, useWorkflow, useWorkflowStats, wqk } from '@/api/automation'
import { useLists, useSegments, useTags } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { useSenders, useTemplates } from '@/api/email'
import { useSmsSenders, useSmsTemplates } from '@/api/sms'
import { useAudio, useCallers } from '@/api/voice'
import { ErrorState, FullPageSpinner } from '@/components/page'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Checkbox } from '@/components/audience'
import { useTheme } from '@/hooks/useTheme'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn } from '@/lib/utils'
import { BuilderContext, type BuilderView } from './context'
import { FlowNodeCard } from './FlowNodeCard'
import { Inspector } from './Inspector'
import { DEFAULT_DATA, NODE_META, newId, TRIGGER_LABEL } from './meta'
import { RunsPanel, WorkflowStatusBadge } from './RunsPanel'

const nodeTypes = Object.fromEntries(Object.keys(NODE_META).map((k) => [k, FlowNodeCard]))
const PALETTE: NodeType[] = ['send_email', 'send_sms', 'voice_call', 'wait', 'condition', 'split', 'update_contact', 'end']

const toFlow = (n: FlowNode): Node => ({ ...n, deletable: n.type !== 'trigger' })
const toEdge = (e: FlowEdge): Edge => ({ ...e, sourceHandle: e.sourceHandle ?? undefined, animated: false, label: e.sourceHandle ? e.sourceHandle.toUpperCase() : undefined })
const fromFlow = (nodes: Node[], edges: Edge[]) => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.type as NodeType, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: n.data })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
})

function useSummaries(appId: string) {
  const senders = useSenders(appId)
  const templates = useTemplates(appId)
  const smsSenders = useSmsSenders(appId)
  const callers = useCallers(appId)
  const audio = useAudio(appId)
  const lists = useLists(appId)
  const tags = useTags(appId)
  const segments = useSegments(appId)
  useSmsTemplates(appId)
  return useCallback(
    (_id: string, type: NodeType, d: Record<string, unknown>): string => {
      const name = <T extends { id: string }>(xs: T[] | undefined, id: unknown, f: (x: T) => string) => {
        const x = xs?.find((y) => y.id === id)
        return x ? f(x) : ''
      }
      switch (type) {
        case 'trigger': {
          const k = (d.kind as string) || 'contact_created'
          const target =
            k === 'added_to_list' ? name(lists.data, d.list_id, (l) => l.name) : k === 'tag_added' ? name(tags.data, d.tag_id, (t) => t.name) : k === 'segment_entered' ? name(segments.data, d.segment_id, (s) => s.name) : ''
          return `${TRIGGER_LABEL[k]}${target ? `: ${target}` : ''}`
        }
        case 'send_email':
          return name(templates.data, d.template_id, (t) => t.name) || 'Choose a template'
        case 'send_sms': {
          const s = name(smsSenders.data, d.sender_ref, (x) => x.sender_id)
          const body = (d.body as string) || ''
          return [s, body.slice(0, 40)].filter(Boolean).join(' · ') || 'Write the message'
        }
        case 'voice_call':
          return [name(callers.data, d.caller_ref, (c) => c.number), name(audio.data, d.audio_id, (a) => a.name)].filter(Boolean).join(' · ') || 'Choose a caller ID and message'
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
        default:
          return 'Journey ends'
      }
    },
    [senders.data, templates.data, smsSenders.data, callers.data, audio.data, lists.data, tags.data, segments.data], // eslint-disable-line react-hooks/exhaustive-deps
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
  const [confirm, setConfirm] = useState<'publish' | 'archive' | null>(null)
  const loaded = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const savedKey = useRef<string | null>(null)
  const { screenToFlowPosition, fitView, setCenter, getZoom } = useReactFlow()
  const summary = useSummaries(appId)
  const writable = can('automation.write')
  const w = q.data

  useEffect(() => {
    if (w && !loaded.current) {
      loaded.current = true
      savedKey.current = JSON.stringify(fromFlow(w.graph.nodes.map(toFlow), w.graph.edges.map(toEdge)))
      setNodes(w.graph.nodes.map(toFlow))
      setEdges(w.graph.edges.map(toEdge))
      setName(w.name)
      setTimeout(() => fitView({ padding: 0.3, maxZoom: 1 }), 50)
    }
  }, [w, setNodes, setEdges, fitView])

  const graphKey = useMemo(() => JSON.stringify(fromFlow(nodes, edges)), [nodes, edges])
  useEffect(() => {
    if (!loaded.current || !w || savedKey.current === null) return
    if (savedKey.current === graphKey || !writable || w.status === 'archived') return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(async () => {
      setSaveState('saving')
      try {
        const saved = await api.update(w.id, { graph: JSON.parse(graphKey) })
        savedKey.current = graphKey
        qc.setQueryData(wqk.one(appId, w.id), saved)
        qc.invalidateQueries({ queryKey: wqk.validate(appId, w.id) })
        setSaveState('saved')
      } catch (e) {
        setSaveState('error')
        toast.error(errorMessage(e))
      }
    }, 900)
    return () => window.clearTimeout(timer.current)
  }, [graphKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const validation = useQuery({ queryKey: wqk.validate(appId, workflowId!), queryFn: () => api.validate(workflowId!), enabled: !!w })
  const live = !!w && w.version > 0
  const stats = useWorkflowStats(appId, workflowId!, live && showStats)

  const issues = useMemo(() => {
    const m: Record<string, string[]> = {}
    for (const i of validation.data?.issues ?? []) if (i.node_id) (m[i.node_id] ??= []).push(i.message)
    return m
  }, [validation.data])
  const globalIssues = (validation.data?.issues ?? []).filter((i) => !i.node_id)
  const view: BuilderView = { summary, issues, stats: live && showStats ? (stats.data?.nodes ?? {}) : null, readOnly: !writable }

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((eds) => {
        // One connection per output: a new link from the same output replaces the old one.
        const rest = eds.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null)))
        return addEdge({ ...c, id: `${c.source}-${c.target}-${c.sourceHandle ?? ''}`, label: c.sourceHandle ? c.sourceHandle.toUpperCase() : undefined }, rest)
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
      setEdges((eds) => [...eds, { id: `${from.id}-${id}-${free ?? ''}`, source: from.id, target: id, sourceHandle: free ?? undefined, label: free ? free.toUpperCase() : undefined }])
    }
    setSelected(id)
    // Bring the new step into view.
    setCenter(pos.x + 130, pos.y + 40, { zoom: Math.max(getZoom(), 0.8), duration: 300 })
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const type = e.dataTransfer.getData('application/x-step') as NodeType
    if (type) add(type, screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }

  const sel = nodes.find((n) => n.id === selected)
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try {
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

  if (q.isLoading) return <FullPageSpinner />
  if (q.isError || !w) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const runs = w.runs ?? {}
  const issueCount = validation.data?.issues.length ?? 0

  return (
    <div className="flex h-[calc(100vh-56px)] flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b bg-card px-4 py-2.5">
        <Button variant="ghost" size="icon" aria-label="Back to workflows" onClick={() => navigate(`/apps/${appId}/automation`)}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0">
          <Input
            aria-label="Workflow name"
            value={name}
            disabled={!writable}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== w.name && api.update(w.id, { name }).then((x) => qc.setQueryData(wqk.one(appId, w.id), x))}
            className="h-8 w-64 border-transparent px-1 text-base font-semibold shadow-none hover:border-input focus:border-input"
          />
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <WorkflowStatusBadge status={w.status} />
            {w.has_unpublished_changes && w.version > 0 && <Badge variant="warning">Unpublished changes</Badge>}
            <span className="flex items-center gap-1" data-testid="save-state">
              {saveState === 'saving' ? <Loader2 className="size-3 animate-spin" /> : saveState === 'error' ? <CloudOff className="size-3 text-destructive" /> : <Cloud className="size-3" />}
              {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : saveState === 'saved' ? 'Saved' : `Version ${w.version}`}
            </span>
          </div>
        </div>
        <nav className="ml-2 flex rounded-lg border p-0.5" aria-label="Workflow views">
          {(['builder', 'enrollments'] as const).map((t) => (
            <button key={t} onClick={() => setParams(t === 'builder' ? {} : { tab: t })} className={cn('rounded-md px-3 py-1 text-sm font-medium transition', tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
              {t === 'builder' ? 'Builder' : `Enrollments${Object.values(runs).reduce((a, b) => a + b, 0) ? ` (${Object.values(runs).reduce((a, b) => a + b, 0)})` : ''}`}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {live && tab === 'builder' && (
            <label className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
              <Checkbox checked={showStats} onChange={(e) => setShowStats(e.target.checked)} aria-label="Show results on steps" />
              <BarChart3 className="size-3.5" /> Results
            </label>
          )}
          <Button variant="outline" size="sm" onClick={() => validation.refetch()} data-testid="issues">
            {validation.isFetching ? <Loader2 className="animate-spin" /> : issueCount ? <AlertTriangle className="text-destructive" /> : <CheckCircle2 className="text-success-strong" />}
            {issueCount ? `${issueCount} to fix` : 'Ready'}
          </Button>
          {writable && w.status === 'active' && (
            <Button variant="outline" size="sm" loading={busy} onClick={() => act(() => api.pause(w.id), 'Workflow paused')}>
              <Pause /> Pause
            </Button>
          )}
          {writable && w.status === 'paused' && !w.has_unpublished_changes && (
            <Button size="sm" loading={busy} onClick={() => act(() => api.resume(w.id), 'Workflow resumed')}>
              <Play /> Resume
            </Button>
          )}
          {writable && w.status !== 'archived' && (w.status === 'draft' || w.has_unpublished_changes) && (
            <Button size="sm" disabled={issueCount > 0 || saveState === 'saving'} onClick={() => setConfirm('publish')} data-testid="publish">
              <Rocket /> {w.status === 'draft' ? 'Activate' : 'Publish changes'}
            </Button>
          )}
          {writable && w.status !== 'archived' && w.version > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setConfirm('archive')}>
              Archive
            </Button>
          )}
        </div>
      </header>

      {tab === 'enrollments' ? (
        <div className="flex-1 overflow-y-auto p-6">
          <RunsPanel workflowId={w.id} canStop={writable} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="w-56 shrink-0 space-y-4 overflow-y-auto border-r bg-card p-3" aria-label="Steps">
            {(['Messages', 'Flow', 'Contact'] as const).map((group) => (
              <div key={group}>
                <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group}</div>
                <div className="space-y-1">
                  {PALETTE.filter((t) => NODE_META[t].group === group).map((t) => {
                    const m = NODE_META[t]
                    const Icon = m.icon
                    return (
                      <button
                        key={t}
                        draggable={writable}
                        disabled={!writable || w.status === 'archived'}
                        onDragStart={(e) => e.dataTransfer.setData('application/x-step', t)}
                        onClick={() => add(t)}
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
            <p className="px-1 text-[11px] text-muted-foreground">Click to add after the selected step (on a condition or split, it fills Yes then No). Or drag onto the canvas and connect by dragging from a dot.</p>
          </aside>
          <div className="relative min-w-0 flex-1" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            {(w.status === 'active' || w.status === 'paused') && w.has_unpublished_changes && (
              <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-warning-border bg-warning-soft px-3 py-1 text-xs text-warning-strong shadow-sm">
                Edits apply to new steps only after you publish. People keep following version {w.version} until then.
              </div>
            )}
            {globalIssues.length > 0 && (
              <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-xs text-danger-strong shadow-sm">
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
                <Controls showInteractive={false} />
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
              readOnly={!writable || w.status === 'archived'}
              onChange={(data) => setNodes((ns) => ns.map((n) => (n.id === sel.id ? { ...n, data } : n)))}
              onDelete={() => {
                setNodes((ns) => ns.filter((n) => n.id !== sel.id))
                setEdges((es) => es.filter((e) => e.source !== sel.id && e.target !== sel.id))
                setSelected(null)
              }}
              onClose={() => setNodes((ns) => ns.map((n) => ({ ...n, selected: false })))}
            />
          )}
        </div>
      )}

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
        loading={busy}
        onConfirm={() => act(() => api.publish(w.id, true), w.status === 'draft' ? 'Workflow is live' : 'Changes published')}
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
