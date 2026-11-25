import type { PageContext } from '@/types/ai'

/** What the assistant should know about the page the person is on: the route and the ids in it. */
export function pageContext(pathname: string, title?: string): PageContext {
  const ctx: PageContext = { path: pathname, title }
  const id = (re: RegExp) => re.exec(pathname)?.[1]
  const uuid = '([0-9a-f-]{36})'
  ctx.contact_id = id(new RegExp(`/audience/contacts/${uuid}`))
  ctx.deal_id = id(new RegExp(`/crm/deals/${uuid}`))
  ctx.campaign_id = id(new RegExp(`/(?:email|voice)/campaigns/${uuid}`))
  ctx.form_id = id(new RegExp(`/forms/${uuid}`))
  ctx.workflow_id = id(new RegExp(`/automation/${uuid}`))
  ctx.bot_id = id(new RegExp(`/chat/bots/${uuid}`))
  ctx.agent_id = id(new RegExp(`/ai/agents/${uuid}`))
  for (const k of Object.keys(ctx) as (keyof PageContext)[]) if (ctx[k] === undefined) delete ctx[k]
  return ctx
}

const BY_PAGE: [RegExp, string[]][] = [
  [/\/crm\/deals\/[0-9a-f-]{36}/, ['Add a note to this deal: spoke to the buyer, waiting on budget', 'Which deals are stale?']],
  [/\/crm\/deals/, ['Which deals are stale?', 'Show the pipeline by stage', 'Create a task to call the owner of the biggest deal tomorrow']],
  [/\/crm\/tasks/, ['What tasks are due today?', 'Show overdue tasks for the team', 'Create a task to follow up with Priya tomorrow']],
  [/\/crm\/leads/, ['Show hot leads', 'Which deals are stale?']],
  [/\/audience\/contacts\/[0-9a-f-]{36}/, ['Summarise this contact', 'Create a task to call them tomorrow']],
  [/\/audience\/segments/, ['Create a segment of contacts in Mumbai', 'How many leads have a score above 50?']],
  [/\/audience/, ['Find contacts named Priya', 'Create a segment of contacts in Mumbai', 'Show hot leads']],
  [/\/email\/campaigns\/[0-9a-f-]{36}/, ['Why can’t this campaign launch?', 'How did my last campaigns perform?']],
  [/\/email/, ['How did my last campaigns perform?', 'Draft an email about our Diwali offer', 'Why can’t my draft campaign launch?']],
  [/\/forms/, ['How are my lead forms converting?', 'Create a demo request form']],
  [/\/chat/, ['What questions couldn’t the chatbot answer?', 'How many leads came from chat this week?']],
  [/\/automation/, ['Build a workflow that follows up when a form is submitted', 'How do conditions work?']],
  [/\/analytics/, ['How did we do this week?', 'How did we do yesterday?']],
  [/\/ai\/agents/, ['Set up an agent that posts a daily report', 'Create a stale-deal watchdog agent']],
  [/\/voice/, ['How do AI calling agents work?', 'How did we do this week?']],
]

const DEFAULT = ['How did we do this week?', 'Which deals are stale?', 'What tasks are due today?', 'What’s my wallet balance?']

export function suggestionsFor(pathname: string): string[] {
  for (const [re, items] of BY_PAGE) if (re.test(pathname)) return items
  return DEFAULT
}

export const EXAMPLES = [
  { title: 'Ask about your data', prompts: ['How did we do this week?', 'Which deals are stale?', 'What questions couldn’t the chatbot answer?'] },
  { title: 'Get things done', prompts: ['Create a task to call Priya tomorrow', 'Create a segment of contacts in Mumbai', 'Draft an email about our new pricing'] },
  { title: 'Learn the product', prompts: ['How do I import contacts?', 'How do I verify a sender domain?'] },
]
