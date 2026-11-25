import type { ReactNode } from 'react'
import { Check, CheckCheck, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BentoCard } from '../components/BentoCard'
import { Accent } from '../components/GradientText'
import { Stagger, StaggerItem } from '../components/Reveal'
import { Section, SectionHeading } from '../components/Section'
import { PRODUCT_BY_SLUG, type ProductSlug } from '../products'

// ------------------------------------------------------------------ small card illustrations (theme-aware)

function Surface({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('w-full rounded-2xl border bg-background/70 p-3 shadow-sm backdrop-blur', className)}>{children}</div>
}

const chatVisual = (
  <Surface className="space-y-2 text-[13px]">
    <div className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-primary-foreground">Can you cater for 40 on Friday?</div>
    <div className="w-fit max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-1.5">Yes! Shall I book a tasting call for you?</div>
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="size-1.5 rounded-full bg-success" /> Answered from your FAQ · lead captured
    </div>
  </Surface>
)

const formVisual = (
  <Surface className="space-y-2">
    {['Priya Nair', 'priya@chaiandco.in'].map((v) => (
      <div key={v} className="flex h-8 items-center rounded-lg border bg-card px-2.5 text-xs">{v}</div>
    ))}
    <div className="flex h-8 items-center justify-center rounded-lg bg-primary text-xs font-medium text-primary-foreground transition group-hover:opacity-90">Request a demo</div>
  </Surface>
)

const emailVisual = (
  <Surface className="space-y-2.5">
    {[
      ['Delivered', 'w-[96%]'],
      ['Opened', 'w-[46%]'],
      ['Clicked', 'w-[14%]'],
    ].map(([l, w]) => (
      <div key={l} className="flex items-center gap-2 text-[11px]">
        <span className="w-14 text-muted-foreground">{l}</span>
        <div className="h-1.5 flex-1 rounded-full bg-muted">
          <div className={cn('h-full origin-left rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-transform duration-700 group-hover:scale-x-105', w)} />
        </div>
      </div>
    ))}
  </Surface>
)

const smsVisual = (
  <Surface className="space-y-2 text-[12px]">
    <div className="w-fit max-w-[90%] rounded-2xl rounded-bl-sm bg-muted px-3 py-1.5">Your table for 4 is confirmed for 8 pm.</div>
    <div className="flex flex-wrap gap-1.5">
      <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[10.5px] font-medium text-success-strong">
        <Check className="size-3" /> DLT template
      </span>
      <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-medium text-accent-foreground">
        <CheckCheck className="size-3" /> Delivered
      </span>
    </div>
  </Surface>
)

const voiceVisual = (
  <Surface className="flex h-[72px] items-center justify-center gap-[3px]">
    {Array.from({ length: 28 }, (_, i) => (
      <span
        key={i}
        className="w-[3px] rounded-full bg-gradient-to-t from-indigo-500 to-violet-400 transition-transform duration-500 group-hover:scale-y-125"
        style={{ height: `${14 + Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.35)) * 38}px` }}
      />
    ))}
  </Surface>
)

const crmVisual = (
  <Surface className="grid grid-cols-3 gap-1.5">
    {[
      ['New', ['Kite Labs']],
      ['Proposal', ['Chai & Co']],
      ['Won', ['Northwind']],
    ].map(([col, deals]) => (
      <div key={col as string} className="min-w-0 rounded-lg bg-muted/70 p-1.5">
        <div className="mb-1 truncate text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">{col}</div>
        {(deals as string[]).map((d) => (
          <div key={d} className={cn('truncate rounded-md border bg-card px-1.5 py-1 text-[10.5px] font-medium', col === 'Won' && 'border-success-border')}>
            {d}
          </div>
        ))}
      </div>
    ))}
  </Surface>
)

