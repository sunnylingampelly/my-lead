import type { CampaignAudience, CampaignStatus, Estimate } from './email'

export type VoiceCategory = 'promotional' | 'transactional' | 'service'
export type CallerKind = 'series_140' | 'series_160' | 'local' | 'toll_free'
export type VoiceLanguage = 'en-IN' | 'hi-IN' | 'ta-IN' | 'te-IN' | 'en-US' | 'es-US'

export interface CallerId {
  id: string
  number: string
  label: string | null
  country: 'IN' | 'US'
  kind: CallerKind
  provider: 'simulation' | 'telnyx' | 'exotel' | 'twilio'
  status: 'pending' | 'active'
  is_default: boolean
  attested_at: string | null
  created_at: string
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
  kind: 'say' | 'play' | 'keypress'
  text: string | null
  url: string | null
}

export interface VoicePreview {
  steps: ScriptStepView[]
  seconds: number
  language?: VoiceLanguage
  voice?: 'female' | 'male'
  contact_label: string | null
}

export interface VoiceReadiness {
  ready: boolean
  checks: { key: string; label: string; ok: boolean; detail: string | null }[]
  estimate: Estimate | null
  seconds: number
  cost: { per_minute: number; currency: string; minutes_per_call: number; total: number }
  window: [string, string]
}

export interface VoiceCall {
  id: string
  contact_id: string | null
  to_phone: string
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
  callers: Record<string, number>
  audio_count: number
}

export interface VoiceOptions {
  languages: Record<VoiceLanguage, string>
  legal_windows: Record<string, [string, string]>
  pricing: Record<string, { currency: string; per_minute: number }>
  opt_out_digit: string
  max_bytes: number
  max_seconds: number
  live: boolean
}
