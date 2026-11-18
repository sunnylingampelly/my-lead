/** Audience API calls and query hooks. */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { http } from './client'
import type { Page } from '@/types/api'
import type {
  Activity,
  Attribute,
  AudienceOverview,
  Compliance,
  ConsentRecord,
  ContactDetail,
  ContactFilters,
  ContactInput,
  ContactListInfo,
  ContactListItem,
  FieldCatalog,
  ImportJob,
  ImportOptions,
  ImportValidation,
  Segment,
  SegmentGroup,
  SegmentPreview,
  Suppression,
  TagRef,
  TagWithCount,
  Channel,
} from '@/types/audience'

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)

export function cleanFilters(f: ContactFilters): Record<string, string> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Record<string, string>
}

export type BulkAction = 'delete' | 'add_tag' | 'remove_tag' | 'add_to_list' | 'remove_from_list'

export const audienceApi = (appId: string) => {
  const b = `/apps/${appId}`
  return {
    overview: () => data(http.get<AudienceOverview>(`${b}/audience/overview`)),
    fields: () => data(http.get<FieldCatalog>(`${b}/audience/fields`)),
    contacts: (params: ContactFilters & { page: number; page_size: number; sort?: string }) =>
      data(http.get<Page<ContactListItem>>(`${b}/contacts`, { params: cleanFilters(params as ContactFilters) })),
    contact: (id: string) => data(http.get<ContactDetail>(`${b}/contacts/${id}`)),
    createContact: (body: ContactInput) => data(http.post<ContactDetail>(`${b}/contacts`, body)),
    updateContact: (id: string, body: ContactInput) => data(http.patch<ContactDetail>(`${b}/contacts/${id}`, body)),
    deleteContact: (id: string) => data(http.delete(`${b}/contacts/${id}`)),
    bulk: (body: { action: BulkAction; contact_ids?: string[]; filters?: ContactFilters; tag_id?: string; list_id?: string }) =>
      data(http.post<{ matched: number; affected: number }>(`${b}/contacts/bulk`, {
        ...body,
        filters: body.filters ? cleanFilters(body.filters) : undefined,
      })),
    changeConsent: (id: string, body: { channel: Channel; status: 'granted' | 'revoked'; source?: string; evidence?: string; consent_reference?: string }) =>
      data(http.post<ContactDetail>(`${b}/contacts/${id}/consent`, body)),
    consents: (id: string) => data(http.get<ConsentRecord[]>(`${b}/contacts/${id}/consents`)),
    activity: (id: string, page = 1) =>
      data(http.get<Page<Activity>>(`${b}/contacts/${id}/activity`, { params: { page, page_size: 50 } })),
    tagContact: (id: string, tagId: string) => data(http.post(`${b}/contacts/${id}/tags/${tagId}`)),
    untagContact: (id: string, tagId: string) => data(http.delete(`${b}/contacts/${id}/tags/${tagId}`)),
    exportUrl: (filters: ContactFilters, ids?: string[]) => {
      const q = new URLSearchParams(cleanFilters(filters))
      if (ids?.length) q.set('ids', ids.join(','))
      return `${b}/contacts/export?${q.toString()}`
    },

    attributes: () => data(http.get<Attribute[]>(`${b}/audience/attributes`)),
    createAttribute: (body: Partial<Attribute>) => data(http.post<Attribute>(`${b}/audience/attributes`, body)),
    updateAttribute: (id: string, body: Partial<Attribute>) => data(http.patch<Attribute>(`${b}/audience/attributes/${id}`, body)),
    deleteAttribute: (id: string) => data(http.delete(`${b}/audience/attributes/${id}`)),

    tags: () => data(http.get<TagWithCount[]>(`${b}/tags`)),
    createTag: (body: { name: string; color?: string }) => data(http.post<TagRef>(`${b}/tags`, body)),
    updateTag: (id: string, body: { name?: string; color?: string }) => data(http.patch<TagRef>(`${b}/tags/${id}`, body)),
    deleteTag: (id: string) => data(http.delete(`${b}/tags/${id}`)),

    lists: () => data(http.get<ContactListInfo[]>(`${b}/lists`)),
    list: (id: string) => data(http.get<ContactListInfo>(`${b}/lists/${id}`)),
    createList: (body: { name: string; description?: string | null }) => data(http.post<ContactListInfo>(`${b}/lists`, body)),
    updateList: (id: string, body: { name?: string; description?: string | null }) =>
      data(http.patch<ContactListInfo>(`${b}/lists/${id}`, body)),
    deleteList: (id: string) => data(http.delete(`${b}/lists/${id}`)),
    removeFromList: (id: string, contact_ids: string[]) =>
      data(http.delete<{ removed: number }>(`${b}/lists/${id}/contacts`, { data: { contact_ids } })),

    segments: () => data(http.get<Segment[]>(`${b}/segments`)),
    segment: (id: string) => data(http.get<Segment>(`${b}/segments/${id}`)),
    previewSegment: (rules: SegmentGroup) => data(http.post<SegmentPreview>(`${b}/segments/preview`, { rules })),
    createSegment: (body: { name: string; description?: string | null; rules: SegmentGroup }) =>
      data(http.post<Segment>(`${b}/segments`, body)),
    updateSegment: (id: string, body: { name?: string; description?: string | null; rules?: SegmentGroup }) =>
      data(http.patch<Segment>(`${b}/segments/${id}`, body)),
    deleteSegment: (id: string) => data(http.delete(`${b}/segments/${id}`)),

    suppressions: (params: { page: number; page_size: number; channel?: string; search?: string }) =>
      data(http.get<Page<Suppression>>(`${b}/suppressions`, { params: cleanFilters(params as never) })),
    addSuppression: (body: { channel: Channel; value: string; reason?: string; note?: string }) =>
      data(http.post<Suppression>(`${b}/suppressions`, body)),
    removeSuppression: (id: string) => data(http.delete(`${b}/suppressions/${id}`)),

    imports: (page = 1) => data(http.get<Page<ImportJob>>(`${b}/imports`, { params: { page, page_size: 20 } })),
    import: (id: string) => data(http.get<ImportJob>(`${b}/imports/${id}`)),
    upload: (file: File, onProgress?: (pct: number) => void) => {
      const form = new FormData()
      form.append('file', file)
      return data(
        http.post<ImportJob>(`${b}/contacts/import`, form, {
          timeout: 120_000,
          onUploadProgress: (e) => onProgress?.(e.total ? Math.round((e.loaded / e.total) * 100) : 0),
        }),
      )
    },
    validateImport: (id: string, mapping: Record<string, string>) =>
      data(http.post<ImportValidation>(`${b}/imports/${id}/validate`, { mapping }, { timeout: 120_000 })),
    startImport: (id: string, mapping: Record<string, string>, options: ImportOptions) =>
      data(http.post<ImportJob>(`${b}/imports/${id}/start`, { mapping, options })),
    cancelImport: (id: string) => data(http.post<ImportJob>(`${b}/imports/${id}/cancel`)),
    reportUrl: (id: string) => `${b}/imports/${id}/report`,

    compliance: () => data(http.get<Compliance>(`/applications/${appId}/compliance`)),
  }
}

