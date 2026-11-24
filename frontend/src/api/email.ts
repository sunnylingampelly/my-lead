import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { http } from './client'
import type { Page } from '@/types/api'
import type {
  Campaign,
  CampaignAudience,
  CampaignListItem,
  CampaignReport,
  EmailMessage,
  EmailOverview,
  EmailTemplate,
  Estimate,
  Preview,
  Readiness,
  RecipientIds,
  Sender,
  Variables,
} from '@/types/email'

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)

export const emailApi = (appId: string) => {
  const b = `/apps/${appId}/email`
  return {
    overview: () => data(http.get<EmailOverview>(`${b}/overview`)),
    variables: () => data(http.get<Variables>(`${b}/variables`)),

    senders: () => data(http.get<Sender[]>(`${b}/senders`)),
    createSender: (body: { from_name: string; from_email: string; reply_to?: string | null }) =>
      data(http.post<Sender>(`${b}/senders`, body)),
    updateSender: (id: string, body: Partial<Pick<Sender, 'from_name' | 'reply_to' | 'is_default'>>) =>
      data(http.patch<Sender>(`${b}/senders/${id}`, body)),
    resendSender: (id: string) => data(http.post<Sender>(`${b}/senders/${id}/resend`)),
    deleteSender: (id: string) => data(http.delete(`${b}/senders/${id}`)),
    senderTips: (id: string) => data(http.get<{ tips: string[]; domain: string }>(`${b}/senders/${id}/tips`)),

    templates: () => data(http.get<EmailTemplate[]>(`${b}/templates`)),
    template: (id: string) => data(http.get<EmailTemplate>(`${b}/templates/${id}`)),
    createTemplate: (body: Partial<EmailTemplate> & { name: string }) => data(http.post<EmailTemplate>(`${b}/templates`, body)),
    updateTemplate: (id: string, body: Partial<EmailTemplate>) => data(http.patch<EmailTemplate>(`${b}/templates/${id}`, body)),
    duplicateTemplate: (id: string) => data(http.post<EmailTemplate>(`${b}/templates/${id}/duplicate`)),
    deleteTemplate: (id: string) => data(http.delete(`${b}/templates/${id}`)),

    campaigns: (params: { page: number; page_size: number; status?: string; search?: string }) =>
      data(http.get<Page<CampaignListItem>>(`${b}/campaigns`, { params: Object.fromEntries(Object.entries(params).filter(([, v]) => v)) })),
    campaign: (id: string) => data(http.get<Campaign>(`${b}/campaigns/${id}`)),
    recipientIds: (id: string, status?: string) =>
      data(http.get<RecipientIds>(`${b}/campaigns/${id}/recipients/ids`, { params: status ? { status } : {} })),
    createCampaign: (body: { name: string; description?: string | null; campaign_type?: string; template_id?: string | null; audience?: CampaignAudience }) =>
      data(http.post<Campaign>(`${b}/campaigns`, body)),
    updateCampaign: (id: string, body: Partial<Campaign>) => data(http.patch<Campaign>(`${b}/campaigns/${id}`, body)),
    deleteCampaign: (id: string) => data(http.delete(`${b}/campaigns/${id}`)),
    duplicateCampaign: (id: string) => data(http.post<Campaign>(`${b}/campaigns/${id}/duplicate`)),
    estimate: (audience: CampaignAudience) => data(http.post<Estimate>(`${b}/campaigns/estimate`, audience)),
    readiness: (id: string) => data(http.get<Readiness>(`${b}/campaigns/${id}/readiness`)),
    preview: (id: string, body: { contact_id?: string | null; subject?: string | null; preheader?: string | null; html?: string | null; text?: string | null }) =>
      data(http.post<Preview>(`${b}/campaigns/${id}/preview`, body)),
    test: (id: string, emails: string[], contact_id?: string | null) =>
      data(http.post<{ provider: string; results: { email: string; accepted: boolean; error: string | null }[] }>(`${b}/campaigns/${id}/test`, { emails, contact_id })),
    schedule: (id: string, scheduled_at: string, timezone: string) =>
      data(http.post<Campaign>(`${b}/campaigns/${id}/schedule`, { scheduled_at, timezone })),
    unschedule: (id: string) => data(http.post<Campaign>(`${b}/campaigns/${id}/unschedule`)),
    send: (id: string) => data(http.post<Campaign>(`${b}/campaigns/${id}/send`)),
    pause: (id: string) => data(http.post<Campaign>(`${b}/campaigns/${id}/pause`)),
    resume: (id: string) => data(http.post<Campaign>(`${b}/campaigns/${id}/resume`)),
    cancel: (id: string) => data(http.post<Campaign>(`${b}/campaigns/${id}/cancel`)),
    report: (id: string) => data(http.get<CampaignReport>(`${b}/campaigns/${id}/report`)),
    messages: (id: string, params: { page: number; page_size: number; status?: string; search?: string }) =>
      data(http.get<Page<EmailMessage>>(`${b}/campaigns/${id}/messages`, { params: Object.fromEntries(Object.entries(params).filter(([, v]) => v)) })),
  }
}

