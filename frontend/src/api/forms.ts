/** Lead forms API calls and query hooks. */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { http } from './client'
import { clean } from './crm'
import type { Page } from '@/types/api'
import type {
  AnalyticsOut,
  FormListItem,
  FormOut,
  FormsMeta,
  FormUpdate,
  SubmissionFilters,
  SubmissionOut,
  TemplateOut,
  VersionOut,
} from '@/types/forms'

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)

export const formsApi = (appId: string) => {
  const b = `/apps/${appId}/forms`
  return {
    list: () => data(http.get<FormListItem[]>(b)),
    templates: () => data(http.get<TemplateOut[]>(`${b}/templates`)),
    meta: () => data(http.get<FormsMeta>(`${b}/meta`)),
    create: (body: { name: string; template?: string }) => data(http.post<FormOut>(b, body)),
    get: (id: string) => data(http.get<FormOut>(`${b}/${id}`)),
    update: (id: string, body: FormUpdate) => data(http.patch<FormOut>(`${b}/${id}`, body)),
    publish: (id: string) => data(http.post<FormOut>(`${b}/${id}/publish`)),
    pause: (id: string) => data(http.post<FormOut>(`${b}/${id}/pause`)),
    discard: (id: string) => data(http.post<FormOut>(`${b}/${id}/discard`)),
    versions: (id: string) => data(http.get<VersionOut[]>(`${b}/${id}/versions`)),
    duplicate: (id: string) => data(http.post<FormOut>(`${b}/${id}/duplicate`)),
    remove: (id: string) => data(http.delete(`${b}/${id}`)),
    submissions: (id: string, params: SubmissionFilters & { page: number; page_size: number }) =>
      data(http.get<Page<SubmissionOut>>(`${b}/${id}/submissions`, { params: clean(params) })),
    /** Path for downloadFile() (relative to the API base). */
    exportPath: (id: string, f: SubmissionFilters) => {
      const qs = new URLSearchParams(clean(f)).toString()
      return `${b}/${id}/submissions/export${qs ? `?${qs}` : ''}`
    },
    markSpam: (id: string, sid: string, spam: boolean) => data(http.post<SubmissionOut>(`${b}/${id}/submissions/${sid}/spam`, { spam })),
    deleteSubmission: (id: string, sid: string) => data(http.delete(`${b}/${id}/submissions/${sid}`)),
    analytics: (id: string, days: number) => data(http.get<AnalyticsOut>(`${b}/${id}/analytics`, { params: { days } })),
    sendToDeveloper: (id: string, body: { email: string; note: string }) => data(http.post<{ sent: boolean }>(`${b}/${id}/send-to-developer`, body)),
  }
}

export const fqk = {
  all: (appId: string) => ['forms', appId] as const,
  list: (appId: string) => ['forms', appId, 'list'] as const,
  templates: (appId: string) => ['forms', appId, 'templates'] as const,
  meta: (appId: string) => ['forms', appId, 'meta'] as const,
  form: (appId: string, id: string) => ['forms', appId, 'form', id] as const,
  versions: (appId: string, id: string) => ['forms', appId, 'form', id, 'versions'] as const,
  submissions: (appId: string, id: string, p?: object) => ['forms', appId, 'form', id, 'submissions', ...(p ? [p] : [])] as const,
  analytics: (appId: string, id: string, days?: number) => ['forms', appId, 'form', id, 'analytics', ...(days ? [days] : [])] as const,
}

export const useForms = (appId: string, enabled = true) => useQuery({ queryKey: fqk.list(appId), queryFn: () => formsApi(appId).list(), enabled })
export const useFormTemplates = (appId: string, enabled = true) =>
  useQuery({ queryKey: fqk.templates(appId), queryFn: () => formsApi(appId).templates(), staleTime: 10 * 60_000, enabled })
export const useFormsMeta = (appId: string) => useQuery({ queryKey: fqk.meta(appId), queryFn: () => formsApi(appId).meta(), staleTime: 60_000 })
export const useForm = (appId: string, id: string) => useQuery({ queryKey: fqk.form(appId, id), queryFn: () => formsApi(appId).get(id) })
export const useFormVersions = (appId: string, id: string, enabled = true) =>
  useQuery({ queryKey: fqk.versions(appId, id), queryFn: () => formsApi(appId).versions(id), enabled })
export const useSubmissions = (appId: string, id: string, p: SubmissionFilters & { page: number; page_size: number }) =>
  useQuery({ queryKey: fqk.submissions(appId, id, p), queryFn: () => formsApi(appId).submissions(id, p), placeholderData: keepPreviousData })
export const useFormAnalytics = (appId: string, id: string, days: number) =>
  useQuery({ queryKey: fqk.analytics(appId, id, days), queryFn: () => formsApi(appId).analytics(id, days), placeholderData: keepPreviousData })
