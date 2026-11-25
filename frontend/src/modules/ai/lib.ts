import { AlertTriangle, BarChart3, Bot, CalendarDays, Flame, HelpCircle, Hourglass, Mail, UserCheck, type LucideIcon } from 'lucide-react'
import type { AgentConfig } from '@/types/ai'

export const OPEN_ASSISTANT_EVENT = 'sc:open-assistant'

/** Open the assistant from anywhere (sidebar, command palette), optionally with a question to ask. */
export function openAssistant(prompt?: string) {
  window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_EVENT, { detail: { prompt } }))
}

/** Only app paths (opened in the app) and https URLs (new tab) are ever linked. */
export function safeHref(href: string): { internal: boolean; href: string } | null {
  if (href.startsWith('/') && !href.startsWith('//') && !href.includes('\\')) return { internal: true, href }
  try {
    const u = new URL(href)
    if (u.protocol === 'https:') return { internal: false, href: u.toString() }
  } catch {
    /* not a URL */
  }
  return null
}

export const BLANK_AGENT: AgentConfig = {
  name: '',
  description: '',
  template: null,
  instructions: '',
  trigger: { type: 'schedule', every: 'daily', time: '09:00' },
  allowed_tools: ['analytics_summary'],
  mode: 'approve',
  destinations: { in_app: true, email_user_ids: [], slack_channels: [] },
}

export const AGENT_ICONS: Record<string, LucideIcon> = {
  'user-check': UserCheck,
  flame: Flame,
  hourglass: Hourglass,
  'bar-chart': BarChart3,
  calendar: CalendarDays,
  mail: Mail,
  alert: AlertTriangle,
  help: HelpCircle,
}

export const TEMPLATE_ICON: Record<string, string> = {
  lead_qualifier: 'user-check',
  hot_lead_alert: 'flame',
  stale_deal_watchdog: 'hourglass',
  daily_report: 'bar-chart',
  weekly_campaign_report: 'calendar',
  chat_followup: 'mail',
  balance_alert: 'alert',
  unanswered_digest: 'help',
}

export const iconFor = (key?: string | null) => (key && AGENT_ICONS[key]) || Bot