const automationVisual = (
  <Surface className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
    {['Form submitted', 'Wait 5 min', 'AI call'].map((s, i) => (
      <span key={s} className="flex items-center gap-1.5">
        <span className={cn('rounded-lg border px-2 py-1', i === 2 ? 'border-primary/30 bg-primary text-primary-foreground' : 'bg-card')}>{s}</span>
        {i < 2 && <span className="h-px w-3 bg-border" />}
      </span>
    ))}
  </Surface>
)

const analyticsVisual = (
  <Surface>
    <svg viewBox="0 0 200 60" className="h-[60px] w-full" aria-hidden>
      <defs>
        <linearGradient id="mk-bento-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#6366f1" stopOpacity="0.3" />
          <stop offset="1" stopColor="#6366f1" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0 50 C20 46 30 40 50 42 S80 30 100 32 S140 18 160 20 S190 8 200 6 L200 60 L0 60 Z" fill="url(#mk-bento-area)" />
      <path d="M0 50 C20 46 30 40 50 42 S80 30 100 32 S140 18 160 20 S190 8 200 6" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" />
    </svg>
  </Surface>
)

const aiVisual = (
  <Surface className="grid gap-2 text-[12.5px] sm:grid-cols-2">
    <div className="space-y-2">
      <div className="ml-auto w-fit rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-primary-foreground">Create a task to call Priya tomorrow</div>
      <div className="rounded-xl border bg-card p-2">
        <div className="flex items-center gap-1.5 font-medium">
          <ShieldCheck className="size-3.5 text-primary" /> Create task: Call Priya
        </div>
        <div className="mt-1.5 flex gap-1.5 text-[11px]">
          <span className="rounded-md bg-primary px-2 py-0.5 text-primary-foreground">Confirm</span>
          <span className="rounded-md border px-2 py-0.5">Edit</span>
        </div>
      </div>
    </div>
    <div className="rounded-xl border bg-card p-2 text-[11.5px]">
      <div className="font-medium"># sales · Daily performance report</div>
      <div className="mt-1 text-muted-foreground">Form submissions and chat leads vs yesterday, and the deals going cold</div>
      <div className="mt-1.5 flex gap-1.5">
        <span className="rounded bg-success-soft px-1.5 py-0.5 text-success-strong">Approve</span>
        <span className="rounded border px-1.5 py-0.5">Open in Signalcraft</span>
      </div>
    </div>
  </Surface>
)

const CARDS: { slug: ProductSlug; span: string; visual: ReactNode }[] = [
  { slug: 'chatbot', span: 'lg:col-span-4', visual: chatVisual },
  { slug: 'lead-forms', span: 'lg:col-span-2', visual: formVisual },
  { slug: 'email', span: 'lg:col-span-2', visual: emailVisual },
  { slug: 'sms', span: 'lg:col-span-2', visual: smsVisual },
  { slug: 'voice', span: 'lg:col-span-2', visual: voiceVisual },
  { slug: 'crm', span: 'lg:col-span-2', visual: crmVisual },
  { slug: 'automation', span: 'lg:col-span-2', visual: automationVisual },
  { slug: 'analytics', span: 'lg:col-span-2', visual: analyticsVisual },
  { slug: 'ai-team', span: 'sm:col-span-2 lg:col-span-6', visual: aiVisual },
]

export function Bento() {
  return (
    <Section id="products" labelledBy="bento-title">
      <SectionHeading
        id="bento-title"
        eyebrow="The platform"
        title={
          <>
            Nine tools. <Accent>One</Accent> workspace.
          </>
        }
        lead="Everything between “new lead” and “deal won”, sharing one contact record, one wallet and one timeline."
      />
      <Stagger className="mt-16 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6" gap={0.06}>
        {CARDS.map(({ slug, span, visual }) => {
          const p = PRODUCT_BY_SLUG[slug]
          return (
            <StaggerItem key={slug} className={cn('flex', span)}>
              <BentoCard to={`/products/${slug}`} icon={p.icon} title={p.name} text={p.line} visual={visual} soon={p.soon} className="w-full" />
            </StaggerItem>
          )
        })}
      </Stagger>
    </Section>
  )
}
