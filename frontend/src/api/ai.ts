import { useQuery } from '@tanstack/react-query'
import { ApiError, http, refreshSession, tokenStore } from './client'
import type {
  ActionCard,
  Agent,
  AgentConfig,
  AgentRun,
  AgentTemplate,
  AiStatus,
  AssistantMessage,
  Conversation,
  ConversationDetail,
  PageContext,
  RunDetail,
  SlackChannel,
  SlackStatus,
  ToolInfo,
} from '@/types/ai'

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)

export const aiApi = (appId: string) => {
  const b = `/apps/${appId}/ai`
  return {
    status: () => data(http.get<AiStatus>(`${b}/status`)),
    tools: () => data(http.get<ToolInfo[]>(`${b}/tools`)),
    conversations: () => data(http.get<Conversation[]>(`${b}/conversations`)),
    conversation: (id: string) => data(http.get<ConversationDetail>(`${b}/conversations/${id}`)),
    deleteConversation: (id: string) => data(http.delete(`${b}/conversations/${id}`)),
    confirm: (id: string, args?: Record<string, unknown>) => data(http.post<ActionCard>(`${b}/actions/${id}/confirm`, args ? { args } : {})),
    cancel: (id: string) => data(http.post<ActionCard>(`${b}/actions/${id}/cancel`)),
    approvals: (status: 'pending' | 'decided') => data(http.get<ActionCard[]>(`${b}/approvals`, { params: { status } })),
    approve: (id: string, args?: Record<string, unknown>) => data(http.post<ActionCard>(`${b}/approvals/${id}/approve`, args ? { args } : {})),
    reject: (id: string) => data(http.post<ActionCard>(`${b}/approvals/${id}/reject`)),
    templates: () => data(http.get<{ templates: AgentTemplate[]; events: { key: string; label: string }[] }>(`${b}/agents/templates`)),
    agents: () => data(http.get<Agent[]>(`${b}/agents`)),
    agent: (id: string) => data(http.get<Agent>(`${b}/agents/${id}`)),
    draft: (prompt: string) => data(http.post<AgentConfig>(`${b}/agents/draft`, { prompt }, { timeout: 90000 })),
    createAgent: (body: Partial<AgentConfig> & { enabled?: boolean }) => data(http.post<Agent>(`${b}/agents`, body)),
    updateAgent: (id: string, body: Partial<AgentConfig> & { enabled?: boolean }) => data(http.patch<Agent>(`${b}/agents/${id}`, body)),
    deleteAgent: (id: string) => data(http.delete(`${b}/agents/${id}`)),
    run: (id: string, dry_run: boolean) => data(http.post<RunDetail>(`${b}/agents/${id}/run`, { dry_run }, { timeout: 180000 })),
    runs: (id: string) => data(http.get<AgentRun[]>(`${b}/agents/${id}/runs`)),
    runDetail: (runId: string) => data(http.get<RunDetail>(`${b}/runs/${runId}`)),
    slack: () => data(http.get<SlackStatus>(`${b}/integrations/slack`)),
    slackInstall: () => data(http.post<{ url: string }>(`${b}/integrations/slack/install`)),
    slackSimulate: () => data(http.post<SlackStatus>(`${b}/integrations/slack/simulate`)),
    slackDisconnect: () => data(http.delete(`${b}/integrations/slack`)),
    slackChannels: () => data(http.get<SlackChannel[]>(`${b}/integrations/slack/channels`)),
  }
}

export const aiqk = {
  all: (appId: string) => ['ai', appId] as const,
  status: (appId: string) => ['ai', appId, 'status'] as const,
  conversations: (appId: string) => ['ai', appId, 'conversations'] as const,
  conversation: (appId: string, id: string) => ['ai', appId, 'conversation', id] as const,
  approvals: (appId: string, status: string) => ['ai', appId, 'approvals', status] as const,
  agents: (appId: string) => ['ai', appId, 'agents'] as const,
  agent: (appId: string, id: string) => ['ai', appId, 'agent', id] as const,
  runs: (appId: string, id: string) => ['ai', appId, 'runs', id] as const,
  run: (appId: string, id: string) => ['ai', appId, 'run', id] as const,
  templates: (appId: string) => ['ai', appId, 'templates'] as const,
  tools: (appId: string) => ['ai', appId, 'tools'] as const,
  slack: (appId: string) => ['ai', appId, 'slack'] as const,
  channels: (appId: string) => ['ai', appId, 'slack-channels'] as const,
}

