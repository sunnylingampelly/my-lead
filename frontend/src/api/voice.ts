import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { http } from './client'
import type { Page } from '@/types/api'
import type { CampaignAudience, Estimate } from '@/types/email'
import type {
  CallerId,
  VoiceAudio,
  VoiceCall,
  VoiceCampaign,
  VoiceCampaignListItem,
  VoiceOptions,
  VoiceOverview,
  VoicePreview,
  VoiceReadiness,
  VoiceReport,
} from '@/types/voice'

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)
const clean = (p: object) => ({ params: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) })
type Paging = { page: number; page_size: number; status?: string; search?: string }

export const voiceApi = (appId: string) => {
  const b = `/apps/${appId}/voice`
  return {
    overview: () => data(http.get<VoiceOverview>(`${b}/overview`)),
    options: () => data(http.get<VoiceOptions>(`${b}/options`)),

    callers: () => data(http.get<CallerId[]>(`${b}/callers`)),
    createCaller: (body: Pick<CallerId, 'number' | 'country' | 'kind' | 'provider'> & { label?: string | null }) => data(http.post<CallerId>(`${b}/callers`, body)),
    providerNumbers: () => data(http.get<{ configured: boolean; numbers: { number: string; label: string | null }[] }>(`${b}/provider-numbers`, { params: { provider: 'telnyx' } })),
    attestCaller: (id: string) => data(http.post<CallerId>(`${b}/callers/${id}/attest`)),
    defaultCaller: (id: string) => data(http.post<CallerId>(`${b}/callers/${id}/default`)),
    deleteCaller: (id: string) => data(http.delete(`${b}/callers/${id}`)),

    audio: () => data(http.get<VoiceAudio[]>(`${b}/audio`)),
    uploadAudio: (file: File, name: string) => {
      const form = new FormData()
      form.append('file', file)
      form.append('name', name)
      return data(http.post<VoiceAudio>(`${b}/audio/upload`, form))
    },
    createTts: (body: { name: string; tts_text: string; tts_language: string; tts_voice: string }) => data(http.post<VoiceAudio>(`${b}/audio/tts`, body)),
    updateAudio: (id: string, body: Partial<VoiceAudio>) => data(http.patch<VoiceAudio>(`${b}/audio/${id}`, body)),
    deleteAudio: (id: string) => data(http.delete(`${b}/audio/${id}`)),

    campaigns: (p: Paging) => data(http.get<Page<VoiceCampaignListItem>>(`${b}/campaigns`, clean(p))),
    campaign: (id: string) => data(http.get<VoiceCampaign>(`${b}/campaigns/${id}`)),
    createCampaign: (body: { name: string; category?: string; audio_id?: string | null }) => data(http.post<VoiceCampaign>(`${b}/campaigns`, body)),
    updateCampaign: (id: string, body: Partial<VoiceCampaign>) => data(http.patch<VoiceCampaign>(`${b}/campaigns/${id}`, body)),
    deleteCampaign: (id: string) => data(http.delete(`${b}/campaigns/${id}`)),
    duplicateCampaign: (id: string) => data(http.post<VoiceCampaign>(`${b}/campaigns/${id}/duplicate`)),
    estimate: (audience: CampaignAudience, country?: string | null) => data(http.post<Estimate>(`${b}/campaigns/estimate`, { ...audience, country })),
    readiness: (id: string) => data(http.get<VoiceReadiness>(`${b}/campaigns/${id}/readiness`)),
    preview: (id: string) => data(http.get<VoicePreview>(`${b}/campaigns/${id}/preview`)),
    test: (id: string, phones: string[]) =>
      data(http.post<{ provider: string; results: { phone: string; accepted: boolean; error: string | null }[] }>(`${b}/campaigns/${id}/test`, { phones })),
    schedule: (id: string, scheduled_at: string, timezone: string) => data(http.post<VoiceCampaign>(`${b}/campaigns/${id}/schedule`, { scheduled_at, timezone })),
    unschedule: (id: string) => data(http.post<VoiceCampaign>(`${b}/campaigns/${id}/unschedule`)),
    send: (id: string) => data(http.post<VoiceCampaign>(`${b}/campaigns/${id}/send`)),
    pause: (id: string) => data(http.post<VoiceCampaign>(`${b}/campaigns/${id}/pause`)),
    resume: (id: string) => data(http.post<VoiceCampaign>(`${b}/campaigns/${id}/resume`)),
    cancel: (id: string) => data(http.post<VoiceCampaign>(`${b}/campaigns/${id}/cancel`)),
    report: (id: string) => data(http.get<VoiceReport>(`${b}/campaigns/${id}/report`)),
    calls: (id: string, p: Paging) => data(http.get<Page<VoiceCall>>(`${b}/campaigns/${id}/calls`, clean(p))),
  }
}

export const vqk = {
  all: (appId: string) => ['voice', appId] as const,
  overview: (appId: string) => ['voice', appId, 'overview'] as const,
  options: (appId: string) => ['voice', appId, 'options'] as const,
  callers: (appId: string) => ['voice', appId, 'callers'] as const,
  audio: (appId: string) => ['voice', appId, 'audio'] as const,
  campaigns: (appId: string, p: object) => ['voice', appId, 'campaigns', p] as const,
  campaign: (appId: string, id: string) => ['voice', appId, 'campaign', id] as const,
  readiness: (appId: string, id: string) => ['voice', appId, 'readiness', id] as const,
  preview: (appId: string, id: string) => ['voice', appId, 'preview', id] as const,
  report: (appId: string, id: string) => ['voice', appId, 'report', id] as const,
}

const LIVE = ['queued', 'sending']

export const useVoiceOverview = (appId: string) => useQuery({ queryKey: vqk.overview(appId), queryFn: () => voiceApi(appId).overview(), refetchOnMount: 'always' })
export const useVoiceOptions = (appId: string) => useQuery({ queryKey: vqk.options(appId), queryFn: () => voiceApi(appId).options(), staleTime: 300_000 })
export const useCallers = (appId: string) => useQuery({ queryKey: vqk.callers(appId), queryFn: () => voiceApi(appId).callers(), refetchOnMount: 'always' })
export const useAudio = (appId: string) => useQuery({ queryKey: vqk.audio(appId), queryFn: () => voiceApi(appId).audio() })
export const useVoiceCampaigns = (appId: string, p: Paging) =>
  useQuery({
    queryKey: vqk.campaigns(appId, p),
    queryFn: () => voiceApi(appId).campaigns(p),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((c) => LIVE.includes(c.status)) ? 3000 : false),
  })
export const useVoiceCampaign = (appId: string, id: string) =>
  useQuery({
    queryKey: vqk.campaign(appId, id),
    queryFn: () => voiceApi(appId).campaign(id),
    refetchInterval: (q) => (q.state.data && LIVE.includes(q.state.data.status) ? 2500 : false),
  })
export const useVoiceReport = (appId: string, id: string, live: boolean) =>
  useQuery({ queryKey: vqk.report(appId, id), queryFn: () => voiceApi(appId).report(id), refetchInterval: live ? 2500 : 15_000 })
