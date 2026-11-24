import type { CampaignAudience, CampaignStatus, Estimate, ReadinessCheck, WalletInfo } from './email'

export type SmsCategory = 'promotional' | 'transactional' | 'service'
export type SmsCountry = 'IN' | 'US'
export type SenderKind = 'promotional' | 'service' | 'transactional' | 'long_code' | 'toll_free' | 'short_code'

export interface DltConfig {
  principal_entity_id: string | null
  entity_name: string | null
  dlt_platform: string | null
  us_brand_id: string | null
  us_campaign_id: string | null
  attested_at: string | null
  attested_by_name: string | null
}

export interface SmsSender {
  id: string
  sender_id: string
  country: SmsCountry
  kind: SenderKind
  provider: 'simulation' | 'sns'
  dlt_header_id: string | null
  status: 'pending' | 'active'
  is_default: boolean
  attested_at: string | null
  created_at: string
}

export interface SmsTemplate {
  id: string
  name: string
  category: SmsCategory
  body: string
  sender_ref: string | null
  dlt_template_id: string | null
  dlt_template_text: string | null
  dlt_match: boolean | null
  created_at: string
  updated_at: string
}

export interface SmsStats {
  recipients: number
  queued: number
  deferred: number
  sent: number
  delivered: number
  undelivered: number
  failed: number
  skipped: number
  segments: number
  cost: number
}

export interface SmsCampaign {
  id: string
  name: string
  description: string | null
  category: SmsCategory
  status: CampaignStatus
  sender_ref: string | null
  template_id: string | null
  body: string | null
  append_opt_out: boolean
  audience: CampaignAudience
  scheduled_at: string | null
  schedule_timezone: string | null
  provider: string | null
  sender_snapshot: Record<string, string | null>
  recipient_count: number
  excluded: Record<string, number>
  estimated_cost: string | null
  currency: string | null
  launched_at: string | null
  completed_at: string | null
  error: string | null
  created_at: string
  updated_at: string
  stats: SmsStats | null
}

export type SmsCampaignListItem = Pick<
  SmsCampaign,
  'id' | 'name' | 'category' | 'status' | 'body' | 'recipient_count' | 'scheduled_at' | 'launched_at' | 'created_at' | 'updated_at' | 'currency' | 'stats'
>

export interface MessageShape {
  text: string
  encoding: 'GSM-7' | 'UCS-2'
  characters: number
  segments: number
  per_segment: number
  remaining: number
  non_gsm: string[]
}

export interface SmsReadiness {
  ready: boolean
  checks: ReadinessCheck[]
  estimate: Estimate | null
  message: MessageShape
  cost: { unit_price: number; currency: string; total: number }
  country: 'IN' | 'US' | null
  sender_chosen: boolean
  wallet: WalletInfo
  quiet_hours: QuietWait
  custom_keys: string[]
}

export interface SendWindow {
  start: string | null
  end: string | null
  reason: string
  legal: [string, string] | null
  quiet: [string, string]
}

/** How many recipients would wait if sent now, and until when. */
export interface QuietWait {
  applies?: boolean
  window: SendWindow
  waiting: number
  next_window_at: string | null
  timezone: string | null
}

export interface SmsMessage {
  id: string
  contact_id: string | null
  to_phone: string
  country: string | null
  status: 'queued' | 'deferred' | 'sending' | 'accepted' | 'delivered' | 'undelivered' | 'failed' | 'skipped'
  segments: number
  cost: string | null
  encoding: string | null
  error_code: string | null
  error_message: string | null
  deferred_reason: string | null
  next_attempt_at: string | null
  accepted_at: string | null
  delivered_at: string | null
  failed_at: string | null
  created_at: string
}

export interface SmsReport {
  campaign: SmsCampaign
  stats: SmsStats
  rates: { delivery_rate: number | null; failure_rate: number | null; segments_per_message: number | null }
  timeline: { granularity: 'hour' | 'day'; points: { at: string; sent: number; delivered: number }[] }
  failure_reasons: { status: string; code: string | null; message: string | null; count: number }[]
  deferred: { reason: string | null; next_attempt_at: string | null; count: number }[]
  simulated: boolean
}

export interface SmsOverview {
  campaigns_by_status: Record<string, number>
  last_30_days: SmsStats & { campaigns: number; spend: Record<string, number>; opt_outs: number; delivery_rate: number | null }
  recent: SmsCampaignListItem[]
  upcoming: SmsCampaignListItem[]
  senders: Record<string, number>
  registration: { india: boolean; us: boolean }
  setup: { consented: { IN: number; US: number }; dlt_templates: number; default_country: 'IN' | 'US' | null }
}

export interface SmsInboundItem {
  id: string
  from: string
  to: string
  body: string
  keyword: 'stop' | 'start' | 'help' | null
  contacts_updated: number
  received_at: string
  contact: { id: string; name: string; email: string | null; owner_id: string | null } | null
  campaign: { id: string; name: string } | null
}
