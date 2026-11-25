export type CampaignStatus = 'draft' | 'scheduled' | 'queued' | 'sending' | 'paused' | 'completed' | 'cancelled' | 'failed'
export type EditorKind = 'visual' | 'html' | 'text'

export interface Sender {
  id: string
  from_name: string
  from_email: string
  reply_to: string | null
  status: 'pending' | 'verified'
  is_default: boolean
  verified_at: string | null
  verification_sent_at: string | null
  created_at: string
  domain: string
}

export interface EmailTemplate {
  id: string
  name: string
  subject: string | null
  preheader: string | null
  editor: EditorKind
  design: Record<string, unknown> | null
  html: string | null
  text: string | null
  created_at: string
  updated_at: string
}

export interface CampaignStats {
  recipients: number
  queued: number
  sent: number
  delivered: number
  bounced: number
  hard_bounced: number
  complained: number
  failed: number
  skipped: number
  unique_opens: number
  total_opens: number
  unique_clicks: number
  total_clicks: number
  unsubscribed: number
}

export interface CampaignAudience {
  all?: boolean
  list_ids?: string[]
  segment_ids?: string[]
  /** Explicit people (max 1,000), e.g. "resend to non-openers". */
  contact_ids?: string[]
}

export interface Campaign {
  id: string
  name: string
  description: string | null
  campaign_type: string
  status: CampaignStatus
  sender_id: string | null
  from_name: string | null
  from_email: string | null
  reply_to: string | null
  subject: string | null
  preheader: string | null
  editor: EditorKind
  design: Record<string, unknown> | null
  html: string | null
  text: string | null
  audience: CampaignAudience
  track_opens: boolean
  track_clicks: boolean
  scheduled_at: string | null
  schedule_timezone: string | null
  provider: string | null
  recipient_count: number
  excluded: Record<string, number>
  launched_at: string | null
  completed_at: string | null
  error: string | null
  created_at: string
  updated_at: string
  stats: CampaignStats | null
}

export type CampaignListItem = Pick<
  Campaign,
  'id' | 'name' | 'campaign_type' | 'status' | 'subject' | 'audience' | 'recipient_count' | 'scheduled_at' | 'launched_at' | 'completed_at' | 'created_at' | 'updated_at' | 'stats'
>

export interface Estimate {
  matched: number
  eligible: number
  excluded: Record<string, number>
}

/** Self-describing checklist item shared by email, SMS and voice. */
export interface ReadinessCheck {
  key: string
  label: string
  ok: boolean
  detail: string | null
  /** Editor step that fixes it. */
  step?: string | null
  /** Page outside the editor that fixes it. */
  action_url?: string | null
  action_label?: string | null
  /** Requirement shown before the choice it depends on (e.g. no sender yet). */
  pending?: boolean
  meta?: Record<string, unknown> | null
  /** Shown when failing, but never blocks sending (e.g. an unauthenticated sender domain). */
  warning?: boolean
}

export interface WalletInfo {
  available: number
  currency: string
}

export interface Readiness {
  ready: boolean
  checks: ReadinessCheck[]
  estimate: Estimate | null
  cost?: { unit_price: number; currency: string; total: number }
  wallet?: WalletInfo
  custom_keys: string[]
}

export interface RecipientIds {
  contact_ids: string[]
  total: number
  truncated: boolean
  limit: number
}

export interface Preview {
  subject: string
  html: string
  text: string
  contact_label: string
  issues: { unknown: string[]; malformed: string[] }
}

export interface CampaignReport {
  campaign: Campaign
  stats: CampaignStats
  rates: Record<'delivery_rate' | 'bounce_rate' | 'open_rate' | 'click_rate' | 'click_to_open_rate' | 'unsubscribe_rate' | 'complaint_rate', number | null>
  timeline: { granularity: 'hour' | 'day'; points: { at: string; opens: number; clicks: number }[] }
  top_links: { url: string; clicks: number; unique_clicks: number }[]
  simulated: boolean
}

export interface EmailMessage {
  id: string
  contact_id: string | null
  to_email: string
  status: string
  error_code: string | null
  error_message: string | null
  bounce_type: string | null
  accepted_at: string | null
  delivered_at: string | null
  first_opened_at: string | null
  first_clicked_at: string | null
  open_count: number
  click_count: number
  unsubscribed_at: string | null
  created_at: string
}

export interface EmailOverview {
  campaigns_by_status: Record<string, number>
  last_30_days: CampaignStats & { campaigns: number; delivery_rate: number | null; open_rate: number | null; click_rate: number | null }
  recent: CampaignListItem[]
  upcoming: CampaignListItem[]
  senders: Record<string, number>
}

export interface Variables {
  core: { key: string; label: string }[]
  custom: { key: string; label: string }[]
  system: { key: string; label: string }[]
}
