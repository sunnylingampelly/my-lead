/** CRM API calls and query hooks. */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { http } from './client'
import type { Page } from '@/types/api'
import type {
  ActivityInput,
  AssignmentRule,
  AssignmentRuleInput,
  Board,
  Company,
  CompanyContact,
  CompanyInput,
  ContactCrm,
  ContactCrmUpdate,
  ConversionReport,
  CrmSettings,
  CrmTarget,
  Deal,
  DealDetail,
  DealFilters,
  DealInput,
  DuplicateMatch,
  ForecastReport,
  LeaderboardReport,
  LeadFilters,
  LeadRow,
  LostReason,
  Note,
  OverviewReport,
  Pipeline,
  PipelineUpdate,
  ScoringRule,
  ScoringRuleInput,
  StageInput,
  Task,
  TaskInput,
  TaskSummary,
  TimelineItem,
  SuggestedContact,
  UserRef,
  WinLossReport,
} from '@/types/crm'

const data = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data)

/** Drop empty values so they aren't sent as query parameters. */
export function clean<T extends object>(f: T): Record<string, string> {
  return Object.fromEntries(
    Object.entries(f)
      .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
      .map(([k, v]) => [k, String(v)]),
  )
}

export interface TaskQuery {
  assignee_id?: string
  status?: 'open' | 'done' | 'all'
  due?: 'overdue' | 'today' | 'upcoming' | 'none'
  contact_id?: string
  deal_id?: string
  company_id?: string
  page?: number
  page_size?: number
}

