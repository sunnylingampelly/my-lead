import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { http } from './client'
import type { Page } from '@/types/api'

export type NodeType = 'trigger' | 'send_email' | 'send_sms' | 'voice_call' | 'wait' | 'condition' | 'split' | 'update_contact' | 'crm_action' | 'end'

export interface FlowNode {
  id: string
  type: NodeType
  position: { x: number; y: number }
  data: Record<string, unknown>
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
}

export interface WorkflowGraph {
  nodes: FlowNode[]
  edges: FlowEdge[]
}

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived'

export interface WorkflowSummary {
  id: string
  name: string
  description: string | null
  status: WorkflowStatus
  version: number
  has_unpublished_changes: boolean
  allow_reentry: boolean
  trigger: string | null
  steps: number
  activated_at: string | null
  created_at: string
  updated_at: string
  runs: Record<string, number>
}

export interface Workflow extends WorkflowSummary {
  graph: WorkflowGraph
  published_graph: WorkflowGraph
}

export interface WorkflowIssue {
  node_id: string | null
  message: string
}

export interface WorkflowStats {
  nodes: Record<string, Record<string, number>>
  channel: Record<string, Record<string, number>>
  runs: Record<string, number>
  entered_30d: number
}

export interface WorkflowRun {
  id: string
  contact_id: string | null
  contact: string
  status: 'waiting' | 'running' | 'completed' | 'exited' | 'failed'
  current_step: string | null
  wake_at: string | null
  exit_reason: string | null
  started_at: string
  finished_at: string | null
}

export interface RunStep {
  node_id: string
  node_type: NodeType
  label: string
  /** What the step does, e.g. "Create task: Follow up with {{name}}". */
  summary: string | null
  outcome: string
  detail: string | null
  /** Records the step created (CRM task / deal). */
  links: { kind: 'task' | 'deal'; id: string; label: string }[]
  at: string
}

export interface TestStep {
  node_id: string | null
  label: string
  outcome: string
  detail: string
}

export interface TestResult {
  contact_id: string
  contact: string
  graph: 'draft' | 'published'
  steps: TestStep[]
}

export interface EnrollResult {
  enrolled: number
  skipped: number
  message: string
}

/** One entry of a contact's workflow history (GET /automation/runs?contact_id=). */
export interface ContactRun {
  run_id: string
  workflow_id: string
  workflow_name: string
  status: WorkflowRun['status']
  current_step: string | null
  started_at: string
  finished_at: string | null
  exit_reason: string | null
}

export type EnrollBody = { contact_ids: string[] } | { list_id: string } | { segment_id: string }

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)

export const automationApi = (appId: string) => {
  const b = `/apps/${appId}/automation/workflows`
  return {
    list: (p: { page: number; page_size: number; status?: string; search?: string }) =>
      data(http.get<Page<WorkflowSummary>>(b, { params: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) })),
    get: (id: string) => data(http.get<Workflow>(`${b}/${id}`)),
    create: (body: { name: string; description?: string | null; graph?: WorkflowGraph }) => data(http.post<Workflow>(b, body)),
    update: (id: string, body: { name?: string; description?: string | null; allow_reentry?: boolean; graph?: WorkflowGraph }) =>
      data(http.patch<Workflow>(`${b}/${id}`, body)),
    validate: (id: string) => data(http.get<{ valid: boolean; issues: WorkflowIssue[]; warnings?: WorkflowIssue[] }>(`${b}/${id}/validate`)),
    test: (id: string, contactId: string, graph: 'draft' | 'published' = 'draft') =>
      data(http.post<TestResult>(`${b}/${id}/test`, { contact_id: contactId, graph })),
    enroll: (id: string, body: EnrollBody) => data(http.post<EnrollResult>(`${b}/${id}/enroll`, body)),
    contactRuns: (contactId: string) => data(http.get<ContactRun[]>(`/apps/${appId}/automation/runs`, { params: { contact_id: contactId } })),
    publish: (id: string, activate = true) => data(http.post<Workflow>(`${b}/${id}/publish`, { activate })),
    pause: (id: string) => data(http.post<Workflow>(`${b}/${id}/pause`)),
    resume: (id: string) => data(http.post<Workflow>(`${b}/${id}/resume`)),
    archive: (id: string) => data(http.post<Workflow>(`${b}/${id}/archive`)),
    duplicate: (id: string) => data(http.post<Workflow>(`${b}/${id}/duplicate`)),
    remove: (id: string) => data(http.delete(`${b}/${id}`)),
    stats: (id: string) => data(http.get<WorkflowStats>(`${b}/${id}/stats`)),
    runs: (id: string, p: { page: number; page_size: number; status?: string; search?: string }) =>
      data(http.get<Page<WorkflowRun>>(`${b}/${id}/runs`, { params: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) })),
    runSteps: (id: string, runId: string) => data(http.get<{ steps: RunStep[] }>(`${b}/${id}/runs/${runId}`)),
    stopRun: (id: string, runId: string) => data(http.post(`${b}/${id}/runs/${runId}/stop`)),
  }
}

export const wqk = {
  all: (appId: string) => ['automation', appId] as const,
  list: (appId: string, p: object) => ['automation', appId, 'list', p] as const,
  one: (appId: string, id: string) => ['automation', appId, 'workflow', id] as const,
  stats: (appId: string, id: string) => ['automation', appId, 'stats', id] as const,
  runs: (appId: string, id: string, p: object) => ['automation', appId, 'runs', id, p] as const,
  validate: (appId: string, id: string) => ['automation', appId, 'validate', id] as const,
}

export const useWorkflows = (appId: string, p: { page: number; page_size: number; status?: string; search?: string }) =>
  useQuery({ queryKey: wqk.list(appId, p), queryFn: () => automationApi(appId).list(p), placeholderData: keepPreviousData })
export const useWorkflow = (appId: string, id: string) => useQuery({ queryKey: wqk.one(appId, id), queryFn: () => automationApi(appId).get(id) })
export const useWorkflowStats = (appId: string, id: string, enabled: boolean) =>
  useQuery({ queryKey: wqk.stats(appId, id), queryFn: () => automationApi(appId).stats(id), enabled, refetchInterval: enabled ? 10_000 : false })
export const useWorkflowRuns = (appId: string, id: string, p: { page: number; page_size: number; status?: string; search?: string }) =>
  useQuery({ queryKey: wqk.runs(appId, id, p), queryFn: () => automationApi(appId).runs(id, p), placeholderData: keepPreviousData, refetchInterval: 10_000 })
/** A contact's workflow history, newest first. */
export const useContactRuns = (appId: string, contactId: string, enabled = true) =>
  useQuery({ queryKey: ['automation', appId, 'contact-runs', contactId], queryFn: () => automationApi(appId).contactRuns(contactId), enabled: enabled && !!contactId })
