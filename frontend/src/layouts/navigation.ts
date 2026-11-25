import {
  BarChart3,
  Building2,
  ClipboardList,
  CreditCard,
  Handshake,
  LayoutDashboard,
  LayoutGrid,
  type LucideIcon,
  Mail,
  MessageSquare,
  MessagesSquare,
  PhoneCall,
  ScrollText,
  Settings,
  Sparkles,
  Users,
  UsersRound,
  Workflow,
} from 'lucide-react'
import type { Application, Organization } from '@/types/api'

export interface NavChild {
  label: string
  to: string
  end?: boolean
  shortcut?: string
  /** Rendered as a button that runs this action instead of a link (e.g. opening the AI Assistant panel). */
  action?: 'assistant'
  /** A live count shown after the label. */
  badgeKey?: 'approvals'
}

export interface NavItem {
  label: string
  icon: LucideIcon
  to?: string
  soon?: string
  /** Small tag after the label, e.g. "Soon" for a module that only shows a coming-soon page. */
  badge?: string
  end?: boolean
  shortcut?: string
  children?: NavChild[]
}

/** Single source of truth for navigation: the sidebar, command palette and shortcuts all use it. */
export function appNav(app: Application | null): NavItem[] {
  if (!app) return []
  const base = `/apps/${app.id}`
  const can = (p: string) => app.permissions.includes(p)
  return [
    { label: 'Overview', icon: LayoutDashboard, to: base, end: true, shortcut: 'G D' },
    {
      label: 'Audience',
      icon: UsersRound,
      to: `${base}/audience`,
      end: true,
      shortcut: 'G A',
      children: [
        { label: 'All contacts', to: `${base}/audience/contacts`, shortcut: 'G C' },
        { label: 'Segments', to: `${base}/audience/segments`, shortcut: 'G S' },
        { label: 'Lists', to: `${base}/audience/lists`, shortcut: 'G L' },
        { label: 'Tags', to: `${base}/audience/tags` },
        ...(can('audience.write') ? [{ label: 'Import', to: `${base}/audience/import`, shortcut: 'G I' }] : []),
        { label: 'Custom fields', to: `${base}/audience/fields` },
        { label: 'Suppression', to: `${base}/audience/suppression` },
      ],
    },
    ...(can('forms.read') ? [{ label: 'Lead forms', icon: ClipboardList, to: `${base}/forms`, shortcut: 'G F' }] : []),
    ...(can('chat.read')
      ? [
          {
            label: 'Chat',
            icon: MessagesSquare,
            to: `${base}/chat`,
            end: true,
            shortcut: 'G H',
            children: [
              { label: 'Inbox', to: `${base}/chat/inbox` },
              { label: 'Chatbots', to: `${base}/chat/bots` },
              { label: 'Analytics', to: `${base}/chat`, end: true },
            ],
          },
        ]
      : []),
    {
      label: 'Email',
      icon: Mail,
      to: `${base}/email`,
      end: true,
      shortcut: 'G M',
      children: [
        { label: 'Campaigns', to: `${base}/email/campaigns` },
        { label: 'Templates', to: `${base}/email/templates` },
        ...(can('settings.read') ? [{ label: 'Senders', to: `${base}/email/senders` }] : []),
      ],
    },
    // SMS is coming soon in every market: one entry to the coming-soon page, no sub-pages.
    { label: 'SMS', icon: MessageSquare, to: `${base}/sms`, badge: 'Soon' },
    {
      label: 'Voice',
      icon: PhoneCall,
      to: `${base}/voice`,
      end: true,
      shortcut: 'G V',
      children: [
        { label: 'Calls', to: `${base}/voice/campaigns` },
        { label: 'AI agents', to: `${base}/voice/agents` },
        { label: 'Audio library', to: `${base}/voice/audio` },
      ],
    },
    ...(can('crm.read')
      ? [
          {
            label: 'CRM',
            icon: Handshake,
            to: `${base}/crm/deals`,
            shortcut: 'G R',
            children: [
              { label: 'Deals', to: `${base}/crm/deals` },
              { label: 'Leads', to: `${base}/crm/leads` },
              { label: 'Companies', to: `${base}/crm/companies` },
              { label: 'Tasks', to: `${base}/crm/tasks` },
              { label: 'Reports', to: `${base}/crm/reports` },
              { label: 'CRM settings', to: `${base}/crm/settings` },
            ],
          },
        ]
      : []),
    { label: 'Automation', icon: Workflow, to: `${base}/automation`, shortcut: 'G W' },
    ...(can('ai.use')
      ? [
          {
            label: 'AI Team',
            icon: Sparkles,
            to: `${base}/ai/agents`,
            children: [
              { label: 'AI Assistant', to: `${base}/ai/assistant`, action: 'assistant' as const },
              { label: 'AI Agents', to: `${base}/ai/agents` },
              ...(can('ai.manage') ? [{ label: 'Approvals', to: `${base}/ai/approvals`, badgeKey: 'approvals' as const }] : []),
              { label: 'Integrations', to: `${base}/ai/integrations` },
            ],
          },
        ]
      : []),
    ...(can('analytics.read') ? [{ label: 'Analytics', icon: BarChart3, to: `${base}/analytics`, shortcut: 'G Y' }] : []),
    ...(can('settings.read') ? [{ label: 'Settings', icon: Settings, to: `${base}/settings`, shortcut: 'G E' }] : []),
  ]
}

export function orgNav(org: Organization | null): NavItem[] {
  if (!org) return []
  const can = (p: string) => org.permissions.includes(p)
  return [
    { label: 'Applications', icon: LayoutGrid, to: `/orgs/${org.id}/applications` },
    ...(can('members.read') ? [{ label: 'Team', icon: Users, to: `/orgs/${org.id}/team`, shortcut: 'G T' }] : []),
    { label: 'Organization', icon: Building2, to: `/orgs/${org.id}/settings` },
    ...(can('billing.read') ? [{ label: 'Billing', icon: CreditCard, to: `/orgs/${org.id}/billing` }] : []),
    ...(can('audit.read') ? [{ label: 'Audit log', icon: ScrollText, to: `/orgs/${org.id}/audit-log` }] : []),
  ]
}

/** "G then X" navigation shortcuts. */
export function shortcutTargets(app: Application | null, org: Organization | null): Record<string, string> {
  const map: Record<string, string> = {}
  for (const item of [...appNav(app), ...orgNav(org)]) {
    if (item.shortcut && item.to) map[item.shortcut.split(' ')[1]!.toLowerCase()] = item.to
    for (const c of item.children ?? []) if (c.shortcut) map[c.shortcut.split(' ')[1]!.toLowerCase()] = c.to
  }
  return map
}
