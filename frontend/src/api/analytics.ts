import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { http } from './client'

export interface AnalyticsPoint {
  date: string
  [metric: string]: number | string
}

export interface TopCampaign {
  channel: 'email' | 'sms' | 'voice'
  id: string
  name: string
  automation: boolean
  /** For automation steps: the workflow and step that sent it. */
  workflow_id: string | null
  node_id: string | null
  sent: number
  engaged: number
  engaged_label: string
  rate: number | null
}

export interface CrmPeriod {
  deals_created: number
  won: number
  lost: number
  won_amount: number
  win_rate: number | null
}

export interface CrmBlock extends CrmPeriod {
  currency: string
  pipeline_value: number
  open_deals: number
  previous: CrmPeriod
  changes: Record<'deals_created' | 'won' | 'won_amount' | 'win_rate', number | null>
}

export interface AnalyticsOverview {
  start: string
  end: string
  timezone: string
  currency: string
  metrics: { key: string; label: string }[]
  points: AnalyticsPoint[]
  totals: Record<string, number>
  previous: { start: string; end: string; totals: Record<string, number> }
  /** % change against the previous period of the same length (null when there was nothing before). */
  changes: Record<string, number | null>
  rates: Record<string, number | null>
  top_campaigns: TopCampaign[]
  workflows: { id: string; name: string; status: string; entered: number; completed: number }[]
  /** Null when the viewer can't read the CRM. */
  crm: CrmBlock | null
  setup: { sender_verified: boolean; campaign_sent: boolean; workflow_created: boolean }
}

export type CampaignRank = 'volume' | 'rate'

export const analyticsOverviewApi = {
  get: (appId: string, start?: string, end?: string, rank: CampaignRank = 'volume') =>
    http.get<AnalyticsOverview>(`/apps/${appId}/analytics`, { params: { start, end, rank } }).then((r) => r.data),
}

export const useAnalyticsOverview = (appId: string, start?: string, end?: string, rank: CampaignRank = 'volume') =>
  useQuery({ queryKey: ['analytics', appId, start, end, rank], queryFn: () => analyticsOverviewApi.get(appId, start, end, rank), placeholderData: keepPreviousData })
