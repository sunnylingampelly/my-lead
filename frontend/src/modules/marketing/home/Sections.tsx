import { useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  Bot,
  FileCheck2,
  FileText,
  Globe2,
  KeyRound,
  Link2,
  ListChecks,
  MessageCircleQuestion,
  MessagesSquare,
  PhoneCall,
  ReceiptIndianRupee,
  ScrollText,
  ShieldCheck,
  UserRoundCheck,
  Users,
  Wallet,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Aurora } from '../components/Aurora'
import { CurrencyToggle } from '../components/CurrencyToggle'
import { Accent } from '../components/GradientText'
import { PlanCard, PlanCardSkeleton } from '../components/PlanCard'
import { Reveal, Stagger, StaggerItem } from '../components/Reveal'
import { Section, SectionHeading } from '../components/Section'
import { guessCurrency, usePublicPricing, type Currency } from '../pricing'

// ------------------------------------------------------------------ AI

const SOURCES = [
  { icon: ScrollText, label: 'Instructions', sub: 'Plain-language brief' },
  { icon: MessageCircleQuestion, label: 'FAQs', sub: '24 questions' },
  { icon: Link2, label: 'Website pages', sub: '/menu, /catering' },
  { icon: FileText, label: 'Documents', sub: 'price-list.pdf' },
]
const OUTPUTS = [
  { icon: MessagesSquare, label: 'Website chat', sub: 'Answers and captures leads' },
  { icon: PhoneCall, label: 'AI calls', sub: 'Qualifies and books callbacks' },
  { icon: ListChecks, label: 'CRM notes', sub: 'Summary, mood, next step' },
]
const AI_POINTS = [
  { icon: MessagesSquare, title: 'Website chatbot', text: 'Answers around the clock, captures leads, hands over to live chat.' },
  { icon: PhoneCall, title: 'AI calling agents', text: 'Qualifies leads, books callbacks and records the outcome.' },
  { icon: Zap, title: 'Correct in one click', text: 'Fix any answer and it becomes part of the training.' },
  { icon: Users, title: 'Your team stays in control', text: 'Shared inbox; take over any conversation instantly.' },
]

function Node({ icon: Icon, label, sub, align }: { icon: typeof Bot; label: string; sub: string; align: 'left' | 'right' }) {
  return (
    <div className={cn('flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-3.5 py-3 backdrop-blur', align === 'right' && 'lg:flex-row-reverse lg:text-right')}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-indigo-200">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-white">{label}</span>
        <span className="block truncate text-xs text-white/45">{sub}</span>
      </span>
    </div>
  )
}

/** Sources flow into the AI and out to chat, calls and the CRM. */
function KnowledgeVisual() {
  return (
    <div className="relative grid grid-cols-1 items-center gap-6 lg:grid-cols-[1fr_auto_1fr] lg:gap-10" aria-hidden>
      <Stagger className="space-y-2.5" gap={0.1}>
        {SOURCES.map((s) => (
          <StaggerItem key={s.label}>
            <Node {...s} align="left" />
          </StaggerItem>
        ))}
      </Stagger>
      <div className="relative mx-auto flex size-40 items-center justify-center">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="absolute inset-0 rounded-full border border-indigo-400/30"
            animate={{ scale: [0.6, 1.25], opacity: [0.7, 0] }}
            transition={{ duration: 3.6, repeat: Infinity, delay: i * 1.2, ease: 'easeOut' }}
          />
        ))}
        <div className="absolute inset-6 rounded-full bg-[radial-gradient(closest-side,rgb(129_140_248/0.55),transparent)]" />
        <div className="relative flex size-20 flex-col items-center justify-center rounded-full border border-white/20 bg-gradient-to-br from-indigo-500 to-violet-600 shadow-[0_0_60px_-5px_rgb(129_140_248/0.8)]">
          <Bot className="size-7 text-white" />
          <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/80">Maya</span>
        </div>
        {/* Flow dots in and out (desktop). */}
        {[0, 1].map((side) => (
          <motion.span
            key={side}
            className="absolute top-1/2 hidden size-1.5 -translate-y-1/2 rounded-full bg-indigo-300 shadow-[0_0_10px_2px_rgb(165_180_252/0.8)] lg:block"
            style={{ left: side === 0 ? '-40px' : 'calc(100% + 8px)' }}
            animate={{ x: [0, 32], opacity: [0, 1, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, delay: side * 0.8, ease: 'easeInOut' }}
          />
        ))}
      </div>
      <Stagger className="space-y-2.5" gap={0.1}>
        {OUTPUTS.map((s) => (
          <StaggerItem key={s.label}>
            <Node {...s} align="right" />
          </StaggerItem>
        ))}
      </Stagger>
    </div>
  )
}

