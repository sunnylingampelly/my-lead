import { useRef, useState } from 'react'
import { AnimatePresence, motion, useInView, useReducedMotion } from 'framer-motion'
import { ArrowRight, Bot, Check, ClipboardList, Handshake, PhoneCall, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Aurora } from '../components/Aurora'
import { CtaLink } from '../components/Buttons'
import { Accent } from '../components/GradientText'
import { Marquee } from '../components/Marquee'
import { ChatDemo, CrmDemo, FormDemo, VoiceDemo } from '../demos'

const EASE = [0.22, 1, 0.36, 1] as const

const STORY = [
  { key: 'capture', icon: ClipboardList, title: 'Capture', text: 'A form fills in and a lead lands with its source.', demo: FormDemo },
  { key: 'converse', icon: Bot, title: 'Converse', text: 'The AI assistant answers and books a call.', demo: ChatDemo },
  { key: 'call', icon: PhoneCall, title: 'Call', text: 'An AI agent qualifies the lead by phone.', demo: VoiceDemo },
  { key: 'close', icon: Handshake, title: 'Close', text: 'The deal moves to Won in your pipeline.', demo: CrmDemo },
] as const

const STEP_SECONDS = 9

/** The hero's animated product story: four tabs that advance on their own while on screen. */
function HeroStory() {
  const [active, setActive] = useState(0)
  const [hover, setHover] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { amount: 0.3 })
  const reduce = useReducedMotion()
  const auto = inView && !reduce && !hover
  const Demo = STORY[active].demo
  return (
    <div ref={ref} className="relative mx-auto mt-16 max-w-5xl sm:mt-20" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="pointer-events-none absolute -inset-x-10 -inset-y-6 rounded-[3rem] bg-[radial-gradient(closest-side,rgb(99_102_241/0.35),transparent)] blur-2xl" aria-hidden />
      <div className="relative grid grid-cols-1 gap-4 rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-3 shadow-[0_0_0_1px_rgb(255_255_255/0.03)_inset] backdrop-blur-sm sm:p-4 lg:grid-cols-[260px_1fr]">
        <div role="tablist" aria-label="Product story" className="mk-no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
          {STORY.map((s, i) => {
            const on = i === active
            return (
              <button
                key={s.key}
                id={`story-tab-${s.key}`}
                role="tab"
                type="button"
                aria-selected={on}
                aria-controls="story-panel"
                onClick={() => setActive(i)}
                className={cn(
                  'relative shrink-0 overflow-hidden rounded-2xl border px-3.5 py-3 text-left transition-colors duration-300 lg:px-4 lg:py-4',
                  on ? 'border-white/15 bg-white/[0.07]' : 'border-transparent hover:bg-white/[0.04]',
                )}
              >
                <span className="flex items-center gap-2.5">
                  <span className={cn('flex size-7 items-center justify-center rounded-lg transition-colors', on ? 'bg-indigo-500 text-white' : 'bg-white/[0.06] text-white/60')}>
                    <s.icon className="size-3.5" aria-hidden />
                  </span>
                  <span className={cn('text-sm font-semibold', on ? 'text-white' : 'text-white/65')}>
                    <span className="mr-1.5 text-white/35">0{i + 1}</span>
                    {s.title}
                  </span>
                </span>
                <span className={cn('mt-2 hidden text-[13px] leading-snug lg:block', on ? 'text-white/60' : 'text-white/40')}>{s.text}</span>
                {on && (
                  <span className="absolute inset-x-3 bottom-0 h-0.5 overflow-hidden rounded-full bg-white/10">
                    {auto ? (
                      <motion.span
                        key={`${active}-run`}
                        className="block h-full origin-left bg-gradient-to-r from-indigo-400 to-violet-400"
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: 1 }}
                        transition={{ duration: STEP_SECONDS, ease: 'linear' }}
                        onAnimationComplete={() => setActive((a) => (a + 1) % STORY.length)}
                      />
                    ) : (
                      <span className="block h-full bg-indigo-400/60" />
                    )}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div id="story-panel" role="tabpanel" aria-labelledby={`story-tab-${STORY[active].key}`} className="relative min-w-0">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={active} initial={{ opacity: 0, y: 12, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.985 }} transition={{ duration: 0.35, ease: EASE }}>
              <Demo />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

const CHIPS = ['Real estate', 'Lead forms', 'Education', 'AI chatbot', 'D2C brands', 'Email', 'Clinics', 'Arabic replies', 'Agencies', 'AI calls', 'SaaS', 'CRM', 'Coaching', 'Automation', 'Restaurants', 'Analytics']

const line = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } }
const word = { hidden: { opacity: 0, y: '0.45em' }, show: { opacity: 1, y: 0, transition: { duration: 0.8, ease: EASE } } }

function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(' ').map((w, i) => (
        <motion.span key={i} variants={word} className="inline-block">
          {w}&nbsp;
        </motion.span>
      ))}
    </>
  )
}

