import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { http } from './client'
import type { Page } from '@/types/api'

/** Newest database backup (scripts/backup_db.py), from the backup folder's file times. */
export interface BackupStatus {
  configured_dir: boolean
  count: number
  last_backup_at: string | null
  last_backup_file: string | null
  last_backup_bytes: number | null
  age_hours: number | null
  stale: boolean
}

export interface AdminOverview {
  organizations: number
  suspended_organizations: number
  users: number
  applications: number
  contacts: number
  last_24h: { emails: number; texts: number; calls: number; journeys: number; webhooks: Record<string, number> }
  failed_runs: number
  wallet_balances: Record<string, number>
  communication_mode: string
}

export interface AdminOrg {
  id: string
  name: string
  slug: string
  country: string | null
  status: 'active' | 'suspended'
  created_at: string
  members: number
  applications: number
  wallet: { currency: string; balance: number } | null
}

export interface AdminOrgDetail extends Omit<AdminOrg, 'members' | 'applications' | 'wallet'> {
  industry: string | null
  website: string | null
  members: { id: string; name: string; email: string; role: string }[]
  applications: { id: string; name: string; country: string | null; created_at: string }[]
  wallet: { currency: string; balance: number; available: number; held: number }
  transactions: { id: string; type: string; amount: number; description: string; balance_after: number; created_at: string }[]
}

export interface AdminUser {
  id: string
  name: string
  email: string
  is_active: boolean
  is_platform_admin: boolean
  email_verified: boolean
  organizations: number
  last_login_at: string | null
  created_at: string
}

export interface AdminWebhook {
  id: string
  provider: string
  channel: string
  event_type: string | null
  status: string
  error: string | null
  received_at: string
  processed_at: string | null
}

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)
const params = (p: object) => ({ params: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) })

export const adminApi = {
  overview: () => data(http.get<AdminOverview>('/admin/overview')),
  settings: () => data(http.get<Record<string, unknown> & { providers: Record<string, Record<string, boolean>>; pricing: Record<string, unknown>; backups?: BackupStatus }>('/admin/settings')),
  orgs: (p: { page: number; page_size: number; search?: string; status?: string }) => data(http.get<Page<AdminOrg>>('/admin/organizations', params(p))),
  org: (id: string) => data(http.get<AdminOrgDetail>(`/admin/organizations/${id}`)),
  setOrgStatus: (id: string, action: 'suspend' | 'reactivate', reason: string) => data(http.post<AdminOrgDetail>(`/admin/organizations/${id}/${action}`, { reason })),
  adjustWallet: (id: string, body: { kind: string; amount: string; reason: string }) =>
    data(http.post<{ balance: number; currency: string }>(`/admin/organizations/${id}/wallet`, { ...body, idempotency_key: crypto.randomUUID() })),
  users: (p: { page: number; page_size: number; search?: string }) => data(http.get<Page<AdminUser>>('/admin/users', params(p))),
  setUserActive: (id: string, action: 'suspend' | 'reactivate', reason: string) => data(http.post(`/admin/users/${id}/${action}`, { reason })),
  webhooks: (p: { page: number; page_size: number; status?: string; provider?: string }) => data(http.get<Page<AdminWebhook>>('/admin/webhooks', params(p))),
  retryWebhook: (id: string) => data(http.post<{ status: string }>(`/admin/webhooks/${id}/retry`)),
}

export interface StaffMember {
  id: string
  name: string
  email: string
  role: 'super_admin' | 'support'
  is_active: boolean
  last_login_at: string | null
}

export interface SupportSession {
  id: string
  organization_id: string
  organization: string
  user: string
  reason: string
  created_at: string
  expires_at: string
  active: boolean
}

export const staffApi = {
  list: () => data(http.get<StaffMember[]>('/admin/staff')),
  add: (email: string, role: string) => data(http.post<StaffMember>('/admin/staff', { email, role })),
  change: (id: string, role: string) => data(http.patch<StaffMember>(`/admin/staff/${id}`, { role })),
  remove: (id: string) => data(http.delete(`/admin/staff/${id}`)),
  sessions: (mine = false) => data(http.get<SupportSession[]>('/admin/support-sessions', { params: mine ? { mine: true } : {} })),
  startSession: (orgId: string, reason: string, minutes: number) => data(http.post<SupportSession>(`/admin/organizations/${orgId}/support-session`, { reason, minutes })),
  endSession: (id: string) => data(http.post(`/admin/support-sessions/${id}/end`)),
}

export const useStaff = () => useQuery({ queryKey: ['admin', 'staff'], queryFn: staffApi.list })
export const useSupportSessions = (mine = false) => useQuery({ queryKey: ['admin', 'sessions', mine], queryFn: () => staffApi.sessions(mine), refetchInterval: 30_000 })
export const useAdminOverview = () => useQuery({ queryKey: ['admin', 'overview'], queryFn: adminApi.overview })
export const useAdminSettings = () => useQuery({ queryKey: ['admin', 'settings'], queryFn: adminApi.settings })
export const useAdminOrgs = (p: { page: number; page_size: number; search?: string; status?: string }) =>
  useQuery({ queryKey: ['admin', 'orgs', p], queryFn: () => adminApi.orgs(p), placeholderData: keepPreviousData })
export const useAdminOrg = (id: string | null) => useQuery({ queryKey: ['admin', 'org', id], queryFn: () => adminApi.org(id!), enabled: !!id })
export const useAdminUsers = (p: { page: number; page_size: number; search?: string }) =>
  useQuery({ queryKey: ['admin', 'users', p], queryFn: () => adminApi.users(p), placeholderData: keepPreviousData })
export const useAdminWebhooks = (p: { page: number; page_size: number; status?: string; provider?: string }) =>
  useQuery({ queryKey: ['admin', 'webhooks', p], queryFn: () => adminApi.webhooks(p), placeholderData: keepPreviousData })
