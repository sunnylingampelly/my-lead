import type { CampaignAudience, CampaignStatus, Estimate, ReadinessCheck, WalletInfo } from './email'
import type { QuietWait } from './sms'

export type VoiceCategory = 'promotional' | 'transactional' | 'service'
export type CallerKind = 'series_140' | 'series_160' | 'local' | 'toll_free'
export type VoiceLanguage = 'en-IN' | 'hi-IN' | 'ta-IN' | 'te-IN' | 'en-US' | 'es-US'
export type VoiceMessageType = 'audio' | 'tts' | 'ai_agent'

export type OutcomeFieldType = 'text' | 'yes_no' | 'number' | 'date' | 'choice'

export interface OutcomeField {
  key: string
  label: string
  type: OutcomeFieldType
  options?: string[] | null
  description?: string | null
}

export interface AgentUse {
  id: string
  name: string
  status: string
}

export interface VoiceAgent {
  id: string
  name: string
  status: 'draft' | 'active'
  template: string | null
  language: VoiceLanguage
  voice: 'female' | 'male'
  goal: string | null
  greeting: string
  instructions: string
  knowledge: string | null
  outcome_fields: OutcomeField[]
  transfer_number: string | null
  max_call_minutes: number
  version: number
  created_at: string
  updated_at: string
  used_by: AgentUse[]
}

export type VoiceAgentListItem = Pick<VoiceAgent, 'id' | 'name' | 'status' | 'template' | 'language' | 'goal' | 'version' | 'updated_at' | 'used_by'>

export interface AgentTemplate {
  key: string
  name: string
  description: string
  goal: string
  outcome_fields: OutcomeField[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AgentReply {
  reply: string
  end_call: boolean
  transfer: boolean
  simulated: boolean
  error: string | null
}

export interface CallEvaluation {
  summary: string
  sentiment: 'positive' | 'neutral' | 'negative' | null
  interest: 'hot' | 'warm' | 'cold' | 'not_interested' | null
  next_step: string | null
  callback_requested_at: string | null
  do_not_call: boolean
  outcomes: Record<string, string | number | boolean | null>
  simulated: boolean
}

export interface VoiceAudio {
  id: string
  name: string
  kind: 'upload' | 'tts'
  content_type: string | null
  size_bytes: number | null
  duration_seconds: string | null
  tts_text: string | null
  tts_language: VoiceLanguage | null
  tts_voice: 'female' | 'male' | null
  created_at: string
  updated_at: string
  url: string | null
}

export interface VoiceStats {
  recipients: number
  pending: number
  deferred: number
  in_progress: number
  attempted: number
  answered: number
  voicemail: number
  no_answer: number
  busy: number
  failed: number
  skipped: number
  opted_out: number
  attempts: number
  talk_seconds: number
  billable_minutes: number
  cost: number
}

export interface VoiceCampaign {
  id: string
  name: string
  description: string | null
  category: VoiceCategory
  status: CampaignStatus
  caller_ref: string | null
  audio_id: string | null
  message_type: VoiceMessageType | null
  agent_id: string | null
  intro_text: string | null
  opt_out_keypress: boolean
  max_attempts: number
  retry_delay_minutes: number
  audience: CampaignAudience
  scheduled_at: string | null
  schedule_timezone: string | null
  provider: string | null
  snapshot: Record<string, unknown>
  recipient_count: number
  excluded: Record<string, number>
  estimated_cost: string | null
  currency: string | null
  launched_at: string | null
  completed_at: string | null
  error: string | null
  created_at: string
  updated_at: string
  stats: VoiceStats | null
}

export type VoiceCampaignListItem = Pick<
  VoiceCampaign,
  'id' | 'name' | 'category' | 'status' | 'recipient_count' | 'scheduled_at' | 'launched_at' | 'created_at' | 'updated_at' | 'currency' | 'stats'
>

export interface ScriptStepView {
  kind: 'say' | 'play' | 'keypress' | 'agent'
  text: string | null
  url: string | null
}

export interface VoicePreview {
  steps: ScriptStepView[]
  seconds: number
  language?: VoiceLanguage
  voice?: 'female' | 'male'
  ai_agent?: boolean
  contact_label: string | null
}

export interface VoiceReadiness {
  ready: boolean
  checks: ReadinessCheck[]
  estimate: Estimate | null
  seconds: number
  cost: { per_minute: number; currency: string; minutes_per_call: number; total: number; ai?: boolean }
  /** Legal window for the market (kept for older clients); prefer calling_hours. */
  window: [string, string]
  country: 'IN' | 'US' | null
  caller_chosen: boolean
  calling_hours: QuietWait
  wallet: WalletInfo
}

export interface VoiceCall {
  id: string
  contact_id: string | null
  to_phone: string
  /** The Signalcraft number the call was placed from (picked automatically). */
  from_number?: string | null
  status: string
  attempts: number
  answered_by: string | null
  answered_at: string | null
  ended_at: string | null
  duration_seconds: number
  billable_minutes: number
  cost: string | null
  opted_out: boolean
  error_code: string | null
  error_message: string | null
  deferred_reason: string | null
  next_attempt_at: string | null
  created_at: string
  updated_at: string
  agent_id: string | null
  ai_summary: string | null
  ai_sentiment: string | null
  ai_interest: string | null
  ai_next_step: string | null
  ai_processed_at: string | null
  contact_name: string | null
  has_transcript: boolean
}

export interface TranscriptTurn {
  role: 'user' | 'assistant'
  text: string
  at?: string
  interrupted?: boolean
}

export interface VoiceCallDetail extends VoiceCall {
  campaign: { id: string; name: string }
  transcript: TranscriptTurn[]
  agent: { id: string; name: string; version: number } | null
  ai_outcomes: { key: string; label: string; type: OutcomeFieldType; value: string | number | boolean | null }[]
  callback_requested_at: string | null
  do_not_call: boolean
  simulated: boolean
}

export interface VoiceReport {
  campaign: VoiceCampaign
  stats: VoiceStats
  rates: { answer_rate: number | null; reach_rate: number | null; opt_out_rate: number | null; average_seconds: number | null }
  outcomes: { answered: number; voicemail: number; no_answer: number; busy: number; failed: number }
  timeline: { granularity: 'hour' | 'day'; points: { at: string; answered: number; unanswered: number }[] }
  failure_reasons: { status: string; code: string | null; message: string | null; count: number }[]
  waiting: { reason: string; next_attempt_at: string | null; count: number }[]
  simulated: boolean
}

export interface VoiceOverview {
  campaigns_by_status: Record<string, number>
  last_30_days: VoiceStats & { campaigns: number; spend: Record<string, number>; answer_rate: number | null }
  recent: VoiceCampaignListItem[]
  upcoming: VoiceCampaignListItem[]
  agents?: Record<string, number>
  audio_count: number
  setup: { default_country: 'IN' | 'US' | null; dlt_registered: boolean; consented: number }
}

export interface VoiceOptions {
  languages: Record<VoiceLanguage, string>
  legal_windows: Record<string, [string, string]>
  pricing: Record<string, { currency: string; per_minute: number }>
  ai_pricing?: Record<string, { currency: string; per_minute: number }>
  ai_expected_minutes?: number
  number_kinds?: Record<'IN' | 'US', { key: CallerKind; label: string }[]>
  opt_out_digit: string
  max_bytes: number
  max_seconds: number
  live: boolean
}
