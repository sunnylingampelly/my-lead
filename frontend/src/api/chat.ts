import { useQuery } from '@tanstack/react-query'
import { http } from './client'
import type {
  BotTemplate,
  CannedResponse,
  ChatAgents,
  ChatAnalytics,
  ChatBot,
  ChatStatus,
  ConversationDetail,
  InboxMessage,
  InboxPage,
  InboxUpdates,
  KnowledgeSource,
  TestReply,
  UnansweredQuestion,
} from '@/types/chat'

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)

export const chatApi = (appId: string) => {
  const b = `/apps/${appId}/chat`
  return {
    status: () => data(http.get<ChatStatus>(`${b}/status`)),
    templates: () => data(http.get<BotTemplate[]>(`${b}/templates`)),
    bots: () => data(http.get<ChatBot[]>(`${b}/bots`)),
    bot: (id: string) => data(http.get<ChatBot>(`${b}/bots/${id}`)),
    createBot: (body: { name: string; template?: string | null }) => data(http.post<ChatBot>(`${b}/bots`, body)),
    updateBot: (id: string, body: Partial<ChatBot>) => data(http.patch<ChatBot>(`${b}/bots/${id}`, body)),
    deleteBot: (id: string) => data(http.delete(`${b}/bots/${id}`)),
    publish: (id: string) => data(http.post<ChatBot>(`${b}/bots/${id}/publish`)),
    unpublish: (id: string) => data(http.post<ChatBot>(`${b}/bots/${id}/unpublish`)),
    test: (id: string, messages: { role: 'user' | 'assistant'; content: string }[]) =>
      data(http.post<TestReply>(`${b}/bots/${id}/test`, { messages }, { timeout: 90000 })),

    sources: (id: string) => data(http.get<KnowledgeSource[]>(`${b}/bots/${id}/sources`)),
    source: (id: string, sid: string) => data(http.get<KnowledgeSource>(`${b}/bots/${id}/sources/${sid}`)),
    addSource: (id: string, body: { kind: 'text' | 'faq' | 'url'; title?: string; content?: string; question?: string; url?: string; crawl?: boolean; max_pages?: number }) =>
      data(http.post<KnowledgeSource>(`${b}/bots/${id}/sources`, body, { timeout: 120000 })),
    uploadSource: (id: string, file: File) => {
      const form = new FormData()
      form.append('file', file)
      return data(http.post<KnowledgeSource>(`${b}/bots/${id}/sources/upload`, form, { timeout: 120000 }))
    },
    updateSource: (id: string, sid: string, body: { title?: string; content?: string; question?: string }) =>
      data(http.patch<KnowledgeSource>(`${b}/bots/${id}/sources/${sid}`, body)),
    deleteSource: (id: string, sid: string) => data(http.delete(`${b}/bots/${id}/sources/${sid}`)),
    resync: (id: string, sid: string) => data(http.post<KnowledgeSource>(`${b}/bots/${id}/sources/${sid}/resync`, null, { timeout: 120000 })),
    improve: (id: string, body: { question: string; answer: string; message_id?: string | null }) =>
      data(http.post<KnowledgeSource>(`${b}/bots/${id}/improve`, body)),

    inbox: (p: { filter: string; q?: string; bot_id?: string; page?: number }) =>
      data(http.get<InboxPage>(`${b}/inbox/conversations`, { params: Object.fromEntries(Object.entries({ page_size: 50, ...p }).filter(([, v]) => v)) })),
    updates: (since?: string | null) => data(http.get<InboxUpdates>(`${b}/inbox/updates`, { params: since ? { since } : {} })),
    conversation: (id: string) => data(http.get<ConversationDetail>(`${b}/inbox/conversations/${id}`)),
    messages: (id: string, after?: string | null) =>
      data(http.get<InboxMessage[]>(`${b}/inbox/conversations/${id}/messages`, { params: after ? { after } : {} })),
    join: (id: string) => data(http.post<ConversationDetail>(`${b}/inbox/conversations/${id}/join`)),
    reply: (id: string, body: string, internal = false) => data(http.post<InboxMessage>(`${b}/inbox/conversations/${id}/messages`, { body, internal })),
    assign: (id: string, user_id: string | null) => data(http.post<ConversationDetail>(`${b}/inbox/conversations/${id}/assign`, { user_id })),
    tags: (id: string, tags: string[]) => data(http.post<{ tags: string[] }>(`${b}/inbox/conversations/${id}/tags`, { tags })),
    close: (id: string) => data(http.post<ConversationDetail>(`${b}/inbox/conversations/${id}/close`)),
    reopen: (id: string) => data(http.post<ConversationDetail>(`${b}/inbox/conversations/${id}/reopen`)),
    read: (id: string) => data(http.post(`${b}/inbox/conversations/${id}/read`)),

    presence: (status: 'online' | 'away' | 'offline') => data(http.post<{ status: string; online_agents: number }>(`${b}/presence`, { status })),
    agents: () => data(http.get<ChatAgents>(`${b}/agents`)),
    addAgent: (user_id: string) => data(http.post<ChatAgents>(`${b}/agents`, { user_id })),
    removeAgent: (user_id: string) => data(http.delete(`${b}/agents/${user_id}`)),

    canned: () => data(http.get<CannedResponse[]>(`${b}/canned`)),
    saveCanned: (body: Omit<CannedResponse, 'id'>, id?: string) =>
      data(id ? http.patch<CannedResponse>(`${b}/canned/${id}`, body) : http.post<CannedResponse>(`${b}/canned`, body)),
    deleteCanned: (id: string) => data(http.delete(`${b}/canned/${id}`)),

    analytics: (days: number, bot_id?: string) => data(http.get<ChatAnalytics>(`${b}/analytics`, { params: { days, ...(bot_id ? { bot_id } : {}) } })),
    unanswered: (bot_id?: string) => data(http.get<UnansweredQuestion[]>(`${b}/unanswered`, { params: bot_id ? { bot_id } : {} })),
  }
}

export const cqk = {
  all: (appId: string) => ['chat', appId] as const,
  bots: (appId: string) => ['chat', appId, 'bots'] as const,
  bot: (appId: string, id: string) => ['chat', appId, 'bot', id] as const,
  sources: (appId: string, id: string) => ['chat', appId, 'sources', id] as const,
  inbox: (appId: string) => ['chat', appId, 'inbox'] as const,
  conversation: (appId: string, id: string) => ['chat', appId, 'conversation', id] as const,
  agents: (appId: string) => ['chat', appId, 'agents'] as const,
  canned: (appId: string) => ['chat', appId, 'canned'] as const,
  analytics: (appId: string, days: number, bot?: string) => ['chat', appId, 'analytics', days, bot ?? ''] as const,
}

export function useChatStatus(appId: string) {
  return useQuery({ queryKey: ['chat', appId, 'status'], queryFn: () => chatApi(appId).status(), staleTime: 300_000 })
}

export function useBots(appId: string) {
  return useQuery({ queryKey: cqk.bots(appId), queryFn: () => chatApi(appId).bots() })
}
