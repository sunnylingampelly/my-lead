export interface AiLink {
  label: string
  href: string
}

export interface ActionField {
  label: string
  value: string
}

export interface ActionCard {
  id: string
  tool: string
  label: string
  title: string
  fields: ActionField[]
  editable: { key: string; label: string; value: unknown; multiline: boolean }[]
  status: 'pending' | 'executing' | 'executed' | 'failed' | 'cancelled' | 'rejected' | 'expired'
  source: 'assistant' | 'agent'
  agent_id: string | null
  agent_name: string | null
  run_id: string | null
  conversation_id: string | null
  result: { summary?: string; links?: AiLink[]; data?: Record<string, unknown> } | null
  error: string | null
  decided_via: 'app' | 'slack' | null
  decided_at: string | null
  created_at: string
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  links: AiLink[]
  tools: { name: string; ok: boolean; summary?: string }[]
  simulated: boolean
  created_at: string
}

export interface Conversation {
  id: string
  title: string
  message_count: number
  created_at: string
  updated_at: string
}

export interface ConversationDetail extends Conversation {
  messages: AssistantMessage[]
  actions: ActionCard[]
}

export interface UsageMeter {
  used: number
  limit: number | null
}

export interface AiUsage {
  assistant_messages: UsageMeter
  agent_runs: UsageMeter
  plan: string
}

export interface SlackStatus {
  configured: boolean
  connected: boolean
  simulated: boolean
  team_name: string | null
  team_id: string | null
  scopes: string[]
  connected_at: string | null
  can_manage: boolean
  redirect_url: string
  interactivity_url: string
  bot_scopes: string[]
}

export interface AiStatus {
  simulated: boolean
  model: string | null
  usage: AiUsage
  pending_approvals: number
  can_manage: boolean
  slack: SlackStatus
}

export interface SlackChannel {
  id: string
  name: string
  is_private?: boolean
}

export type AgentTrigger =
  | { type: 'event'; events: string[]; filters?: Record<string, unknown> }
  | { type: 'schedule'; every: 'daily' | 'weekly' | 'hours'; time?: string; day?: number; hours?: number }

export interface AgentConfig {
  name: string
  description: string
  template: string | null
  instructions: string
  trigger: AgentTrigger
  allowed_tools: string[]
  mode: 'auto' | 'approve'
  destinations: { in_app: boolean; email_user_ids: string[]; slack_channels?: SlackChannel[] }
  simulated?: boolean
}

export interface Agent extends AgentConfig {
  id: string
  trigger_label: string
  enabled: boolean
  owner_id: string | null
  owner_name: string
  flow: string[]
  next_run_at: string | null
  last_run_at: string | null
  last_status: string | null
  runs_7d: number
  created_at: string
  updated_at: string
}

export interface AgentTemplate {
  key: string
  name: string
  description: string
  icon: string
  flow: string[]
  trigger: AgentTrigger
  mode: 'auto' | 'approve'
  allowed_tools: string[]
  instructions: string
}

export interface ToolInfo {
  name: string
  label: string
  description: string
  kind: 'read' | 'write'
  permissions: string[]
  allowed: boolean
}

export interface AgentRun {
  id: string
  agent_id: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped'
  dry_run: boolean
  simulated: boolean
  trigger_key: string
  trigger: Record<string, unknown>
  summary: string | null
  error: string | null
  attempts: number
  input_tokens: number
  output_tokens: number
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface RunStep {
  id: string
  position: number
  kind: 'tool' | 'proposed' | 'message' | 'deliver' | 'error'
  tool: string | null
  tool_label: string | null
  args: Record<string, unknown> | null
  summary: string | null
  status: string
  action_id: string | null
  action_status: string | null
  input_tokens: number
  output_tokens: number
  at: string
}

export interface RunDetail extends AgentRun {
  steps: RunStep[]
}

export interface PageContext {
  path: string
  title?: string
  contact_id?: string
  deal_id?: string
  campaign_id?: string
  form_id?: string
  workflow_id?: string
  bot_id?: string
  agent_id?: string
}
