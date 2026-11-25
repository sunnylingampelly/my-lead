import { Clock, Flag, GitBranch, Handshake, Hash, Mail, MessageSquare, PhoneCall, Sparkles, Split, UserCog, Zap, type LucideIcon } from 'lucide-react'
import type { FlowEdge, FlowNode, NodeType, WorkflowGraph } from '@/api/automation'

export interface NodeMeta {
  label: string
  description: string
  icon: LucideIcon
  /** Tailwind classes for the node's icon chip. */
  tone: string
  group: 'Trigger' | 'Messages' | 'Flow' | 'Contact' | 'CRM' | 'AI'
  outputs: (string | null)[]
}

export const NODE_META: Record<NodeType, NodeMeta> = {
  trigger: { label: 'Trigger', description: 'What starts the journey', icon: Zap, tone: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300', group: 'Trigger', outputs: [null] },
  send_email: { label: 'Send email', description: 'Email from a template', icon: Mail, tone: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300', group: 'Messages', outputs: [null] },
  send_sms: { label: 'Send SMS', description: 'Text message', icon: MessageSquare, tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300', group: 'Messages', outputs: [null] },
  voice_call: { label: 'Voice call', description: 'Automated call', icon: PhoneCall, tone: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300', group: 'Messages', outputs: [null] },
  wait: { label: 'Wait', description: 'Pause before the next step', icon: Clock, tone: 'bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300', group: 'Flow', outputs: [null] },
  condition: { label: 'Condition', description: 'Yes / no branch', icon: GitBranch, tone: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300', group: 'Flow', outputs: ['yes', 'no'] },
  split: { label: 'A/B split', description: 'Random split by percentage', icon: Split, tone: 'bg-pink-100 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300', group: 'Flow', outputs: ['a', 'b'] },
  update_contact: { label: 'Update contact', description: 'Tags and lists', icon: UserCog, tone: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300', group: 'Contact', outputs: [null] },
  crm_action: { label: 'CRM action', description: 'Deals, tasks, owner, lifecycle', icon: Handshake, tone: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300', group: 'CRM', outputs: [null] },
  ai_step: { label: 'AI step', description: 'Classify, extract or write with AI', icon: Sparkles, tone: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300', group: 'AI', outputs: [null] },
  slack_message: { label: 'Send to Slack', description: 'Post to a Slack channel', icon: Hash, tone: 'bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-300', group: 'AI', outputs: [null] },
  end: { label: 'End', description: 'Finish the journey', icon: Flag, tone: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-500/20 dark:text-zinc-300', group: 'Flow', outputs: [] },
}

/** SMS is coming soon in every market: these steps and triggers are shown but can't be added. */
export const COMING_SOON_STEPS: NodeType[] = ['send_sms']
export const COMING_SOON_TRIGGERS = ['sms_replied']

export const TRIGGER_LABEL: Record<string, string> = {
  contact_created: 'Contact is created',
  added_to_list: 'Added to a list',
  tag_added: 'Tag is added',
  segment_entered: 'Enters a segment',
  form_submitted: 'Form is submitted',
  sms_replied: 'SMS reply received (coming soon)',
  email_clicked: 'Email link clicked',
  call_answered: 'Call answered',
  unsubscribed: 'Unsubscribed or opted out',
  deal_created: 'Deal is created',
  deal_stage_changed: 'Deal changes stage',
  deal_won: 'Deal is won',
  deal_lost: 'Deal is lost',
  deal_rotting: 'Deal is going cold',
  score_reached: 'Lead becomes hot',
  sla_breached: 'First-response SLA is missed',
  owner_assigned: 'Owner is assigned',
  ai_call_completed: 'AI call completed',
  chat_lead_captured: 'Chatbot captures a lead',
  chat_conversation_closed: 'Chat conversation ends',
}

/** Triggers fired from CRM events. Deal triggers can be narrowed to a pipeline (and stage). */
export const CRM_TRIGGERS = ['deal_created', 'deal_stage_changed', 'deal_won', 'deal_lost', 'deal_rotting', 'score_reached', 'sla_breached', 'owner_assigned', 'ai_call_completed', 'chat_lead_captured', 'chat_conversation_closed']
/** Triggers fired by how contacts respond on a channel. */
export const ENGAGEMENT_TRIGGERS = ['sms_replied', 'email_clicked', 'call_answered', 'unsubscribed']
export const DEAL_TRIGGERS =['deal_created', 'deal_stage_changed', 'deal_won', 'deal_lost', 'deal_rotting']

export const CRM_ACTION_LABEL: Record<string, string> = {
  create_deal: 'Create a deal',
  create_task: 'Create a task',
  assign_owner: 'Assign an owner',
  move_deal: 'Move their deal',
  set_lifecycle: 'Set lifecycle stage',
}

export const HANDLE_LABEL: Record<string, string> = { yes: 'Yes', no: 'No', a: 'A', b: 'B' }

export const DEFAULT_DATA: Record<NodeType, Record<string, unknown>> = {
  trigger: { kind: 'contact_created' },
  send_email: {},
  send_sms: { category: 'promotional', append_opt_out: true },
  voice_call: { category: 'promotional', opt_out_keypress: true, intro_text: '' },
  wait: { amount: 1, unit: 'days' },
  condition: { kind: 'engagement', event: 'opened' },
  split: { percent_a: 50 },
  update_contact: { action: 'add_tag' },
  crm_action: { action: 'create_task', title: 'Follow up with {{name}}', task_type: 'follow_up', priority: 'normal', due_in_hours: 24 },
  ai_step: { mode: 'classify', prompt: '', categories: ['pricing', 'support', 'other'], output_field: '' },
  slack_message: { message: 'New lead: {{contact.first_name}} {{contact.last_name}} ({{contact.email}})' },
  end: {},
}

let seq = 0
export const newId = (type: string) => `${type}_${Date.now().toString(36)}${(seq++).toString(36)}`

const n = (id: string, type: NodeType, x: number, y: number, data: Record<string, unknown> = {}): FlowNode => ({ id, type, position: { x, y }, data: { ...DEFAULT_DATA[type], ...data } })
const e = (source: string, target: string, sourceHandle?: string): FlowEdge => ({ id: `${source}-${target}-${sourceHandle ?? ''}`, source, target, sourceHandle })

export interface Starter {
  key: string
  name: string
  description: string
  group?: 'CRM'
  graph: WorkflowGraph
}

/** Starting points. Senders, templates and lists are left for the user to choose. */
export const STARTERS: Starter[] = [
  {
    key: 'blank',
    name: 'Start from scratch',
    description: 'Just a trigger. Add the steps you need.',
    graph: { nodes: [n('trigger', 'trigger', 0, 0)], edges: [] },
  },
  {
    key: 'welcome',
    name: 'Welcome series',
    description: 'When a contact is created: welcome email, wait two days, then a follow-up email to anyone who didn’t open it.',
    graph: {
      nodes: [
        n('trigger', 'trigger', 0, 0, { kind: 'contact_created' }),
        n('email', 'send_email', 0, 140, { label: 'Welcome email' }),
        n('wait', 'wait', 0, 280, { amount: 2, unit: 'days' }),
        n('opened', 'condition', 0, 420, { kind: 'engagement', node_id: 'email', event: 'opened' }),
        n('tag', 'update_contact', -180, 580, { action: 'add_tag', label: 'Tag as engaged' }),
        n('nudge', 'send_email', 180, 580, { label: 'Follow-up email' }),
      ],
      edges: [e('trigger', 'email'), e('email', 'wait'), e('wait', 'opened'), e('opened', 'tag', 'yes'), e('opened', 'nudge', 'no')],
    },
  },
  {
    key: 'reengage',
    name: 'Win back',
    description: 'When someone is tagged inactive, email them and call the ones who still don’t click.',
    graph: {
      nodes: [
        n('trigger', 'trigger', 0, 0, { kind: 'tag_added' }),
        n('email', 'send_email', 0, 140, { label: 'We miss you' }),
        n('wait', 'wait', 0, 280, { amount: 3, unit: 'days' }),
        n('clicked', 'condition', 0, 420, { kind: 'engagement', node_id: 'email', event: 'clicked' }),
        n('done', 'end', -180, 580),
        n('call', 'voice_call', 180, 580, { label: 'Personal call' }),
      ],
      edges: [e('trigger', 'email'), e('email', 'wait'), e('wait', 'clicked'), e('clicked', 'done', 'yes'), e('clicked', 'call', 'no')],
    },
  },
  {
    key: 'ab',
    name: 'A/B test a message',
    description: 'Split new segment members between two emails and compare results.',
    graph: {
      nodes: [
        n('trigger', 'trigger', 0, 0, { kind: 'segment_entered' }),
        n('split', 'split', 0, 140, { percent_a: 50 }),
        n('email', 'send_email', -180, 300, { label: 'Version A' }),
        n('email_b', 'send_email', 180, 300, { label: 'Version B' }),
      ],
      edges: [e('trigger', 'split'), e('split', 'email', 'a'), e('split', 'email_b', 'b')],
    },
  },
  {
    key: 'deal_won',
    name: 'Deal won → onboarding',
    description: 'When a deal is won: an onboarding task for the owner and the contact becomes a customer.',
    group: 'CRM',
    graph: {
      nodes: [
        n('trigger', 'trigger', 0, 0, { kind: 'deal_won' }),
        n('task', 'crm_action', 0, 140, { action: 'create_task', title: 'Onboard {{name}}', task_type: 'call', priority: 'high', due_in_hours: 24, label: 'Onboarding task' }),
        n('customer', 'crm_action', 0, 280, { action: 'set_lifecycle', lifecycle_stage: 'customer', label: 'Mark as customer' }),
      ],
      edges: [e('trigger', 'task'), e('task', 'customer')],
    },
  },
  {
    key: 'hot_lead',
    name: 'Hot lead → owner and follow-up',
    description: 'When a lead becomes hot: assign an owner, then a follow-up task due within 4 hours.',
    group: 'CRM',
    graph: {
      nodes: [
        n('trigger', 'trigger', 0, 0, { kind: 'score_reached' }),
        n('assign', 'crm_action', 0, 140, { action: 'assign_owner', user_id: '', label: 'Assign an owner' }),
        n('task', 'crm_action', 0, 280, { action: 'create_task', title: 'Call {{name}} (hot lead)', task_type: 'call', priority: 'high', due_in_hours: 4, label: 'Follow-up task' }),
      ],
      edges: [e('trigger', 'assign'), e('assign', 'task')],
    },
  },
  {
    key: 'deal_cold',
    name: 'Deal going cold → nudge the owner',
    description: 'When a deal has had no activity for too long: a task for its owner to re-engage.',
    group: 'CRM',
    graph: {
      nodes: [
        n('trigger', 'trigger', 0, 0, { kind: 'deal_rotting' }),
        n('task', 'crm_action', 0, 140, { action: 'create_task', title: 'Re-engage {{name}}: deal going cold', task_type: 'follow_up', priority: 'high', due_in_hours: 24 }),
      ],
      edges: [e('trigger', 'task')],
    },
  },
  {
    key: 'sla_missed',
    name: 'SLA missed → reassign',
    description: 'When a new lead waits past the first-response SLA: reassign by rotation and create an urgent task.',
    group: 'CRM',
    graph: {
      nodes: [
        n('trigger', 'trigger', 0, 0, { kind: 'sla_breached' }),
        n('assign', 'crm_action', 0, 140, { action: 'assign_owner', rule_id: '', user_id: null, label: 'Reassign by rotation' }),
        n('task', 'crm_action', 0, 280, { action: 'create_task', title: 'Respond to {{name}} now (SLA missed)', task_type: 'call', priority: 'high', due_in_hours: 1 }),
      ],
      edges: [e('trigger', 'assign'), e('assign', 'task')],
    },
  },
]