export const eqk = {
  all: (appId: string) => ['email', appId] as const,
  overview: (appId: string) => ['email', appId, 'overview'] as const,
  senders: (appId: string) => ['email', appId, 'senders'] as const,
  templates: (appId: string) => ['email', appId, 'templates'] as const,
  template: (appId: string, id: string) => ['email', appId, 'template', id] as const,
  campaigns: (appId: string, p: object) => ['email', appId, 'campaigns', p] as const,
  campaign: (appId: string, id: string) => ['email', appId, 'campaign', id] as const,
  report: (appId: string, id: string) => ['email', appId, 'report', id] as const,
  readiness: (appId: string, id: string) => ['email', appId, 'readiness', id] as const,
  variables: (appId: string) => ['email', appId, 'variables'] as const,
}

const LIVE: Campaign['status'][] = ['queued', 'sending']

export const useEmailOverview = (appId: string) => useQuery({ queryKey: eqk.overview(appId), queryFn: () => emailApi(appId).overview() })
// Verification happens in another tab (the emailed link), so always refresh on mount and focus.
export const useSenders = (appId: string, pollWhilePending = false) =>
  useQuery({
    queryKey: eqk.senders(appId),
    queryFn: () => emailApi(appId).senders(),
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    staleTime: 0,
    // While an address awaits confirmation, check every few seconds so the UI updates by itself.
    refetchInterval: (q) => (pollWhilePending && q.state.data?.some((s) => s.status !== 'verified') ? 4000 : false),
  })
export const useTemplates = (appId: string) => useQuery({ queryKey: eqk.templates(appId), queryFn: () => emailApi(appId).templates() })
export const useVariables = (appId: string) =>
  useQuery({ queryKey: eqk.variables(appId), queryFn: () => emailApi(appId).variables(), staleTime: 60_000 })
export const useCampaigns = (appId: string, p: { page: number; page_size: number; status?: string; search?: string }) =>
  useQuery({
    queryKey: eqk.campaigns(appId, p),
    queryFn: () => emailApi(appId).campaigns(p),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((c) => LIVE.includes(c.status)) ? 3000 : false),
  })
export const useCampaign = (appId: string, id: string) =>
  useQuery({
    queryKey: eqk.campaign(appId, id),
    queryFn: () => emailApi(appId).campaign(id),
    refetchInterval: (q) => (q.state.data && LIVE.includes(q.state.data.status) ? 2000 : false),
  })
export const useReport = (appId: string, id: string, live: boolean) =>
  useQuery({ queryKey: eqk.report(appId, id), queryFn: () => emailApi(appId).report(id), refetchInterval: live ? 2500 : 15_000 })