export function Hero() {
  return (
    <section className="mk-ink relative overflow-hidden px-4 pb-16 pt-28 sm:px-6 sm:pb-20 sm:pt-40" aria-labelledby="home-title">
      <Aurora />
      <div className="relative mx-auto max-w-6xl text-center">
        <motion.a
          href="#ai"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: EASE }}
          className="group mb-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1 pl-1 pr-3 text-xs font-medium text-white/75 backdrop-blur transition hover:border-white/20 hover:text-white sm:text-[13px]"
        >
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/90 px-2 py-0.5 text-white">
            <Sparkles className="size-3" aria-hidden /> New
          </span>
          AI agents that chat and call for you
          <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </motion.a>
        <motion.h1
          id="home-title"
          initial="hidden"
          animate="show"
          variants={line}
          className="mx-auto max-w-5xl text-balance text-[2.7rem] font-semibold leading-[1.02] tracking-[-0.045em] sm:text-6xl lg:text-[5.5rem]"
        >
          <Words text="Capture every lead." />
          <span className="sm:block">
            <Words text="Follow up" />
            <motion.span variants={word} className="inline-block">
              <Accent tone="dark">everywhere.</Accent>
            </motion.span>
          </span>
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.45, ease: EASE }}
          className="mx-auto mt-7 max-w-2xl text-pretty text-lg leading-relaxed text-white/65 sm:text-xl"
        >
          Lead forms, an AI chatbot, email and AI voice calls, a CRM and automation in one workspace (SMS coming soon), with compliance for India, the UAE and the US built in.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.6, ease: EASE }}
          className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
        >
          <CtaLink to="/register" variant="white" arrow>
            Start free
          </CtaLink>
          <CtaLink to="/pricing" variant="ghost-dark">
            See pricing
          </CtaLink>
        </motion.div>
        <motion.ul
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.8 }}
          className="mt-7 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-white/50"
        >
          {['No monthly fee on Starter', 'Try everything in simulation mode', 'No card to sign up'].map((t) => (
            <li key={t} className="flex items-center gap-1.5">
              <Check className="size-4 text-indigo-300" aria-hidden /> {t}
            </li>
          ))}
        </motion.ul>
      </div>
      <motion.div initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.1, delay: 0.5, ease: EASE }} className="relative">
        <HeroStory />
      </motion.div>
      <div className="relative mx-auto mt-16 max-w-6xl">
        <p className="mb-5 text-center text-xs font-semibold uppercase tracking-[0.18em] text-white/35">Built for growing teams in India, the UAE and the US</p>
        <Marquee seconds={55}>
          {CHIPS.map((c) => (
            <span key={c} className="whitespace-nowrap rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-sm text-white/60">
              {c}
            </span>
          ))}
        </Marquee>
      </div>
    </section>
  )
}
