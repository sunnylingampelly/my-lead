import { Clock, Flag, GitBranch, Mail, MessageSquare, PhoneCall, Split, UserCog, Zap, type LucideIcon } from 'lucide-react'
import type { FlowEdge, FlowNode, NodeType, WorkflowGraph } from '@/api/automation'

export interface NodeMeta {
  label: string
  description: string
  icon: LucideIcon
  /** Tailwind classes for the node's icon chip. */
  tone: string
  group: 'Trigger' | 'Messages' | 'Flow' | 'Contact'
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
  end: { label: 'End', description: 'Finish the journey', icon: Flag, tone: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-500/20 dark:text-zinc-300', group: 'Flow', outputs: [] },
}

export const TRIGGER_LABEL: Record<string, string> = {
  contact_created: 'Contact is created',
  added_to_list: 'Added to a list',
  tag_added: 'Tag is added',
  segment_entered: 'Enters a segment',
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
    description: 'Welcome email, wait two days, then a follow-up text to anyone who didn’t open it.',
    graph: {
      nodes: [
        n('trigger', 'trigger', 0, 0, { kind: 'added_to_list' }),
        n('email', 'send_email', 0, 140, { label: 'Welcome email' }),
        n('wait', 'wait', 0, 280, { amount: 2, unit: 'days' }),
        n('opened', 'condition', 0, 420, { kind: 'engagement', node_id: 'email', event: 'opened' }),
        n('tag', 'update_contact', -180, 580, { action: 'add_tag', label: 'Tag as engaged' }),
        n('sms', 'send_sms', 180, 580, { label: 'Nudge by SMS' }),
      ],
      edges: [e('trigger', 'email'), e('email', 'wait'), e('wait', 'opened'), e('opened', 'tag', 'yes'), e('opened', 'sms', 'no')],
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
    description: 'Split new segment members between an email and an SMS and compare results.',
    graph: {
      nodes: [
        n('trigger', 'trigger', 0, 0, { kind: 'segment_entered' }),
        n('split', 'split', 0, 140, { percent_a: 50 }),
        n('email', 'send_email', -180, 300, { label: 'Version A: email' }),
        n('sms', 'send_sms', 180, 300, { label: 'Version B: SMS' }),
      ],
      edges: [e('trigger', 'split'), e('split', 'email', 'a'), e('split', 'sms', 'b')],
    },
  },
]
