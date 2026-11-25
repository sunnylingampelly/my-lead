import { AnimatePresence, motion } from 'framer-motion'
import { Bot, Check, Hash, ShieldCheck, Sparkles } from 'lucide-react'
import { SlackLogo } from '@/components/SlackLogo'
import { cn } from '@/lib/utils'
import { DemoFrame } from './DemoFrame'
import { progress, streamed, typed, useDemoClock } from './useDemoClock'

const ASK = 'Create a task to call Priya tomorrow'
const ANSWER = 'I’ve prepared it. Review the details and confirm.'

/**
 * The AI Team: the in-app assistant proposes a change as a card that only runs once confirmed, and an AI
 * agent posts its daily report to a Slack channel with buttons. Sample data.
 */
export function AiTeamDemo({ className }: { className?: string }) {
  const { ref, t } = useDemoClock(13000, { staticAt: 12500 })
  const question = typed(ASK, t, 300, 40)
  const answering = t > 2100
  const card = t > 3200
  const pressed = t > 4700
  const done = t > 5300
  const slack = t > 6800
  const approved = t > 10200
  return (
    <DemoFrame ref={ref} title="Signalcraft · AI Team" className={className} testId="demo-ai-team" bodyClassName="p-0 sm:p-0">
      <div className="grid sm:grid-cols-2">
        {/* Assistant */}
        <div className="flex min-h-[340px] flex-col border-b border-white/[0.07] sm:border-b-0 sm:border-r">
          <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-2.5 text-[12px] font-semibold">
            <span className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-indigo-400 to-violet-500">
              <Sparkles className="size-3.5" />
            </span>
            AI Assistant
            <span className="ml-auto text-[10px] font-normal text-white/40">Ctrl J</span>
          </div>
          <div className="flex flex-1 flex-col justify-end gap-2 px-4 py-3 text-[12.5px] leading-snug">
            {question && <div className="ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-sm bg-indigo-500 px-3 py-1.5">{question}</div>}
            {answering && <div className="w-fit max-w-[95%] text-white/85">{streamed(ANSWER, t, 2100, 110)}</div>}
            <AnimatePresence>
              {card && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-indigo-400/40 bg-white/[0.04]">
                  <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
                    <ShieldCheck className="size-3.5 text-indigo-300" />
                    <span className="font-medium">Create task: Call Priya</span>
                    <span className={cn('ml-auto rounded-full px-1.5 py-0.5 text-[10px]', done ? 'bg-emerald-400/15 text-emerald-300' : 'bg-amber-400/15 text-amber-200')}>{done ? 'Done' : 'Waiting for you'}</span>
                  </div>
                  <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 px-3 py-2 text-[11.5px]">
                    <dt className="text-white/45">Due</dt>
                    <dd>Tomorrow, 10:00</dd>
                    <dt className="text-white/45">Contact</dt>
                    <dd>Priya Nair</dd>
                    <dt className="text-white/45">Assignee</dt>
                    <dd>You</dd>
                  </dl>
                  {!done ? (
                    <div className="flex gap-1.5 border-t border-white/[0.07] px-3 py-2 text-[11px]">
                      <span className={cn('rounded-md px-2 py-1 font-medium transition', pressed ? 'scale-95 bg-indigo-300 text-indigo-950' : 'bg-indigo-500')}>Confirm</span>
                      <span className="rounded-md border border-white/15 px-2 py-1">Edit</span>
                      <span className="rounded-md px-2 py-1 text-white/60">Cancel</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 border-t border-white/[0.07] px-3 py-2 text-[11px] text-emerald-300">
                      <Check className="size-3" /> Task created · Open task
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        {/* Slack channel */}
        <div className="flex min-h-[340px] flex-col">
          <div className="flex items-center gap-1.5 border-b border-white/[0.07] px-4 py-2.5 text-[12px] font-semibold">
            <Hash className="size-3.5 text-white/60" /> sales
            <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] font-normal text-white/50"><SlackLogo className="size-3.5" /> Slack</span>
          </div>
          <div className="flex flex-1 flex-col justify-end gap-2 px-4 py-3 text-[12px] leading-snug">
            <AnimatePresence>
              {slack && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-white/10">
                    <Bot className="size-4" />
                  </span>
                  <div className="min-w-0 space-y-1.5">
                    <div className="text-[11px]">
                      <span className="font-semibold">Signalcraft</span> <span className="text-white/40">· Stale-deal watchdog</span>
                    </div>
                    <p className="text-white/85">3 deals are going cold:</p>
                    <ul className="space-y-0.5 text-white/75">
                      {['Acme renewal · 12 days in Proposal', 'Lotus Clinic · 9 days in Demo', 'Nova School · 15 days in New'].map((d, i) => (
                        <li key={d} style={{ opacity: progress(t, 7300 + i * 400, 7700 + i * 400) }}>
                          • {d}
                        </li>
                      ))}
                    </ul>
                    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2" style={{ opacity: progress(t, 8600, 9100) }}>
                      <div className="text-[11px] text-white/80">
                        Wants to: <span className="font-medium">Create task: Re-engage Acme</span>
                      </div>
                      <div className="mt-1.5 flex gap-1.5 text-[10.5px]">
                        {approved ? (
                          <span className="inline-flex items-center gap-1 text-emerald-300">
                            <Check className="size-3" /> Approved by Ravi
                          </span>
                        ) : (
                          <>
                            <span className={cn('rounded px-1.5 py-0.5 font-medium', t > 9800 ? 'bg-emerald-300 text-emerald-950' : 'bg-emerald-500/80')}>Approve</span>
                            <span className="rounded bg-rose-500/70 px-1.5 py-0.5">Reject</span>
                            <span className="rounded border border-white/15 px-1.5 py-0.5">Open in Signalcraft</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </DemoFrame>
  )
}
