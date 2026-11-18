/** Typed REST calls, grouped by resource. Components never call http directly. */
import { http } from './client'
import type {
  AppMember,
  Application,
  ApplicationSettings,
  AuditLog,
  AuthResponse,
  DashboardData,
  Invitation,
  InvitationPreview,
  MailboxItem,
  Member,
  Organization,
  Page,
  RoleInfo,
  RoleKey,
  SessionInfo,
  User,
} from '@/types/api'

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)

export const authApi = {
  register: (body: { email: string; password: string; full_name: string; invitation_token?: string }) =>
    data(http.post<AuthResponse>('/auth/register', body)),
  login: (body: { email: string; password: string }) => data(http.post<AuthResponse>('/auth/login', body)),
  logout: () => data(http.post('/auth/logout')),
  verifyEmail: (token: string) => data(http.post<User>('/auth/verify-email', { token })),
  resendVerification: () => data(http.post<{ message: string }>('/auth/resend-verification')),
  forgotPassword: (email: string) => data(http.post<{ message: string }>('/auth/forgot-password', { email })),
  resetPassword: (token: string, new_password: string) =>
    data(http.post<{ message: string }>('/auth/reset-password', { token, new_password })),
}

export const userApi = {
  me: () => data(http.get<User>('/users/me')),
  update: (body: { full_name?: string; timezone?: string }) => data(http.patch<User>('/users/me', body)),
  changePassword: (body: { current_password: string; new_password: string }) =>
    data(http.post<{ message: string }>('/users/me/password', body)),
  setContext: (body: { organization_id?: string; application_id?: string }) =>
    data(http.put<User>('/users/me/context', body)),
  sessions: () => data(http.get<SessionInfo[]>('/users/me/sessions')),
  revokeSession: (id: string) => data(http.delete(`/users/me/sessions/${id}`)),
}

export interface OrgInput {
  name: string
  industry?: string | null
  website?: string | null
  country?: string | null
}

export const orgApi = {
  list: () => data(http.get<Organization[]>('/organizations')),
  get: (id: string) => data(http.get<Organization>(`/organizations/${id}`)),
  create: (body: OrgInput) => data(http.post<Organization>('/organizations', body)),
  update: (id: string, body: Partial<OrgInput>) => data(http.patch<Organization>(`/organizations/${id}`, body)),
  roles: (id: string) => data(http.get<RoleInfo[]>(`/organizations/${id}/roles`)),
  members: (id: string, params: { page?: number; page_size?: number; search?: string }) =>
    data(http.get<Page<Member>>(`/organizations/${id}/members`, { params })),
  updateMember: (id: string, memberId: string, body: { role?: RoleKey; application_ids?: string[] }) =>
    data(http.patch<Member>(`/organizations/${id}/members/${memberId}`, body)),
  removeMember: (id: string, memberId: string) => data(http.delete(`/organizations/${id}/members/${memberId}`)),
  invitations: (id: string) => data(http.get<Invitation[]>(`/organizations/${id}/invitations`)),
  invite: (id: string, body: { email: string; role: RoleKey; application_ids: string[] }) =>
    data(http.post<Invitation>(`/organizations/${id}/invitations`, body)),
  resendInvite: (id: string, invId: string) =>
    data(http.post<Invitation>(`/organizations/${id}/invitations/${invId}/resend`)),
  revokeInvite: (id: string, invId: string) => data(http.delete(`/organizations/${id}/invitations/${invId}`)),
  auditLogs: (id: string, params: { page?: number; page_size?: number; application_id?: string }) =>
    data(http.get<Page<AuditLog>>(`/organizations/${id}/audit-logs`, { params })),
}

export const invitationApi = {
  preview: (token: string) => data(http.post<InvitationPreview>('/invitations/preview', { token })),
  accept: (token: string) => data(http.post<Organization>('/invitations/accept', { token })),
}

export interface AppInput {
  name: string
  description?: string | null
  color?: string
  timezone?: string
  default_country?: string | null
}

export const appApi = {
  list: (organizationId: string) =>
    data(http.get<Application[]>('/applications', { params: { organization_id: organizationId } })),
  get: (id: string) => data(http.get<Application>(`/applications/${id}`)),
  create: (body: AppInput & { organization_id: string }) => data(http.post<Application>('/applications', body)),
  update: (id: string, body: Partial<AppInput>) => data(http.patch<Application>(`/applications/${id}`, body)),
  remove: (id: string, confirm_name: string) => data(http.delete(`/applications/${id}`, { data: { confirm_name } })),
  settings: (id: string) => data(http.get<ApplicationSettings>(`/applications/${id}/settings`)),
  updateSettings: (id: string, body: Partial<ApplicationSettings>) =>
    data(http.patch<ApplicationSettings>(`/applications/${id}/settings`, body)),
  members: (id: string) => data(http.get<AppMember[]>(`/applications/${id}/members`)),
  addMember: (id: string, body: { user_id: string; role?: RoleKey | null }) =>
    data(http.post(`/applications/${id}/members`, body)),
  removeMember: (id: string, userId: string) => data(http.delete(`/applications/${id}/members/${userId}`)),
  dashboard: (id: string) => data(http.get<DashboardData>(`/apps/${id}/dashboard`)),
}

export const devApi = {
  mailbox: (to?: string) =>
    data(http.get<{ items: MailboxItem[]; simulation: boolean }>('/dev/mailbox', { params: to ? { to } : {} })),
}
