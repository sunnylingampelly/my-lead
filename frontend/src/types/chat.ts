/** Website chatbots and live chat. */

export type BotStatus = 'draft' | 'live'
export type LeadMode = 'before' | 'after' | 'when_needed' | 'off'
export type ConversationStatus = 'bot' | 'waiting' | 'open' | 'closed'

export interface LeadField {
  key: string
  label: string
  required: boolean
}

export interface LeadCapture {
  mode: LeadMode
  after_messages: number
  prompt: string
  fields: LeadField[]
  consent: { enabled: boolean; text: string; channels: ('email' | 'sms')[] }
}

export interface BusinessHours {
  enabled: boolean
  timezone: string
  days: Record<string, [string, string] | string[] | null>
}

export interface Appearance {
  color: string
  position: 'left' | 'right'
  offset_x: number
  offset_y: number
  launcher_icon: 'chat' | 'help' | 'sparkles' | 'wave'
  launcher_text: string
  title: string
  subtitle: string
  theme: 'light' | 'dark' | 'auto'
  show_on_mobile: boolean
  mobile_fullscreen: boolean
  sound: boolean
  show_branding: boolean
}

export interface Proactive {
  enabled: boolean
  delay_seconds: number
  message: string
  paths: string[]
}

export interface ChatBot {
  id: string
  name: string
  status: BotStatus
  template: string | null
  public_key: string
  avatar_url: string | null
  instructions: string
  welcome_message: string
  quick_replies: string[]
  language: string
  fallback: 'human' | 'collect'
  lead_capture: LeadCapture
  business_hours: BusinessHours
  allowed_domains: string[]
  appearance: Appearance
  proactive: Proactive
  routing: 'broadcast' | 'round_robin'
  knowledge_chars: number
  knowledge_mode: 'inline' | 'retrieval'
  snippet: string
  embed_url: string
  branding_hidden: boolean
  source_count?: number
  conversation_count?: number
  created_at: string
  updated_at: string
}

export interface BotTemplate {
  key: string
  name: string
  description: string
  welcome_message: string
  quick_replies: string[]
}

export interface ChatStatus {
  configured: boolean
  model: string
  effort: string
  price: { per_reply: number; currency: string }
  inline_limit: number
  max_chars: number
  crawl_max_pages: number
}

export type SourceKind = 'text' | 'faq' | 'url' | 'file'

export interface KnowledgeSource {
  id: string
  kind: SourceKind
  title: string
  url: string | null
  question: string | null
  content: string | null
  preview: string
  status: 'processing' | 'ready' | 'failed'
  error: string | null
  char_count: number
  last_synced_at: string | null
  meta: { pages?: { url: string; title: string; chars: number }[]; skipped?: { url: string; reason: string }[]; crawl?: boolean; filename?: string }
  created_at: string
}

export interface TestReply {
  reply: string
  question: string
  simulated: boolean
  unanswered: boolean
  handoff: boolean
  collect_contact: boolean
  error: string | null
  knowledge_mode: 'inline' | 'retrieval'
  retrieved: { title: string; preview: string }[]
}

export interface InboxItem {
  id: string
  status: ConversationStatus
  name: string
  email: string | null
  bot: { id: string; name: string | null }
  assignee: { id: string; full_name: string } | null
  preview: string | null
  last_message_at: string | null
  unread: number
  tags: string[]
  offline: boolean
  lead: boolean
  rating: 'up' | 'down' | null
  waiting_since: string | null
  contact_id: string | null
  lead_quality: string | null
  updated_at: string
}

export type InboxCounts = Record<'open' | 'mine' | 'unassigned' | 'bot', number>

export interface InboxPage {
  items: InboxItem[]
  total: number
  page: number
  page_size: number
  counts: InboxCounts
}

export interface InboxMessage {
  id: string
  role: 'visitor' | 'bot' | 'agent' | 'system' | 'note'
  body: string
  created_at: string
  author: { id: string; full_name: string } | null
  question: string | null
  flag: string | null
  meta: Record<string, unknown>
}

export interface ConversationDetail extends InboxItem {
  messages: InboxMessage[]
  conversation: {
    created_at: string
    page_url: string | null
    page_title: string | null
    handoff_requested_at: string | null
    agent_joined_at: string | null
    closed_at: string | null
    closed_by: string | null
    rating: string | null
    rating_comment: string | null
    summary: { text: string; intent: string | null; sentiment: string | null; lead_quality: string | null; follow_up: string | null } | null
  }
  visitor: {
    id: string
    name: string | null
    email: string | null
    phone: string | null
    pages: { url: string; title: string; at: string }[]
    current_page: { url: string; title: string; at: string } | null
    referrer: string | null
    utm: Record<string, string>
    attributes: Record<string, unknown>
    country: string | null
    user_agent: string | null
    first_seen_at: string
    last_seen_at: string
  } | null
  contact: {
    id: string
    name: string
    email: string | null
    phone: string | null
    company: string | null
    lifecycle_stage: string
    lead_score: number
    owner: { id: string; full_name: string } | null
    deals: { id: string; name: string; status: string; amount: number; currency: string }[]
  } | null
  previous: { id: string; status: string; created_at: string; preview: string | null; summary: string | null }[]
  bot_status: string | null
  can_reply: boolean
}

export interface InboxUpdates {
  now: string
  changed: InboxItem[]
  counts: InboxCounts
  handoffs: InboxItem[]
  new_chats: InboxItem[]
}

export interface ChatAgents {
  agents: { user_id: string; full_name: string | null; email: string | null; status: 'online' | 'away' | 'offline'; last_seen_at: string | null }[]
  candidates: { id: string; full_name: string; email: string }[]
  seats: { used: number; limit: number | null }
  me: { status: 'online' | 'away' | 'offline' } | null
  can_reply: boolean
}

export interface CannedResponse {
  id: string
  shortcut: string
  title: string
  body: string
}

export interface UnansweredQuestion {
  question: string
  count: number
  last_at: string
  message_id: string
  bot_id: string
  bot_name: string | null
  conversation_id: string
}

export interface ChatAnalytics {
  days: number
  conversations: number
  leads: number
  lead_rate: number
  bot_resolved: number
  handed_off: number
  bot_resolved_pct: number
  handed_off_pct: number
  avg_first_response_seconds: number | null
  csat: number | null
  ratings: number
  ai_replies: number
  ai_spend: number
  offline_messages: number
  series: { date: string; conversations: number; leads: number; handed_off: number }[]
  top_questions: { question: string; count: number }[]
  unanswered: UnansweredQuestion[]
}
