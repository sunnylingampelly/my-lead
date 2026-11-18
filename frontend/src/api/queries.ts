/** TanStack Query hooks and cache keys. */
import { useQuery } from '@tanstack/react-query'
import { appApi, devApi, orgApi, userApi } from './services'

export const qk = {
  orgs: ['orgs'] as const,
  org: (id: string) => ['orgs', id] as const,
  roles: (id: string) => ['orgs', id, 'roles'] as const,
  members: (id: string, params: object) => ['orgs', id, 'members', params] as const,
  invitations: (id: string) => ['orgs', id, 'invitations'] as const,
  audit: (id: string, params: object) => ['orgs', id, 'audit', params] as const,
  apps: (orgId: string) => ['apps', 'list', orgId] as const,
  app: (id: string) => ['apps', id] as const,
  appSettings: (id: string) => ['apps', id, 'settings'] as const,
  appMembers: (id: string) => ['apps', id, 'members'] as const,
  dashboard: (id: string) => ['apps', id, 'dashboard'] as const,
  sessions: ['me', 'sessions'] as const,
  mailbox: (to?: string) => ['dev', 'mailbox', to ?? ''] as const,
}

export const useOrganizations = () => useQuery({ queryKey: qk.orgs, queryFn: orgApi.list })

export const useOrganization = (id?: string) =>
  useQuery({ queryKey: qk.org(id ?? ''), queryFn: () => orgApi.get(id!), enabled: !!id })

export const useRoles = (orgId?: string) =>
  useQuery({ queryKey: qk.roles(orgId ?? ''), queryFn: () => orgApi.roles(orgId!), enabled: !!orgId })

export const useMembers = (
  orgId: string,
  params: { page: number; page_size: number; search?: string },
  enabled = true,
) =>
  useQuery({
    queryKey: qk.members(orgId, params),
    queryFn: () => orgApi.members(orgId, params),
    enabled,
    placeholderData: (prev) => prev,
  })

export const useInvitations = (orgId: string) =>
  useQuery({ queryKey: qk.invitations(orgId), queryFn: () => orgApi.invitations(orgId) })

export const useAuditLogs = (orgId: string, params: { page: number; page_size: number }) =>
  useQuery({
    queryKey: qk.audit(orgId, params),
    queryFn: () => orgApi.auditLogs(orgId, params),
    placeholderData: (prev) => prev,
  })

export const useApplications = (orgId?: string) =>
  useQuery({ queryKey: qk.apps(orgId ?? ''), queryFn: () => appApi.list(orgId!), enabled: !!orgId })

export const useApplication = (id?: string) =>
  useQuery({ queryKey: qk.app(id ?? ''), queryFn: () => appApi.get(id!), enabled: !!id, retry: false })

export const useAppSettings = (id: string) =>
  useQuery({ queryKey: qk.appSettings(id), queryFn: () => appApi.settings(id) })

export const useAppMembers = (id: string) => useQuery({ queryKey: qk.appMembers(id), queryFn: () => appApi.members(id) })

export const useDashboard = (id: string) => useQuery({ queryKey: qk.dashboard(id), queryFn: () => appApi.dashboard(id), staleTime: 0, refetchOnMount: 'always' })

export const useSessions = () => useQuery({ queryKey: qk.sessions, queryFn: userApi.sessions })

export const useMailbox = (to?: string) =>
  useQuery({ queryKey: qk.mailbox(to), queryFn: () => devApi.mailbox(to), refetchInterval: 4000 })
