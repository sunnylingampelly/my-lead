import { useRef, type ReactNode } from 'react'
import { motion, useScroll, useSpring } from 'framer-motion'
import { Bot, CalendarClock, Check, ClipboardList, Handshake, PhoneCall, Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Accent } from '../components/GradientText'
import { Section, SectionHeading } from '../components/Section'

const EASE = [0.22, 1, 0.36, 1] as const

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border bg-card p-4 text-[13px] shadow-card">{children}</div>
}

const STEPS = [
  {
    time: '21:02',
    icon: ClipboardList,
    product: 'Lead form',
    title: 'Priya fills in your form',
    text: 'She clicks an Instagram ad and requests a demo. A contact is created with the campaign, page and consent attached.',
    visual: (
      <Card>
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold">Priya Nair</span>
          <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success-strong">New lead</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11.5px] text-muted-foreground">
          <span>utm: instagram</span>
          <span>page: /catering</span>
          <span>consent: recorded</span>
          <span>owner: Arjun</span>
        </div>
      </Card>
    ),
  },
  {
    time: '21:04',
    icon: Bot,
    product: 'AI chatbot',
    title: 'The assistant answers her question',
    text: 'She asks about delivery to Pune. The AI answers from your FAQ and books a tasting call, then saves a summary to her timeline.',
    visual: (
      <Card>
        <div className="space-y-1.5">
          <div className="ml-auto w-fit rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-primary-foreground">Do you deliver to Pune?</div>
          <div className="w-fit max-w-[90%] rounded-2xl rounded-bl-sm bg-muted px-3 py-1.5">Yes, in 2 days. Shall I book a tasting call?</div>
        </div>
      </Card>
    ),
  },
  {
    time: '21:20',
    icon: PhoneCall,
    product: 'AI calling agent',
    title: 'An AI agent calls while she is still interested',
    text: 'Maya, your AI agent, confirms the headcount and budget and books a callback, from a number Signalcraft manages.',
    visual: (
      <Card>
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-accent text-accent-foreground">
            <PhoneCall className="size-3.5" aria-hidden />
          </span>
          <span className="font-medium">AI call · 2m 14s</span>
          <span className="ml-auto rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground">Interested</span>
        </div>
        <p className="mt-2 text-muted-foreground">“40 people, three days a week. Call back Thursday 11 am.”</p>
      </Card>
    ),
  },
  {
    time: '21:21',
    icon: Handshake,
    product: 'CRM',
    title: 'A deal opens in your pipeline',
    text: 'The call outcome creates a deal for Arjun, with the transcript, summary and a callback task already on it.',
    visual: (
      <Card>
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-semibold">Chai & Co · office catering</div>
            <div className="text-[11.5px] text-muted-foreground">Proposal · Owner: Arjun</div>
          </div>
          <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground">
            <CalendarClock className="size-3.5" aria-hidden /> Thu 11:00
          </span>
        </div>
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted">
          <motion.div className="h-full origin-left rounded-full bg-primary" initial={{ scaleX: 0 }} whileInView={{ scaleX: 0.6 }} viewport={{ once: true }} transition={{ duration: 1.2, ease: EASE, delay: 0.3 }} />
        </div>
      </Card>
    ),
  },
  {
    time: 'Thu',
    icon: Workflow,
    product: 'Automation',
    title: 'Follow-ups run themselves',
    text: 'A workflow sends the menu by email, reminds Arjun before the callback and has the AI agent call Priya if she has not opened it.',
    visual: (
      <Card>
        <ul className="space-y-1.5">
          {['Email “Catering menu” sent', 'Reminder to Arjun at 10:45', 'AI call if not opened by Wed'].map((s) => (
            <li key={s} className="flex items-center gap-2">
              <span className="flex size-4 items-center justify-center rounded-full bg-success-soft text-success-strong">
                <Check className="size-3" strokeWidth={3} aria-hidden />
              </span>
              {s}
            </li>
          ))}
        </ul>
      </Card>
    ),
  },
]

/** "How a lead flows": a scroll-driven storyline from form to workflow. */
export function LeadFlow() {
  const ref = useRef<HTMLOListElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 75%', 'end 55%'] })
  const fill = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.3 })
  return (
    <Section id="flow" labelledBy="flow-title" className="bg-muted/40">
      <SectionHeading
        id="flow-title"
        eyebrow="How a lead flows"
        title={
          <>
            From first click to <Accent>closed deal</Accent>, without a hand-off.
          </>
        }
        lead="One evening, one lead, five tools working together. Illustrative example; the names are made up."
      />
      <ol ref={ref} className="relative mx-auto mt-16 max-w-4xl">
        {/* The rail and its scroll-driven fill. */}
        <div className="absolute bottom-2 left-[19px] top-2 w-px bg-border md:left-1/2" aria-hidden />
        <motion.div className="absolute bottom-2 left-[19px] top-2 w-px origin-top bg-gradient-to-b from-indigo-500 via-violet-500 to-fuchsia-500 md:left-1/2" style={{ scaleY: fill }} aria-hidden />
        {STEPS.map((s, i) => {
          const right = i % 2 === 1
          return (
            <li key={s.title} className="relative grid grid-cols-[40px_1fr] gap-x-5 pb-14 last:pb-0 md:grid-cols-[1fr_40px_1fr] md:gap-x-10">
              <motion.span
                initial={{ scale: 0.8, opacity: 0.65 }}
                whileInView={{ scale: 1, opacity: 1 }}
                viewport={{ once: false, margin: '-45% 0px -45% 0px' }}
                transition={{ duration: 0.4, ease: EASE }}
                className="relative z-10 col-start-1 row-span-2 flex size-10 items-center justify-center rounded-full border-4 border-muted bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/30 md:col-start-2 md:row-start-1"
              >
                <s.icon className="size-4" aria-hidden />
              </motion.span>
              <motion.div
                initial={{ opacity: 0, x: right ? 24 : -24 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: '-15% 0px' }}
                transition={{ duration: 0.7, ease: EASE }}
                className={cn('col-start-2 min-w-0 md:row-start-1', right ? 'md:col-start-3' : 'md:col-start-1 md:text-right')}
              >
                <div className={cn('flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary', !right && 'md:justify-end')}>
                  <span className="rounded-full bg-accent px-2 py-0.5 tabular-nums text-accent-foreground">{s.time}</span> {s.product}
                </div>
                <h3 className="mt-2 text-xl font-semibold tracking-tight sm:text-2xl">{s.title}</h3>
                <p className="mt-2 leading-relaxed text-muted-foreground">{s.text}</p>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-15% 0px' }}
                transition={{ duration: 0.7, delay: 0.12, ease: EASE }}
                className={cn('col-start-2 mt-4 min-w-0 md:row-start-1 md:mt-0', right ? 'md:col-start-1' : 'md:col-start-3')}
              >
                {s.visual}
              </motion.div>
            </li>
          )
        })}
      </ol>
    </Section>
  )
}