export const crmApi = (appId: string) => {
  const b = `/apps/${appId}/crm`
  return {
    team: () => data(http.get<UserRef[]>(`${b}/team`)),
    settings: () => data(http.get<CrmSettings>(`${b}/settings`)),
    updateSettings: (body: Partial<CrmSettings>) => data(http.patch<CrmSettings>(`${b}/settings`, body)),

    companies: (params: { search?: string; owner_id?: string; industry?: string; sort?: string; page: number; page_size: number }) =>
      data(http.get<Page<Company>>(`${b}/companies`, { params: clean(params) })),
    company: (id: string) => data(http.get<Company>(`${b}/companies/${id}`)),
    duplicates: (params: { name?: string; domain?: string; gstin?: string; exclude_id?: string }) =>
      data(http.get<DuplicateMatch[]>(`${b}/companies/duplicates`, { params: clean(params) })),
    createCompany: (body: CompanyInput) => data(http.post<Company>(`${b}/companies`, body)),
    updateCompany: (id: string, body: CompanyInput) => data(http.patch<Company>(`${b}/companies/${id}`, body)),
    deleteCompany: (id: string) => data(http.delete(`${b}/companies/${id}`)),
    companyContacts: (id: string) => data(http.get<CompanyContact[]>(`${b}/companies/${id}/contacts`)),
    linkCompanyContacts: (id: string, ids: string[]) => data(http.post<{ linked: number }>(`${b}/companies/${id}/contacts`, { ids })),
    unlinkCompanyContacts: (id: string, ids: string[]) =>
      data(http.post<{ unlinked: number }>(`${b}/companies/${id}/contacts/unlink`, { ids })),
    suggestedContacts: (id: string) => data(http.get<SuggestedContact[]>(`${b}/companies/${id}/suggested-contacts`)),
    companiesFromContactsPreview: () => data(http.get<{ companies: number; contacts: number }>(`${b}/companies/from-contacts`)),
    companiesFromContacts: () => data(http.post<{ created: number; linked: number }>(`${b}/companies/from-contacts`)),

    pipelines: (includeArchived = false) =>
      data(http.get<Pipeline[]>(`${b}/pipelines`, { params: includeArchived ? { include_archived: true } : {} })),
    createPipeline: (body: { name: string; currency?: string; stages?: StageInput[] }) => data(http.post<Pipeline>(`${b}/pipelines`, body)),
    updatePipeline: (id: string, body: PipelineUpdate) => data(http.patch<Pipeline>(`${b}/pipelines/${id}`, body)),
    deletePipeline: (id: string) => data(http.delete(`${b}/pipelines/${id}`)),
    lostReasons: () => data(http.get<LostReason[]>(`${b}/lost-reasons`)),
    createLostReason: (body: { name: string; active?: boolean }) => data(http.post<LostReason>(`${b}/lost-reasons`, body)),
    updateLostReason: (id: string, body: { name: string; active: boolean }) => data(http.patch<LostReason>(`${b}/lost-reasons/${id}`, body)),

    board: (params: { pipeline_id?: string; owner_id?: string; search?: string }) => data(http.get<Board>(`${b}/board`, { params: clean(params) })),
    deals: (params: DealFilters & { page: number; page_size: number }) => data(http.get<Page<Deal>>(`${b}/deals`, { params: clean(params) })),
    deal: (id: string) => data(http.get<DealDetail>(`${b}/deals/${id}`)),
    createDeal: (body: DealInput) => data(http.post<DealDetail>(`${b}/deals`, body)),
    updateDeal: (id: string, body: DealInput) => data(http.patch<DealDetail>(`${b}/deals/${id}`, body)),
    deleteDeal: (id: string) => data(http.delete(`${b}/deals/${id}`)),
    moveDeal: (id: string, body: { stage_id: string; position?: number; lost_reason_id?: string; lost_note?: string }) =>
      data(http.post<DealDetail>(`${b}/deals/${id}/move`, body)),
    closeDeal: (id: string, body: { outcome: 'won' | 'lost'; lost_reason_id?: string; lost_note?: string }) =>
      data(http.post<DealDetail>(`${b}/deals/${id}/close`, body)),
    reopenDeal: (id: string) => data(http.post<DealDetail>(`${b}/deals/${id}/reopen`)),
    setDealContacts: (id: string, contacts: { contact_id: string; role?: string | null }[]) =>
      data(http.put<DealDetail>(`${b}/deals/${id}/contacts`, { contacts })),

    tasks: (params: TaskQuery) => data(http.get<Page<Task>>(`${b}/tasks`, { params: clean(params) })),
    task: (id: string) => data(http.get<Task>(`${b}/tasks/${id}`)),
    taskSummary: () => data(http.get<TaskSummary>(`${b}/tasks/summary`)),
    createTask: (body: TaskInput) => data(http.post<Task>(`${b}/tasks`, body)),
    updateTask: (id: string, body: TaskInput) => data(http.patch<Task>(`${b}/tasks/${id}`, body)),
    deleteTask: (id: string) => data(http.delete(`${b}/tasks/${id}`)),

    notes: (target: CrmTarget) => data(http.get<Note[]>(`${b}/notes`, { params: clean(target) })),
    createNote: (body: CrmTarget & { body: string; pinned?: boolean }) => data(http.post<Note>(`${b}/notes`, body)),
    updateNote: (id: string, body: { body?: string; pinned?: boolean }) => data(http.patch<Note>(`${b}/notes/${id}`, body)),
    deleteNote: (id: string) => data(http.delete(`${b}/notes/${id}`)),
    logActivity: (body: ActivityInput) => data(http.post<{ id: string }>(`${b}/activities`, body)),
    deleteActivity: (id: string) => data(http.delete(`${b}/activities/${id}`)),
    timeline: (target: CrmTarget, params: { before?: string; limit?: number; kinds?: string }) =>
      data(http.get<TimelineItem[]>(`${b}/timeline`, { params: clean({ ...target, ...params }) })),

    contactCrm: (id: string) => data(http.get<ContactCrm>(`${b}/contacts/${id}`)),
    updateContactCrm: (id: string, body: ContactCrmUpdate) => data(http.patch<ContactCrm>(`${b}/contacts/${id}`, body)),
    leads: (params: LeadFilters & { page: number; page_size: number }) => data(http.get<Page<LeadRow>>(`${b}/leads`, { params: clean(params) })),

    assignmentRules: () => data(http.get<AssignmentRule[]>(`${b}/assignment-rules`)),
    createAssignmentRule: (body: AssignmentRuleInput) => data(http.post<AssignmentRule>(`${b}/assignment-rules`, body)),
    updateAssignmentRule: (id: string, body: AssignmentRuleInput) => data(http.put<AssignmentRule>(`${b}/assignment-rules/${id}`, body)),
    deleteAssignmentRule: (id: string) => data(http.delete(`${b}/assignment-rules/${id}`)),
    orderAssignmentRules: (ids: string[]) => data(http.post(`${b}/assignment-rules/order`, { ids })),
    scoringRules: () => data(http.get<ScoringRule[]>(`${b}/scoring-rules`)),
    createScoringRule: (body: ScoringRuleInput) => data(http.post<ScoringRule>(`${b}/scoring-rules`, body)),
    updateScoringRule: (id: string, body: ScoringRuleInput) => data(http.put<ScoringRule>(`${b}/scoring-rules/${id}`, body)),
    deleteScoringRule: (id: string) => data(http.delete(`${b}/scoring-rules/${id}`)),
    rescore: () => data(http.post<{ scored: number }>(`${b}/scoring/rescore`)),

    overview: (pipeline_id?: string) => data(http.get<OverviewReport>(`${b}/reports/overview`, { params: clean({ pipeline_id }) })),
    forecast: (pipeline_id?: string, months = 6) =>
      data(http.get<ForecastReport>(`${b}/reports/forecast`, { params: clean({ pipeline_id, months }) })),
    winLoss: (pipeline_id?: string, days = 90) => data(http.get<WinLossReport>(`${b}/reports/win-loss`, { params: clean({ pipeline_id, days }) })),
    conversion: (pipeline_id?: string, days = 90) =>
      data(http.get<ConversionReport>(`${b}/reports/conversion`, { params: clean({ pipeline_id, days }) })),
    leaderboard: (pipeline_id?: string, days = 30) =>
      data(http.get<LeaderboardReport>(`${b}/reports/leaderboard`, { params: clean({ pipeline_id, days }) })),
  }
}

