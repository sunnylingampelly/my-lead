import { useQuery } from '@tanstack/react-query'
import { http } from './client'
import type { Page } from '@/types/api'

export interface AppNotification {
  id: string
  type: string
  level: 'info' | 'success' | 'warning' | 'error'
  title: string
  body: string | null
  link: string | null
  organization_id: string | null
  application_id: string | null
  read_at: string | null
  created_at: string
}

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)

export const notificationsApi = {
  list: () => data(http.get<Page<AppNotification>>('/notifications', { params: { page_size: 30 } })),
  unread: () => data(http.get<{ unread: number }>('/notifications/unread-count')),
  read: (id: string) => data(http.post(`/notifications/${id}/read`)),
  readAll: () => data(http.post<{ unread: number }>('/notifications/read-all')),
}

export const nqk = { all: ['notifications'] as const, unread: ['notifications', 'unread'] as const }

export const useUnreadCount = () =>
  useQuery({ queryKey: nqk.unread, queryFn: notificationsApi.unread, refetchInterval: 30_000, refetchOnWindowFocus: true })

export const useNotifications = (enabled: boolean) =>
  useQuery({ queryKey: [...nqk.all, 'list'], queryFn: notificationsApi.list, enabled })
