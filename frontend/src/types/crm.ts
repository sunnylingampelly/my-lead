/** CRM types, mirroring backend/app/schemas/crm.py. Decimal amounts arrive as strings from typed
 * endpoints and as numbers from report endpoints, so money is `Money` and is read with Number(). */
export type Money = string | number

export type Lifecycle = 'subscriber' | 'lead' | 'mql' | 'sql' | 'opportunity' | 'customer' | 'other'
export type StageKind = 'open' | 'won' | 'lost'
export type TaskType = 'call' | 'email' | 'meeting' | 'follow_up' | 'todo'
export type Priority = 'low' | 'normal' | 'high'
export type ActivityType = 'call' | 'meeting' | 'email' | 'whatsapp' | 'sms' | 'visit' | 'other'
export type DealStatus = 'open' | 'won' | 'lost'
export type CurrencyCode = 'INR' | 'AED' | 'USD'

export interface UserRef {
  id: string
  full_name: string
  email?: string | null
}

export interface Ref {
  id: string
  name: string
}

export interface ContactRef {
  id: string
  name: string
  email?: string | null
  phone?: string | null
  role?: string | null
  /** Quick per-channel reachability (address + consent + not unsubscribed). */
  reach?: Reach | null
}

export interface Reach {
  email: boolean
  sms: boolean
  voice: boolean
}

export interface SuggestedContact {
  id: string
  name: string
  email: string | null
  phone: string | null
  company: string | null
  matched_on: 'name' | 'domain'
}

// ------------------------------------------------------------------ companies

export type CompanySize = '1-10' | '11-50' | '51-200' | '201-1000' | '1000+'
export type GstTreatment = 'registered_regular' | 'registered_composition' | 'unregistered' | 'consumer' | 'overseas' | 'sez'

export interface CompanyInput {
  name?: string | null
  domain?: string | null
  industry?: string | null
  size?: CompanySize | null
  annual_revenue?: string | number | null
  currency?: CurrencyCode | null
  phone?: string | null
  website?: string | null
  gstin?: string | null
  pan?: string | null
  gst_treatment?: GstTreatment | null
  country?: string | null
  state?: string | null
  city?: string | null
  address?: string | null
  postal_code?: string | null
  description?: string | null
  owner_id?: string | null
  attributes?: Record<string, unknown> | null
  allow_duplicate?: boolean
}

export interface Company {
  id: string
  name: string
  domain: string | null
  industry: string | null
  size: CompanySize | null
  annual_revenue: Money | null
  currency: CurrencyCode
  phone: string | null
  website: string | null
  gstin: string | null
  pan: string | null
  gst_treatment: GstTreatment | null
  country: string | null
  state: string | null
  city: string | null
  address: string | null
  postal_code: string | null
  description: string | null
  owner: UserRef | null
  attributes: Record<string, unknown>
  contact_count: number
  open_deal_count: number
  open_deal_value: Money
  created_at: string
  updated_at: string
}

export interface DuplicateMatch {
  id: string
  name: string
  matched_on: string
}

export interface CompanyContact {
  id: string
  name: string
  email: string | null
  phone: string | null
  lifecycle_stage: Lifecycle | null
  lead_score: number | null
  reach?: Reach
}

// ------------------------------------------------------------------ pipelines

export interface StageInput {
  id?: string | null
  name: string
  probability: number
  kind: StageKind
  rotting_days?: number | null
}

export interface Stage {
  id: string
  name: string
  position: number
  probability: number
  kind: StageKind
  rotting_days: number | null
}

export interface Pipeline {
  id: string
  name: string
  currency: CurrencyCode
  is_default: boolean
  archived: boolean
  position: number
  stages: Stage[]
}

export interface PipelineUpdate {
  name?: string
  currency?: CurrencyCode
  is_default?: boolean
  archived?: boolean
  stages?: StageInput[]
}

export interface LostReason {
  id: string
  name: string
  position: number
  active: boolean
}