export const useAiStatus = (appId: string | undefined, enabled = true) =>
  useQuery({ queryKey: aiqk.status(appId ?? ''), queryFn: () => aiApi(appId!).status(), enabled: !!appId && enabled, refetchInterval: 60_000 })
export const useConversations = (appId: string, enabled = true) =>
  useQuery({ queryKey: aiqk.conversations(appId), queryFn: () => aiApi(appId).conversations(), enabled })
export const useApprovals = (appId: string, status: 'pending' | 'decided') =>
  useQuery({ queryKey: aiqk.approvals(appId, status), queryFn: () => aiApi(appId).approvals(status), refetchInterval: status === 'pending' ? 20_000 : false })
export const useAgents = (appId: string) => useQuery({ queryKey: aiqk.agents(appId), queryFn: () => aiApi(appId).agents() })
export const useAgent = (appId: string, id: string) => useQuery({ queryKey: aiqk.agent(appId, id), queryFn: () => aiApi(appId).agent(id) })
export const useAgentRuns = (appId: string, id: string) =>
  useQuery({
    queryKey: aiqk.runs(appId, id),
    queryFn: () => aiApi(appId).runs(id),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'queued' || r.status === 'running') ? 3000 : false),
  })
export const useRun = (appId: string, runId: string | null) =>
  useQuery({
    queryKey: aiqk.run(appId, runId ?? ''),
    queryFn: () => aiApi(appId).runDetail(runId!),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'queued' || q.state.data.status === 'running') ? 2000 : false),
  })
export const useAgentTemplates = (appId: string) => useQuery({ queryKey: aiqk.templates(appId), queryFn: () => aiApi(appId).templates(), staleTime: 3_600_000 })
export const useAiTools = (appId: string) => useQuery({ queryKey: aiqk.tools(appId), queryFn: () => aiApi(appId).tools(), staleTime: 3_600_000 })
export const useSlackStatus = (appId: string) => useQuery({ queryKey: aiqk.slack(appId), queryFn: () => aiApi(appId).slack() })
export const useSlackChannels = (appId: string, enabled = true) =>
  useQuery({ queryKey: aiqk.channels(appId), queryFn: () => aiApi(appId).slackChannels(), enabled, retry: false })

// ------------------------------------------------------------------ streaming

export type StreamEvent =
  | { event: 'conversation'; data: Conversation }
  | { event: 'meta'; data: { simulated: boolean } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'tool'; data: { name: string; label: string; ok: boolean } }
  | { event: 'action'; data: ActionCard }
  | { event: 'done'; data: { message: AssistantMessage; usage: AiStatus['usage'] } }
  | { event: 'error'; data: { message: string } }
  | { event: 'end'; data: Record<string, never> }

async function post(url: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const send = () =>
    fetch(`/api/v1${url}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(tokenStore.get() ? { Authorization: `Bearer ${tokenStore.get()}` } : {}) },
      body: JSON.stringify(body),
      signal,
    })
  let res = await send()
  if (res.status === 401 && (await refreshSession())) res = await send()
  return res
}

/** Ask the assistant; calls `onEvent` for each server-sent event as it arrives. */
export async function streamAssistant(
  appId: string,
  body: { text: string; conversation_id?: string | null; page?: PageContext },
  onEvent: (e: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await post(`/apps/${appId}/ai/assistant/messages`, body, signal)
  if (!res.ok || !res.body) {
    let err: { code?: string; message?: string } = {}
    try {
      err = ((await res.json()) as { error?: typeof err }).error ?? {}
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, err.code ?? 'HTTP_ERROR', err.message ?? 'The assistant is unavailable right now.')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let event = 'message'
      let payload = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) payload += line.slice(6)
      }
      try {
        onEvent({ event, data: payload ? JSON.parse(payload) : {} } as StreamEvent)
      } catch {
        /* ignore a malformed event */
      }
    }
  }
}
