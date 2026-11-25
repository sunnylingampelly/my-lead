import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { http } from './client'
import type { Page } from '@/types/api'
import type { CampaignAudience, Estimate, RecipientIds } from '@/types/email'
import type {
  DltConfig,
  SmsCampaign,
  SmsCampaignListItem,
  SmsInboundItem,
  SmsMessage,
  SmsOverview,
  SmsReadiness,
  SmsReport,
  SmsSender,
  SmsTemplate,
} from '@/types/sms'

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)
const clean = (p: object) => ({ params: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) })
type Paging = { page: number; page_size: number; status?: string; search?: string }

export const smsApi = (appId: string) => {
  const b = `/apps/${appId}/sms`
  return {
    overview: () => data(http.get<SmsOverview>(`${b}/overview`)),
    registration: () => data(http.get<DltConfig>(`${b}/registration`)),
    updateRegistration: (body: Partial<DltConfig> & { attest?: boolean }) => data(http.put<DltConfig>(`${b}/registration`, body)),

    senders: () => data(http.get<SmsSender[]>(`${b}/senders`)),
    createSender: (body: Pick<SmsSender, 'sender_id' | 'country' | 'kind' | 'provider'> & { dlt_header_id?: string | null }) =>
      data(http.post<SmsSender>(`${b}/senders`, body)),
    attestSender: (id: string) => data(http.post<SmsSender>(`${b}/senders/${id}/attest`)),
    defaultSender: (id: string) => data(http.post<SmsSender>(`${b}/senders/${id}/default`)),
    deleteSender: (id: string) => data(http.delete(`${b}/senders/${id}`)),

    templates: () => data(http.get<SmsTemplate[]>(`${b}/templates`)),
    createTemplate: (body: Partial<SmsTemplate> & { name: string; body: string }) => data(http.post<SmsTemplate>(`${b}/templates`, body)),
    updateTemplate: (id: string, body: Partial<SmsTemplate>) => data(http.patch<SmsTemplate>(`${b}/templates/${id}`, body)),
    deleteTemplate: (id: string) => data(http.delete(`${b}/templates/${id}`)),

    campaigns: (p: Paging) => data(http.get<Page<SmsCampaignListItem>>(`${b}/campaigns`, clean(p))),
    campaign: (id: string) => data(http.get<SmsCampaign>(`${b}/campaigns/${id}`)),
    createCampaign: (body: { name: string; category?: string; template_id?: string | null; audience?: CampaignAudience }) => data(http.post<SmsCampaign>(`${b}/campaigns`, body)),
    recipientIds: (id: string, status?: string) => data(http.get<RecipientIds>(`${b}/campaigns/${id}/recipients/ids`, { params: status ? { status } : {} })),
    updateCampaign: (id: string, body: Partial<SmsCampaign>) => data(http.patch<SmsCampaign>(`${b}/campaigns/${id}`, body)),
    deleteCampaign: (id: string) => data(http.delete(`${b}/campaigns/${id}`)),
    duplicateCampaign: (id: string) => data(http.post<SmsCampaign>(`${b}/campaigns/${id}/duplicate`)),
    estimate: (audience: CampaignAudience, country?: string | null) => data(http.post<Estimate>(`${b}/campaigns/estimate`, { ...audience, country })),
    readiness: (id: string) => data(http.get<SmsReadiness>(`${b}/campaigns/${id}/readiness`)),
    test: (id: string, phones: string[]) =>
      data(http.post<{ provider: string; segments: number; results: { phone: string; accepted: boolean; error: string | null }[] }>(`${b}/campaigns/${id}/test`, { phones })),
    schedule: (id: string, scheduled_at: string, timezone: string) => data(http.post<SmsCampaign>(`${b}/campaigns/${id}/schedule`, { scheduled_at, timezone })),
    unschedule: (id: string) => data(http.post<SmsCampaign>(`${b}/campaigns/${id}/unschedule`)),
    send: (id: string) => data(http.post<SmsCampaign>(`${b}/campaigns/${id}/send`)),
    pause: (id: string) => data(http.post<SmsCampaign>(`${b}/campaigns/${id}/pause`)),
    resume: (id: string) => data(http.post<SmsCampaign>(`${b}/campaigns/${id}/resume`)),
    cancel: (id: string) => data(http.post<SmsCampaign>(`${b}/campaigns/${id}/cancel`)),
    report: (id: string) => data(http.get<SmsReport>(`${b}/campaigns/${id}/report`)),
    messages: (id: string, p: Paging) => data(http.get<Page<SmsMessage>>(`${b}/campaigns/${id}/messages`, clean(p))),

    inbound: (p: { page: number; page_size: number }) => data(http.get<Page<SmsInboundItem>>(`${b}/inbound`, { params: p })),
    simulateInbound: (body: { from_phone: string; to_sender: string; body: string; event_id: string }) =>
      data(http.post<{ keyword: string | null; contacts_updated: number }>(`${b}/simulate-inbound`, body)),
  }
}

export const sqk = {
  all: (appId: string) => ['sms', appId] as const,
  overview: (appId: string) => ['sms', appId, 'overview'] as const,
  registration: (appId: string) => ['sms', appId, 'registration'] as const,
  senders: (appId: string) => ['sms', appId, 'senders'] as const,
  templates: (appId: string) => ['sms', appId, 'templates'] as const,
  campaigns: (appId: string, p: object) => ['sms', appId, 'campaigns', p] as const,
  campaign: (appId: string, id: string) => ['sms', appId, 'campaign', id] as const,
  readiness: (appId: string, id: string) => ['sms', appId, 'readiness', id] as const,
  report: (appId: string, id: string) => ['sms', appId, 'report', id] as const,
  inbound: (appId: string, p: object) => ['sms', appId, 'inbound', p] as const,
}

const LIVE = ['queued', 'sending']

export const useSmsOverview = (appId: string) => useQuery({ queryKey: sqk.overview(appId), queryFn: () => smsApi(appId).overview(), refetchOnMount: 'always' })
export const useSmsRegistration = (appId: string) => useQuery({ queryKey: sqk.registration(appId), queryFn: () => smsApi(appId).registration() })
export const useSmsSenders = (appId: string) => useQuery({ queryKey: sqk.senders(appId), queryFn: () => smsApi(appId).senders(), refetchOnMount: 'always' })
export const useSmsTemplates = (appId: string) => useQuery({ queryKey: sqk.templates(appId), queryFn: () => smsApi(appId).templates() })
export const useSmsCampaigns = (appId: string, p: Paging) =>
  useQuery({
    queryKey: sqk.campaigns(appId, p),
    queryFn: () => smsApi(appId).campaigns(p),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((c) => LIVE.includes(c.status)) ? 3000 : false),
  })
export const useSmsCampaign = (appId: string, id: string) =>
  useQuery({
    queryKey: sqk.campaign(appId, id),
    queryFn: () => smsApi(appId).campaign(id),
    refetchInterval: (q) => (q.state.data && LIVE.includes(q.state.data.status) ? 2000 : false),
  })
export const useSmsReport = (appId: string, id: string, live: boolean) =>
  useQuery({ queryKey: sqk.report(appId, id), queryFn: () => smsApi(appId).report(id), refetchInterval: live ? 2500 : 15_000 })
export const useSmsInbound = (appId: string, p: { page: number; page_size: number }) =>
  useQuery({ queryKey: sqk.inbound(appId, p), queryFn: () => smsApi(appId).inbound(p), placeholderData: keepPreviousData })
