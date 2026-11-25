import { Bot, BrainCircuit, ClipboardList, Mail, MessageSquare, PhoneCall, Sparkles, Workflow, type LucideIcon } from 'lucide-react'
import { channelSoon, discounted, findPlan, money, percent, smsSoon, type Currency, type PublicPricing, type RateKey } from '../pricing'

const RATES: { key: RateKey; icon: LucideIcon; label: string; unit: string; approx?: RateKey }[] = [
  { key: 'email', icon: Mail, label: 'Email', unit: 'per email' },
  { key: 'sms_transactional', icon: MessageSquare, label: 'SMS · transactional', unit: 'per message part' },
  { key: 'sms_promotional', icon: MessageSquare, label: 'SMS · promotional', unit: 'per message part' },
  { key: 'voice_minute', icon: PhoneCall, label: 'Voice call (recorded or text-to-speech)', unit: 'per started minute' },
  { key: 'voice_ai_minute', icon: Sparkles, label: 'AI calling agent', unit: 'per started minute' },
  { key: 'chat_reply', icon: Bot, label: 'AI chatbot', unit: 'per AI reply' },
  // Metered: shown as the typical charge, with the minimum ("from") in the unit line.
  { key: 'ai_assistant_message_typical', icon: BrainCircuit, label: 'AI Assistant', unit: 'per simple question, typically', approx: 'ai_assistant_message_from' },
  { key: 'ai_agent_run_typical', icon: BrainCircuit, label: 'AI agent run', unit: 'per typical run', approx: 'ai_agent_run_from' },
]

const FREE = [
  { icon: ClipboardList, label: 'Lead forms and live chat', note: 'No usage charge' },
  { icon: Workflow, label: 'CRM, automation and analytics', note: 'Included' },
]

/** Per-channel rates on each plan, read live from the API. */
export function RateCard({ data, currency }: { data: PublicPricing | undefined; currency: Currency }) {
  const pro = findPlan(data, 'pro')
  const wait = <span className="inline-block h-4 w-14 animate-pulse rounded bg-muted" />
  const soon = (key: RateKey) => key.startsWith('voice') && channelSoon(data, 'voice')
  // SMS is "coming soon" everywhere: one row without a price until it opens.
  const sms = smsSoon(data)
  const rows = sms ? RATES.filter((r) => !r.key.startsWith('sms')) : RATES
  return (
    <div className="overflow-hidden rounded-[1.75rem] border bg-card shadow-card" data-testid="rate-card">
      <table className="w-full text-sm">
        <caption className="sr-only">Usage rates</caption>
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th scope="col" className="px-4 py-4 font-semibold sm:px-8">Channel</th>
            <th scope="col" className="px-3 py-4 font-semibold sm:px-6">Starter</th>
            <th scope="col" className="px-3 py-4 font-semibold text-primary sm:px-6">
              Pro{pro ? <span className="hidden normal-case tracking-normal sm:inline"> · {percent(pro.usage_discount)} off</span> : null}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(({ key, icon: Icon, label, unit, approx }) => (
            <tr key={key}>
              <th scope="row" className="px-4 py-4 text-left font-normal sm:px-8">
                <span className="flex items-start gap-3">
                  <span className="mt-0.5 hidden size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground sm:flex">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span>
                    <span className="block font-medium">{label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {unit}
                      {approx && data ? ` · metered, from ${money(data.rates[approx], currency)}` : ''}
                      {soon(key) && <span className="ml-1.5 rounded-full bg-muted px-2 py-0.5 font-medium">Calls to the UAE: coming soon</span>}
                    </span>
                  </span>
                </span>
              </th>
              <td className="px-3 py-4 tabular-nums sm:px-6" data-testid={`rate-${key}`}>{data ? `${approx ? '≈ ' : ''}${money(data.rates[key], currency)}` : wait}</td>
              <td className="px-3 py-4 font-semibold tabular-nums text-primary sm:px-6">{data && pro ? `${approx ? '≈ ' : ''}${money(discounted(data.rates[key], pro.usage_discount), currency)}` : wait}</td>
            </tr>
          ))}
          {sms && (
            <tr data-testid="rate-sms-soon">
              <th scope="row" className="px-4 py-4 text-left font-normal sm:px-8">
                <span className="flex items-start gap-3">
                  <span className="mt-0.5 hidden size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground sm:flex">
                    <MessageSquare className="size-4" aria-hidden />
                  </span>
                  <span>
                    <span className="block font-medium">SMS</span>
                    <span className="block text-xs text-muted-foreground">DLT, 10DLC and UAE-ready texts with two-way replies</span>
                  </span>
                </span>
              </th>
              <td colSpan={2} className="px-3 py-4 sm:px-6">
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-400/15 dark:text-amber-200">Coming soon</span>
              </td>
            </tr>
          )}
          {FREE.map(({ icon: Icon, label, note }) => (
            <tr key={label}>
              <th scope="row" className="px-4 py-4 text-left font-normal sm:px-8">
                <span className="flex items-center gap-3">
                  <span className="hidden size-8 shrink-0 items-center justify-center rounded-lg bg-success-soft text-success-strong sm:flex">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span className="font-medium">{label}</span>
                </span>
              </th>
              <td colSpan={2} className="px-3 py-4 text-success-strong sm:px-6">
                {note}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
