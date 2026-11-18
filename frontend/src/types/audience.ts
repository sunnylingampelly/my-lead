export type Channel = 'email' | 'sms' | 'voice'
export type ContactStatus = 'active' | 'unsubscribed' | 'bounced' | 'blocked'

export interface TagRef {
  id: string
  name: string
  color: string
}

export interface ContactListItem {
  id: string
  first_name: string | null
  last_name: string | null
  full_name: string
  email: string | null
  phone: string | null
  phone_display: string | null
  phone_country: string | null
  company: string | null
  city: string | null
  state: string | null
  country: string | null
  status: ContactStatus
  email_consent: boolean
  sms_consent: boolean
  voice_consent: boolean
  email_unsubscribed: boolean
  sms_unsubscribed: boolean
  voice_unsubscribed: boolean
  tags: TagRef[]
  created_at: string
  last_activity_at: string | null
}

export interface ContactDetail extends ContactListItem {
  phone_type: string | null
  postal_code: string | null
  timezone: string | null
  source: string | null
  attributes: Record<string, unknown>
  lists: { id: string; name: string }[]
  email_unsubscribed_at: string | null
  sms_unsubscribed_at: string | null
  voice_unsubscribed_at: string | null
  jurisdiction: string | null
  jurisdiction_name: string
  eligibility: Record<Channel, { eligible: boolean; reasons: string[] }>
  updated_at: string
}

export interface ContactFilters {
  search?: string
  status?: ContactStatus | ''
  tag_id?: string
  list_id?: string
  segment_id?: string
  eligible_for?: Channel | ''
  country?: string
}

export interface ConsentInput {
  email: boolean
  sms: boolean
  voice: boolean
  source?: string
  evidence?: string
  consent_reference?: string
}

export interface ContactInput {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  phone_country?: string | null
  company?: string | null
  country?: string | null
  state?: string | null
  city?: string | null
  postal_code?: string | null
  source?: string | null
  attributes?: Record<string, unknown>
  tag_ids?: string[]
  list_ids?: string[]
  consent?: ConsentInput
  status?: ContactStatus
}

export interface Attribute {
  id: string
  key: string
  label: string
  data_type: 'text' | 'number' | 'date' | 'boolean' | 'select'
  options: string[]
  description: string | null
  created_at: string
}

export interface TagWithCount extends TagRef {
  contact_count: number
  created_at: string
}

export interface ContactListInfo {
  id: string
  name: string
  description: string | null
  contact_count: number
  created_at: string
  updated_at: string
}

export interface SegmentCondition {
  type: 'condition'
  field: string
  operator: string
  value?: unknown
}

export interface SegmentGroup {
  type: 'group'
  match: 'all' | 'any'
  conditions: (SegmentCondition | SegmentGroup)[]
}

export interface Segment {
  id: string
  name: string
  description: string | null
  rules: SegmentGroup
  last_count: number | null
  last_counted_at: string | null
  created_at: string
  updated_at: string
}

export interface SegmentPreview {
  count: number
  eligible: Record<Channel, number>
  sample: ContactListItem[]
}

export interface FieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'date' | 'boolean' | 'select' | 'tag' | 'list' | 'channel'
  group: string
  operators: string[]
  options?: string[]
}

export interface FieldCatalog {
  fields: FieldDef[]
  tags: { id: string; name: string }[]
  lists: { id: string; name: string }[]
}

export interface Suppression {
  id: string
  channel: Channel
  value_masked: string
  reason: string
  source: string | null
  note: string | null
  created_at: string
}

export interface ImportJob {
  id: string
  file_name: string
  file_type: 'csv' | 'xlsx'
  file_size: number
  columns: string[]
  preview: Record<string, string>[]
  mapping: Record<string, string>
  options: Record<string, unknown>
  status: 'uploaded' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'
  total_rows: number
  processed_rows: number
  created_count: number
  updated_count: number
  skipped_count: number
  duplicate_count: number
  invalid_count: number
  failed_count: number
  error: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  progress: number
  suggested_mapping: Record<string, string>
}

export interface ImportValidation {
  total_rows: number
  valid_rows: number
  new_contacts: number
  existing_matches: number
  duplicates_in_file: number
  invalid_rows: number
  empty_rows: number
  errors: { row: number; reason: string }[]
  countries: Record<string, number>
  us_numbers: number
  india_numbers: number
}

export interface ImportOptions {
  duplicate_handling: 'skip' | 'update'
  list_id?: string | null
  new_list_name?: string | null
  tag_names: string[]
  source?: string | null
  consent: ConsentInput & { confirmed: boolean }
}

export interface Activity {
  id: string
  type: string
  description: string
  meta: Record<string, unknown>
  created_at: string
  actor_name: string | null
}

export interface ConsentRecord {
  id: string
  channel: Channel
  status: 'granted' | 'revoked'
  method: string
  source: string | null
  evidence: string | null
  consent_reference: string | null
  jurisdiction: string | null
  created_at: string
  recorded_by_name: string | null
}

export interface AudienceOverview {
  total: number
  active: number
  unsubscribed: number
  bounced: number
  blocked: number
  new_last_7_days: number
  with_email: number
  with_phone: number
  consent: Record<Channel, number>
  reachable: Record<Channel, number>
  countries: { country: string; count: number }[]
  growth: { date: string; new: number; total: number }[]
  recent_imports: {
    id: string
    file_name: string
    status: ImportJob['status']
    total_rows: number
    created_count: number
    updated_count: number
    created_at: string
  }[]
}

export interface Compliance {
  region: string
  region_name: string
  currency: string
  dial_code: string
  marketing_window: [string, string]
  sms_voice_requires_written_consent: boolean
  email_requires_postal_address: boolean
  regulations: { name: string; summary: string }[]
  checks: { key: string; label: string; required: boolean; done: boolean; pending_module?: string }[]
  disclaimer: string
}
