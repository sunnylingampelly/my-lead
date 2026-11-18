export type RoleKey = 'owner' | 'admin' | 'application_manager' | 'campaign_manager' | 'analyst' | 'viewer' | 'platform_support'

export interface User {
  id: string
  email: string
  full_name: string
  timezone: string
  email_verified: boolean
  is_platform_admin: boolean
  platform_role?: 'super_admin' | 'support' | null
  last_organization_id: string | null
  last_application_id: string | null
  created_at: string
}

export interface AuthResponse {
  access_token: string
  token_type: 'bearer'
  expires_in: number
  user: User
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface Organization {
  id: string
  name: string
  slug: string
  status: 'active' | 'suspended'
  industry: string | null
  website: string | null
  country: string | null
  created_at: string
  role: RoleKey
  role_label: string
  permissions: string[]
  application_count: number
  /** Set when platform staff see this organization through a read-only support session. */
  support_access_expires_at?: string | null
}

export interface Application {
  id: string
  organization_id: string
  name: string
  slug: string
  description: string | null
  color: string
  timezone: string
  default_country: string | null
  status: string
  created_at: string
  updated_at: string
  role: RoleKey
  permissions: string[]
}

export interface ApplicationSettings {
  contact_identity_rule: 'email' | 'phone' | 'email_or_phone'
  default_email_provider: string
  default_sms_provider: string
  default_voice_provider: string
  quiet_hours_start: string
  quiet_hours_end: string
  business_name: string | null
  business_address: string | null
}

export interface Member {
  id: string
  user: { id: string; email: string; full_name: string }
  role: RoleKey
  role_label: string
  application_ids: string[]
  created_at: string
}

export interface Invitation {
  id: string
  email: string
  role: RoleKey
  role_label: string
  application_ids: string[]
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  expires_at: string
  created_at: string
  invited_by_name: string | null
}

export interface InvitationPreview {
  organization_name: string
  email: string
  role: RoleKey
  role_label: string
  expires_at: string
  status: Invitation['status']
  account_exists: boolean
}

export interface RoleInfo {
  key: RoleKey
  name: string
  description: string
  rank: number
  is_org_wide: boolean
  permissions: string[]
  assignable: boolean
}

export interface AppMember {
  user_id: string
  full_name: string
  email: string
  org_role: RoleKey
  app_role: RoleKey | null
  effective_role: RoleKey
  access: 'org_wide' | 'explicit'
}

export interface AuditLog {
  id: string
  action: string
  summary: string | null
  target_type: string | null
  target_id: string | null
  application_id: string | null
  actor_name: string | null
  created_at: string
}

export interface SessionInfo {
  id: string
  user_agent: string | null
  ip_address: string | null
  created_at: string
  last_used_at: string | null
  expires_at: string
  current: boolean
}

export interface DashboardData {
  application: { id: string; name: string; timezone: string; created_at: string }
  your_role: RoleKey
  team: { with_access: number; organization_members: number; pending_invitations: number }
  checklist: { key: string; label: string; done: boolean; available?: boolean; module?: string }[]
  recent_activity: { id: string; action: string; summary: string | null; actor_name: string | null; created_at: string }[]
  modules: Record<string, boolean>
  is_org_wide_role: boolean
  segment_count: number
  audience: import('./audience').AudienceOverview | null
}

export interface MailboxItem {
  id: string
  to: string
  from: string
  subject: string
  created_at: string
  text: string
  html: string
}