// ------------------------------------------------------------------ deals

export interface Deal {
  id: string
  title: string
  pipeline_id: string
  stage_id: string
  stage_name: string
  amount: Money
  currency: CurrencyCode
  probability: number
  probability_overridden: boolean
  weighted_amount: Money
  expected_close_date: string | null
  status: DealStatus
  lost_reason: Ref | null
  lost_note: string | null
  source: string | null
  owner: UserRef | null
  contact: ContactRef | null
  company: Ref | null
  stage_entered_at: string
  last_activity_at: string
  rotting: boolean
  rotting_days: number | null
  days_in_stage: number
  closed_at: string | null
  position: number
  attributes: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface StageHistoryEntry {
  from_stage: string | null
  to_stage: string
  changed_at: string
  changed_by: UserRef | null
  days_in_previous: number
}

export interface DealDetail extends Deal {
  contacts: ContactRef[]
  stage_history: StageHistoryEntry[]
}

export interface DealInput {
  title?: string
  amount?: string | number | null
  currency?: CurrencyCode | null
  probability?: number | null
  expected_close_date?: string | null
  source?: string | null
  owner_id?: string | null
  contact_id?: string | null
  company_id?: string | null
  pipeline_id?: string | null
  stage_id?: string | null
  clear_probability?: boolean
}

export interface DealFilters {
  pipeline_id?: string
  stage_id?: string
  status?: DealStatus | ''
  owner_id?: string
  contact_id?: string
  company_id?: string
  search?: string
  rotting?: boolean
  sort?: string
  source?: string
  tag_id?: string
  list_id?: string
  segment_id?: string
}

export interface BoardColumn {
  stage: Stage
  deals: Deal[]
  count: number
  total: Money
  weighted_total: Money
}

export interface Board {
  pipeline: Pipeline
  columns: BoardColumn[]
  open_total: Money
  weighted_total: Money
}

// ------------------------------------------------------------------ tasks, notes, activities

export interface Task {
  id: string
  title: string
  type: TaskType
  priority: Priority
  status: 'open' | 'done'
  due_at: string | null
  overdue: boolean
  notes: string | null
  assignee: UserRef | null
  contact: ContactRef | null
  deal: Ref | null
  company: Ref | null
  completed_at: string | null
  created_at: string
}

export interface TaskInput {
  title?: string
  type?: TaskType
  priority?: Priority
  due_at?: string | null
  notes?: string | null
  assignee_id?: string | null
  contact_id?: string | null
  deal_id?: string | null
  company_id?: string | null
  status?: 'open' | 'done'
}

export interface TaskSummary {
  open: number
  overdue: number
  today: number
}

export interface Note {
  id: string
  body: string
  pinned: boolean
  mentions: UserRef[]
  author: UserRef | null
  contact_id: string | null
  deal_id: string | null
  company_id: string | null
  created_at: string
  updated_at: string
}

export interface ActivityInput {
  type: ActivityType
  subject: string
  body?: string | null
  outcome?: string | null
  duration_minutes?: number | null
  occurred_at?: string | null
  contact_id?: string | null
  deal_id?: string | null
  company_id?: string | null
}

export type TimelineKind = 'activity' | 'note' | 'task' | 'system' | 'email' | 'sms' | 'call' | 'profile'

export interface TimelineItem {
  id: string
  kind: TimelineKind | 'sms_reply'
  type: string
  title: string
  body: string | null
  occurred_at: string
  actor: UserRef | null
  meta: Record<string, unknown>
}

/** Exactly one of these identifies the record a timeline, note, task or activity belongs to. */
export interface CrmTarget {
  contact_id?: string
  deal_id?: string
  company_id?: string
}

// ------------------------------------------------------------------ contacts & leads

export interface ContactCrm {
  contact_id: string
  owner: UserRef | null
  company: Ref | null
  lifecycle_stage: Lifecycle
  fit_score: number
  engagement_score: number
  lead_score: number
  grade: string
  hot: boolean
  sla_due_at: string | null
  first_response_at: string | null
  sla_breached_at: string | null
  open_deals: number
  open_tasks: number
}

export interface ContactCrmUpdate {
  owner_id?: string | null
  company_id?: string | null
  lifecycle_stage?: Lifecycle
  clear_owner?: boolean
  clear_company?: boolean
}

export interface LeadRow {
  id: string
  name: string
  email: string | null
  phone: string | null
  company: Ref | null
  owner: UserRef | null
  lifecycle_stage: Lifecycle
  lead_score: number
  fit_score: number
  engagement_score: number
  grade: string
  source: string | null
  sla_due_at: string | null
  sla_breached_at: string | null
  first_response_at: string | null
  created_at: string
}

export interface LeadFilters {
  owner_id?: string
  lifecycle?: string
  min_score?: number | ''
  sla?: 'due' | 'breached' | ''
  search?: string
  unassigned?: boolean
  sort?: string
  tag_id?: string
  list_id?: string
  segment_id?: string
}

// ------------------------------------------------------------------ rules & settings

export type AssignmentConditionKey = 'source' | 'country' | 'state' | 'city' | 'segment_id' | 'lifecycle_stage'

export interface AssignmentRuleInput {
  name: string
  active: boolean
  conditions: Partial<Record<AssignmentConditionKey, string>>
  user_ids: string[]
  max_open_per_user: number | null
}

export interface AssignmentRule extends AssignmentRuleInput {
  id: string
  position: number
  assigned_count: number
}

export type ScoringOperator = 'eq' | 'neq' | 'contains' | 'set' | 'not_set'
export type ScoringEvent =
  | 'email_opened'
  | 'email_clicked'
  | 'email_bounced'
  | 'email_unsubscribed'
  | 'sms_delivered'
  | 'sms_replied'
  | 'call_answered'
  | 'call_opted_out'
  | 'note_added'
  | 'activity_logged'
  | 'deal_created'
  | 'form_submitted'

export interface ScoringRuleInput {
  kind: 'fit' | 'engagement'
  field?: string | null
  operator?: ScoringOperator | null
  value?: string | null
  event?: ScoringEvent | null
  points: number
  max_points?: number | null
  active: boolean
}

export interface ScoringRule extends ScoringRuleInput {
  id: string
}

export interface CrmSettings {
  engagement_window_days: number
  hot_score_threshold: number
  sla_enabled: boolean
  sla_minutes: number
}

// ------------------------------------------------------------------ reports

interface Bucket {
  deals: number
  total: Money
  weighted: Money
}

export interface ForecastMonth extends Bucket {
  month: string
  won: Money
  commit: Money
  best_case: Money
}

export interface ForecastReport {
  pipeline_id: string
  currency: CurrencyCode
  months: ForecastMonth[]
  overdue: Bucket
  no_close_date: Bucket
  other_currency_deals: number
}

export interface WinLossReport {
  pipeline_id: string
  currency: CurrencyCode
  days: number
  won: number
  lost: number
  win_rate: number | null
  won_amount: Money
  average_won_amount: Money
  average_cycle_days: number | null
  lost_reasons: { reason: string; count: number; amount: Money }[]
}

export interface ConversionReport {
  pipeline_id: string
  days: number
  created: number
  stages: { stage_id: string; name: string; kind: StageKind; reached: number; average_days: number | null; conversion: number | null }[]
}

export interface LeaderboardReport {
  pipeline_id: string
  currency: CurrencyCode
  days: number
  rows: {
    owner: UserRef
    won: number
    won_amount: Money
    lost: number
    open: number
    open_amount: Money
    activities: number
    tasks_done: number
  }[]
}

export interface OverviewReport {
  pipeline_id: string
  currency: CurrencyCode
  open_deals: number
  open_amount: Money
  weighted_amount: Money
  rotting_deals: number
  won_this_month: number
  won_amount_this_month: Money
  win_rate_90d: number | null
  average_cycle_days: number | null
}