export const aqk = {
  all: (appId: string) => ['aud', appId] as const,
  overview: (appId: string) => ['aud', appId, 'overview'] as const,
  fields: (appId: string) => ['aud', appId, 'fields'] as const,
  contacts: (appId: string, p: object) => ['aud', appId, 'contacts', p] as const,
  contact: (appId: string, id: string) => ['aud', appId, 'contact', id] as const,
  attributes: (appId: string) => ['aud', appId, 'attributes'] as const,
  tags: (appId: string) => ['aud', appId, 'tags'] as const,
  lists: (appId: string) => ['aud', appId, 'lists'] as const,
  segments: (appId: string) => ['aud', appId, 'segments'] as const,
  imports: (appId: string) => ['aud', appId, 'imports'] as const,
  import: (appId: string, id: string) => ['aud', appId, 'import', id] as const,
  suppressions: (appId: string, p: object) => ['aud', appId, 'suppressions', p] as const,
  compliance: (appId: string) => ['aud', appId, 'compliance'] as const,
}

export const useAudienceOverview = (appId: string) =>
  useQuery({ queryKey: aqk.overview(appId), queryFn: () => audienceApi(appId).overview() })
export const useFieldCatalog = (appId: string) =>
  useQuery({ queryKey: aqk.fields(appId), queryFn: () => audienceApi(appId).fields() })
export const useContacts = (appId: string, p: ContactFilters & { page: number; page_size: number; sort?: string }) =>
  useQuery({ queryKey: aqk.contacts(appId, p), queryFn: () => audienceApi(appId).contacts(p), placeholderData: keepPreviousData })
export const useContact = (appId: string, id: string) =>
  useQuery({ queryKey: aqk.contact(appId, id), queryFn: () => audienceApi(appId).contact(id) })
export const useAttributes = (appId: string) =>
  useQuery({ queryKey: aqk.attributes(appId), queryFn: () => audienceApi(appId).attributes() })
export const useTags = (appId: string) => useQuery({ queryKey: aqk.tags(appId), queryFn: () => audienceApi(appId).tags() })
export const useLists = (appId: string) => useQuery({ queryKey: aqk.lists(appId), queryFn: () => audienceApi(appId).lists() })
export const useSegments = (appId: string) =>
  useQuery({ queryKey: aqk.segments(appId), queryFn: () => audienceApi(appId).segments() })
export const useImports = (appId: string) =>
  useQuery({ queryKey: aqk.imports(appId), queryFn: () => audienceApi(appId).imports() })
export const useCompliance = (appId: string) =>
  useQuery({ queryKey: aqk.compliance(appId), queryFn: () => audienceApi(appId).compliance() })