export function AiSection() {
  return (
    <section id="ai" aria-labelledby="ai-title" className="mk-ink relative scroll-mt-16 overflow-hidden px-4 py-24 sm:px-6 sm:py-32">
      <Aurora intensity={0.7} />
      <div className="relative mx-auto max-w-6xl">
        <SectionHeading
          id="ai-title"
          tone="dark"
          eyebrow="AI that works your leads"
          title={
            <>
              Teach it once, in plain words. <Accent tone="dark" wrap>It chats, calls and follows up.</Accent>
            </>
          }
          lead="Give your AI chatbot and calling agents your instructions, FAQs, web pages and documents. They answer only from what you taught them, capture the details you ask for, and hand over to your team when a person is needed."
        />
        <Reveal className="mt-16">
          <KnowledgeVisual />
        </Reveal>
        <Stagger className="mt-16 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {AI_POINTS.map(({ icon: Icon, title, text }) => (
            <StaggerItem key={title} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <Icon className="mb-4 size-5 text-indigo-300" aria-hidden />
              <h3 className="font-semibold text-white">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-white/55">{text}</p>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ compliance

const INDIA = ['TRAI DLT registration for calls (DLT-ready SMS coming soon)', '140 series for promotional calls, 160 for service calls', 'Legal calling hours', 'GST tax invoices with CGST/SGST or IGST', 'DPDP Act export and erasure']
const UAE = [
  'Email, lead forms, AI chatbot (Arabic replies), CRM and automation: live',
  'Opt-in consent and one-click unsubscribe (TDRA rules)',
  'PDPL (Federal Decree-Law 45/2021) consent, export and erasure',
  'AED wallet; invoices with your TRN under the reverse charge',
  'SMS and AI calls: coming soon, with TDRA and Cabinet Resolution 56/2024 rules built in',
]
const US = ['TCPA calling windows in the recipient’s time zone', 'Caller identification on every call', 'Press-9 opt-out on marketing calls', 'CAN-SPAM postal address and unsubscribe in email', '10DLC-ready SMS: coming soon', 'GDPR-style export and erasure']
const BASICS = [
  { icon: FileCheck2, title: 'Consent you can prove', text: 'Every opt-in stored with its wording, page, source and time.' },
  { icon: UserRoundCheck, title: 'Data rights', text: 'Export everything about a person, or erase them everywhere.' },
  { icon: KeyRound, title: 'Two-factor sign-in', text: 'Protect every account with an authenticator app.' },
  { icon: ShieldCheck, title: 'Audit log', text: 'Sensitive actions recorded with who did what, and when.' },
]

function RegionCard({ flag, title, items, icon: Icon }: { flag: string; title: string; items: string[]; icon: typeof Globe2 }) {
  return (
    <div className="relative overflow-hidden rounded-[1.75rem] border bg-card p-7 shadow-card sm:p-8">
      <div className="mk-grid-soft pointer-events-none absolute inset-0 opacity-50" aria-hidden />
      <div className="relative flex items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
          <Icon className="size-5" aria-hidden />
        </span>
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{flag}</div>
          <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
        </div>
      </div>
      <ul className="relative mt-6 space-y-3 text-[15px]">
        {items.map((it) => (
          <li key={it} className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            {it}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Compliance() {
  return (
    <Section id="trust" labelledBy="trust-title">
      <SectionHeading
        id="trust-title"
        eyebrow="Compliance and security"
        title={
          <>
            The rules are <Accent>built in</Accent>, not bolted on.
          </>
        }
        lead="Signalcraft checks consent, quiet hours and registrations before anything is sent, so your team can focus on the message."
      />
      <Stagger className="mt-16 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <StaggerItem>
          <RegionCard flag="India" title="Built for TRAI rules" items={INDIA} icon={ReceiptIndianRupee} />
        </StaggerItem>
        <StaggerItem>
          <RegionCard flag="United Arab Emirates" title="Ready for TDRA and PDPL" items={UAE} icon={Globe2} />
        </StaggerItem>
        <StaggerItem>
          <RegionCard flag="United States" title="Ready for TCPA and CAN-SPAM" items={US} icon={Globe2} />
        </StaggerItem>
      </Stagger>
      <Stagger className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {BASICS.map(({ icon: Icon, title, text }) => (
          <StaggerItem key={title} className="rounded-2xl border bg-card p-5 shadow-card">
            <Icon className="mb-4 size-5 text-primary" aria-hidden />
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{text}</p>
          </StaggerItem>
        ))}
      </Stagger>
    </Section>
  )
}

// ------------------------------------------------------------------ pricing teaser

export function PricingTeaser() {
  const [currency, setCurrency] = useState<Currency>(guessCurrency)
  const q = usePublicPricing(currency)
  const d = q.data
  return (
    <Section id="pricing" labelledBy="pricing-title" className="bg-muted/40">
      <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[1fr_1.35fr]">
        <Reveal className="min-w-0">
          <SectionHeading
            id="pricing-title"
            align="left"
            eyebrow="Pricing"
            title={
              <>
                Pay for what you send. <Accent>Nothing else.</Accent>
              </>
            }
            lead="Top up a prepaid wallet and every channel draws from it. No contracts, no per-contact pricing. Starter has no monthly fee; Pro lowers every rate."
          />
          <div className="mt-6 flex items-center gap-3 text-sm text-muted-foreground">
            <Wallet className="size-4 text-primary" aria-hidden /> One wallet for email, calls and AI replies (SMS coming soon)
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <CurrencyToggle value={currency} onChange={setCurrency} />
            <Link to="/pricing" className="group inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
              Full pricing and cost calculator <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          </div>
        </Reveal>
        <div className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2">
          {d ? d.plans.map((p) => <PlanCard key={p.key} plan={p} currency={currency} gst={!!d.gst_rate} compact />) : [0, 1].map((i) => <PlanCardSkeleton key={i} />)}
        </div>
      </div>
      {q.isError && <p className="mt-6 text-center text-sm text-muted-foreground">Prices couldn’t load right now. Sign up to see them in your workspace.</p>}
    </Section>
  )
}
