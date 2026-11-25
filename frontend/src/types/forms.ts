/** Lead forms: mirrors backend/app/schemas/forms.py. */

export const FIELD_TYPES = [
  'first_name',
  'last_name',
  'email',
  'phone',
  'text',
  'textarea',
  'number',
  'select',
  'radio',
  'checkboxes',
  'date',
  'consent',
  'hidden',
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

/** Contact standard fields a form field can map to. */
export const STANDARD_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'company', 'city', 'state', 'country', 'postal_code'] as const
export const FONTS = ['system', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Poppins', 'Montserrat', 'Nunito', 'Source Sans 3', 'Merriweather', 'Playfair Display'] as const

export type Channel = 'email' | 'sms' | 'voice'

export interface FieldOption {
  label: string
  value: string
}

export type ConditionOp = 'equals' | 'not_equals' | 'contains' | 'is_set' | 'is_not_set'

export interface FieldCondition {
  field: string
  op: ConditionOp
  value: string
}

export type HiddenKind = 'fixed' | 'url_param' | 'page_url' | 'referrer' | 'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_term' | 'utm_content'

export interface HiddenSource {
  kind: HiddenKind
  /** The fixed value, or the URL parameter name. */
  value: string
}

export interface FieldMap {
  kind: 'none' | 'standard' | 'custom' | 'tag'
  key: string
}

export interface FormField {
  id: string
  type: FieldType
  label: string
  placeholder: string
  help: string
  required: boolean
  default: string
  width: 'full' | 'half'
  step: number
  options: FieldOption[]
  map_to: FieldMap
  condition: FieldCondition | null
  hidden: HiddenSource | null
  privacy_url: string | null
  consent_channels: Channel[]
  default_country: string | null
  min: number | null
  max: number | null
  max_length: number | null
}

export interface FormStep {
  id: string
  title: string
}

export interface FormDesign {
  theme: 'light' | 'dark'
  primary_color: string
  background_color: string
  text_color: string
  font: string
  use_site_font: boolean
  radius: number
  button_text: string
  button_color: string
  button_text_color: string
  label_position: 'top' | 'left' | 'hidden'
  max_width: number
  show_title: boolean
}

export interface FormSuccess {
  mode: 'message' | 'redirect' | 'both'
  message_html: string
  redirect_url: string | null
  pass_values: boolean
  redirect_delay: number
}

export interface FormDisplay {
  mode: 'inline' | 'popup' | 'slide_in' | 'floating'
  trigger: 'load' | 'scroll' | 'exit' | 'click'
  delay_seconds: number
  scroll_percent: number
  frequency: 'once' | 'days' | 'always'
  frequency_days: number
  hide_after_submit: boolean
  devices: 'all' | 'desktop' | 'mobile'
  position: 'bottom_right' | 'bottom_left'
  button_label: string
}

export interface FormSettings {
  list_ids: string[]
  tag_ids: string[]
  source: string
  subscribe_on_submit: Channel[]
  consent_text: string
  double_opt_in: boolean
  confirm_sender_id: string | null
  confirm_subject: string
  allowed_domains: string[]
  notify_user_ids: string[]
  notify_email: boolean
  notify_in_app: boolean
  assign_owner: boolean
  set_lifecycle_lead: boolean
  create_deal: boolean
  deal_pipeline_id: string | null
  deal_stage_id: string | null
  deal_title: string
  duplicate: 'update' | 'create'
  turnstile: boolean
}

export interface FormDefinition {
  title: string
  description: string
  fields: FormField[]
  steps: FormStep[]
  design: FormDesign
  success: FormSuccess
  display: FormDisplay
  settings: FormSettings
}

export type FormStatus = 'draft' | 'published' | 'paused'

export interface EmbedInfo {
  script_url: string
  iframe_url: string
  hosted_url: string
  inline: string
  popup: string
  slide_in: string
  floating: string
  button: string
}

export interface FormListItem {
  id: string
  public_id: string
  name: string
  status: FormStatus
  template: string | null
  published_version: number | null
  has_unpublished_changes: boolean
  views_30d: number
  submissions_30d: number
  /** submissions / views, 0..100 */
  conversion_30d: number
  last_submission_at: string | null
  created_at: string
  updated_at: string
}

export interface FormOut {
  id: string
  public_id: string
  name: string
  status: FormStatus
  template: string | null
  draft: FormDefinition
  published_version: number | null
  published_at: string | null
  has_unpublished_changes: boolean
  /** Starter: "Powered by Signalcraft" badge */
  branding: boolean
  embed: EmbedInfo
  created_at: string
  updated_at: string
}

export interface FormUpdate {
  name?: string
  draft?: FormDefinition
}

export interface VersionOut {
  version: number
  created_at: string
  published_by_name: string | null
}

export type SubmissionStatus = 'new' | 'confirmed' | 'pending_confirmation' | 'spam'

export interface SubmissionOut {
  id: string
  status: SubmissionStatus | string
  spam_reason: string | null
  values: Record<string, unknown>
  /** field id -> label (from the version submitted) */
  labels: Record<string, string>
  contact_id: string | null
  contact_name: string | null
  deal_id: string | null
  page_url: string | null
  referrer: string | null
  utm: Record<string, string>
  country: string | null
  created_at: string
  confirmed_at: string | null
}

export interface SubmissionFilters {
  search?: string
  status?: string
  date_from?: string
  date_to?: string
}

export interface CountRow {
  value: string
  count: number
}

export interface DailyRow {
  date: string
  views: number
  starts: number
  submissions: number
}

export interface AnalyticsOut {
  days: number
  views: number
  starts: number
  submissions: number
  conversion: number
  start_rate: number
  completion_rate: number
  daily: DailyRow[]
  top_pages: CountRow[]
  top_referrers: CountRow[]
  top_utm_sources: CountRow[]
}

export interface TemplateOut {
  key: string
  name: string
  description: string
}

export interface FormsMeta {
  standard_fields: { key: string; label: string }[]
  custom_fields: { key: string; label: string; data_type: string; options: string[] }[]
  lists: { id: string; name: string }[]
  tags: { id: string; name: string }[]
  team: { id: string; full_name: string; email: string }[]
  pipelines: { id: string; name: string; stages: { id: string; name: string }[] }[]
  senders: { id: string; from_name: string; from_email: string }[]
  fonts: string[]
  turnstile_available: boolean
  branding: boolean
  usage: { used: number; limit: number | null }
  countries: { code: string; name: string; dial: string }[]
  default_country: string | null
}