export const cqk = {
  all: (appId: string) => ['crm', appId] as const,
  team: (appId: string) => ['crm', appId, 'team'] as const,
  settings: (appId: string) => ['crm', appId, 'settings'] as const,
  companies: (appId: string, p?: object) => ['crm', appId, 'companies', ...(p ? [p] : [])] as const,
  company: (appId: string, id: string) => ['crm', appId, 'company', id] as const,
  companyContacts: (appId: string, id: string) => ['crm', appId, 'company', id, 'contacts'] as const,
  pipelines: (appId: string, archived = false) => ['crm', appId, 'pipelines', archived] as const,
  lostReasons: (appId: string) => ['crm', appId, 'lost-reasons'] as const,
  board: (appId: string, p?: object) => ['crm', appId, 'board', ...(p ? [p] : [])] as const,
  deals: (appId: string, p?: object) => ['crm', appId, 'deals', ...(p ? [p] : [])] as const,
  deal: (appId: string, id: string) => ['crm', appId, 'deal', id] as const,
  tasks: (appId: string, p?: object) => ['crm', appId, 'tasks', ...(p ? [p] : [])] as const,
  taskSummary: (appId: string) => ['crm', appId, 'task-summary'] as const,
  notes: (appId: string, t?: CrmTarget) => ['crm', appId, 'notes', ...(t ? [t] : [])] as const,
  timeline: (appId: string, t?: CrmTarget) => ['crm', appId, 'timeline', ...(t ? [t] : [])] as const,
  contact: (appId: string, id: string) => ['crm', appId, 'contact', id] as const,
  leads: (appId: string, p?: object) => ['crm', appId, 'leads', ...(p ? [p] : [])] as const,
  assignmentRules: (appId: string) => ['crm', appId, 'assignment-rules'] as const,
  scoringRules: (appId: string) => ['crm', appId, 'scoring-rules'] as const,
  report: (appId: string, name: string, p?: object) => ['crm', appId, 'report', name, ...(p ? [p] : [])] as const,
}

export const useCrmTeam = (appId: string, enabled = true) =>
  useQuery({ queryKey: cqk.team(appId), queryFn: () => crmApi(appId).team(), staleTime: 60_000, enabled })
export const useCrmSettings = (appId: string) => useQuery({ queryKey: cqk.settings(appId), queryFn: () => crmApi(appId).settings() })
export const usePipelines = (appId: string, includeArchived = false) =>
  useQuery({ queryKey: cqk.pipelines(appId, includeArchived), queryFn: () => crmApi(appId).pipelines(includeArchived) })
export const useLostReasons = (appId: string) => useQuery({ queryKey: cqk.lostReasons(appId), queryFn: () => crmApi(appId).lostReasons() })
export const useCompanies = (appId: string, p: Parameters<ReturnType<typeof crmApi>['companies']>[0]) =>
  useQuery({ queryKey: cqk.companies(appId, p), queryFn: () => crmApi(appId).companies(p), placeholderData: keepPreviousData })
export const useCompany = (appId: string, id: string) => useQuery({ queryKey: cqk.company(appId, id), queryFn: () => crmApi(appId).company(id) })
export const useCompanyContacts = (appId: string, id: string) =>
  useQuery({ queryKey: cqk.companyContacts(appId, id), queryFn: () => crmApi(appId).companyContacts(id) })
export const useBoard = (appId: string, p: { pipeline_id?: string; owner_id?: string; search?: string }) =>
  useQuery({ queryKey: cqk.board(appId, p), queryFn: () => crmApi(appId).board(p), placeholderData: keepPreviousData })
export const useDeals = (appId: string, p: DealFilters & { page: number; page_size: number }, enabled = true) =>
  useQuery({ queryKey: cqk.deals(appId, p), queryFn: () => crmApi(appId).deals(p), placeholderData: keepPreviousData, enabled })
export const useDeal = (appId: string, id: string) => useQuery({ queryKey: cqk.deal(appId, id), queryFn: () => crmApi(appId).deal(id) })
export const useTasks = (appId: string, p: TaskQuery) =>
  useQuery({ queryKey: cqk.tasks(appId, p), queryFn: () => crmApi(appId).tasks(p), placeholderData: keepPreviousData })
export const useTaskSummary = (appId: string, enabled = true) =>
  useQuery({ queryKey: cqk.taskSummary(appId), queryFn: () => crmApi(appId).taskSummary(), enabled, staleTime: 30_000 })
export const useNotes = (appId: string, t: CrmTarget) => useQuery({ queryKey: cqk.notes(appId, t), queryFn: () => crmApi(appId).notes(t) })
export const useContactCrm = (appId: string, id: string, enabled = true) =>
  useQuery({ queryKey: cqk.contact(appId, id), queryFn: () => crmApi(appId).contactCrm(id), enabled })
export const useLeads = (appId: string, p: LeadFilters & { page: number; page_size: number }) =>
  useQuery({ queryKey: cqk.leads(appId, p), queryFn: () => crmApi(appId).leads(p), placeholderData: keepPreviousData })
export const useAssignmentRules = (appId: string) =>
  useQuery({ queryKey: cqk.assignmentRules(appId), queryFn: () => crmApi(appId).assignmentRules() })
export const useScoringRules = (appId: string) => useQuery({ queryKey: cqk.scoringRules(appId), queryFn: () => crmApi(appId).scoringRules() })
