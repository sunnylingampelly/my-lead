/**
 * /products/:slug — one data-driven template for all nine products (content in products.ts, demos in
 * demos/). An unknown slug shows a friendly not-found page inside the marketing layout.
 */
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, Clock, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Aurora } from './components/Aurora'
import { CtaLink } from './components/Buttons'
import { CTA } from './components/CTA'
import { FAQ } from './components/FAQ'
import { Accent } from './components/GradientText'
import { MiniVisual } from './components/MiniVisual'
import { ProductPricing } from './components/ProductPricing'
import { Reveal, Stagger, StaggerItem } from './components/Reveal'
import { Section, SectionHeading } from './components/Section'
import { DEMOS } from './demos'
import { findProduct, PRODUCT_BY_SLUG, PRODUCTS, type Product } from './products'
import { usePageMeta } from './usePageMeta'

const EASE = [0.22, 1, 0.36, 1] as const

function ProductHero({ p }: { p: Product }) {
  const Demo = DEMOS[p.slug]
  const [before, accent, after] = p.hero.title
  return (
    <section className="mk-ink relative overflow-hidden px-4 pb-20 pt-[6.5rem] sm:px-6 sm:pb-28 sm:pt-[7.5rem]" aria-labelledby="product-title">
      <Aurora />
      <div className="relative mx-auto max-w-6xl">
        <nav aria-label="Breadcrumb" className="mb-10 flex items-center gap-1.5 text-sm text-white/45">
          <Link to="/" className="hover:text-white">Home</Link>
          <ChevronRight className="size-3.5" aria-hidden />
          <span>Products</span>
          <ChevronRight className="size-3.5" aria-hidden />
          <span className="text-white/80" aria-current="page">{p.name}</span>
        </nav>
        <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-[1fr_1.05fr]">
          <motion.div initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.09 } } }} className="min-w-0">
            <motion.p variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }} className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1 pl-1 pr-3 text-[13px] font-medium text-white/75">
              <span className="flex size-6 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600">
                <p.icon className="size-3.5 text-white" aria-hidden />
              </span>
              {p.hero.eyebrow}
            </motion.p>
            {p.soon && (
              <motion.p
                variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
                className="mb-5 ml-2 inline-flex items-center gap-1.5 rounded-full border border-amber-300/40 bg-amber-400/15 px-3 py-1 text-[13px] font-semibold uppercase tracking-wide text-amber-200"
                data-testid="product-coming-soon"
              >
                <Clock className="size-3.5" aria-hidden /> Coming soon
              </motion.p>
            )}
            <motion.h1
              id="product-title"
              variants={{ hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0, transition: { duration: 0.8, ease: EASE } } }}
              className="text-balance text-[2.5rem] font-semibold leading-[1.04] tracking-[-0.04em] sm:text-[3.4rem] xl:text-[3.75rem]"
            >
              {before}
              <Accent tone="dark">{accent}</Accent>
              {after}
            </motion.h1>
            <motion.p variants={{ hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: { duration: 0.8, ease: EASE } } }} className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-white/65">
              {p.hero.subhead}
            </motion.p>
            <motion.div variants={{ hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0 } }} className="mt-9 flex flex-col gap-3 sm:flex-row">
              {p.soon ? (
                <>
                  <CtaLink to="/products/email" variant="white" arrow>
                    See what's live: email
                  </CtaLink>
                  <CtaLink to="/products/voice" variant="ghost-dark">
                    AI voice calls
                  </CtaLink>
                </>
              ) : (
                <>
                  <CtaLink to="/register" variant="white" arrow>
                    Start free
                  </CtaLink>
                  <CtaLink to="/pricing" variant="ghost-dark">
                    See pricing
                  </CtaLink>
                </>
              )}
            </motion.div>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 30, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 1, delay: 0.25, ease: EASE }} className="relative min-w-0">
            <div className="pointer-events-none absolute -inset-8 rounded-[3rem] bg-[radial-gradient(closest-side,rgb(99_102_241/0.35),transparent)] blur-2xl" aria-hidden />
            <Demo className="relative" />
          </motion.div>
        </div>
      </div>
    </section>
  )
}

function Features({ p }: { p: Product }) {
  return (
    <Section labelledBy="features-title">
      <SectionHeading id="features-title" eyebrow="What you get" title={<>Built for the way <Accent>you sell.</Accent></>} />
      <div className="mt-20 space-y-24 sm:space-y-28">
        {p.features.map((f, i) => (
          <div key={f.title} className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
            <Reveal className={cn('min-w-0', i % 2 === 1 && 'lg:order-2')}>
              <span className="text-sm font-semibold tabular-nums text-primary">0{i + 1}</span>
              <h3 className="mt-3 text-balance text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">{f.title}</h3>
              <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{f.text}</p>
              <ul className="mt-6 space-y-2.5">
                {f.bullets.map((b) => (
                  <li key={b} className="flex gap-2.5 text-[15px]">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden /> {b}
                  </li>
                ))}
              </ul>
            </Reveal>
            <Reveal delay={0.1} className={cn('min-w-0', i % 2 === 1 && 'lg:order-1')}>
              <MiniVisual spec={f.visual} />
            </Reveal>
          </div>
        ))}
      </div>
    </Section>
  )
}

function WorksWith({ p }: { p: Product }) {
  return (
    <Section labelledBy="related-title" className="bg-muted/40">
      <SectionHeading id="related-title" eyebrow="One workspace" title={<>Works with the rest of <Accent>Signalcraft.</Accent></>} lead="One contact record, one wallet and one timeline, so every tool knows what the others did." />
      <Stagger className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-3">
        {p.related.map((r) => {
          const other = PRODUCT_BY_SLUG[r.slug]
          return (
            <StaggerItem key={r.slug} className="flex">
              <Link to={`/products/${r.slug}`} className="group flex w-full flex-col rounded-3xl border bg-card p-6 shadow-card transition duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-[0_24px_60px_-24px_rgb(79_70_229/0.35)]">
                <div className="flex items-center justify-between">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                    <other.icon className="size-5" aria-hidden />
                  </span>
                  <ArrowUpRight className="size-5 text-muted-foreground transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
                </div>
                <h3 className="mt-5 font-semibold">{p.name} + {other.name}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{r.text}</p>
              </Link>
            </StaggerItem>
          )
        })}
      </Stagger>
    </Section>
  )
}

function UseCases({ p }: { p: Product }) {
  const [active, setActive] = useState(0)
  const uc = p.useCases[active]
  return (
    <Section labelledBy="usecases-title">
      <SectionHeading id="usecases-title" eyebrow="Use cases" title={<>How teams <Accent>use it.</Accent></>} lead="A few common ways businesses put it to work." />
      <Reveal className="mx-auto mt-12 max-w-4xl">
        <div role="tablist" aria-label="Industries" className="mk-no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:justify-center sm:px-0">
          {p.useCases.map((u, i) => (
            <button
              key={u.industry}
              role="tab"
              type="button"
              id={`uc-tab-${i}`}
              aria-selected={i === active}
              aria-controls="uc-panel"
              onClick={() => setActive(i)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault()
                  const n = (active + (e.key === 'ArrowRight' ? 1 : -1) + p.useCases.length) % p.useCases.length
                  setActive(n)
                  document.getElementById(`uc-tab-${n}`)?.focus()
                }
              }}
              tabIndex={i === active ? 0 : -1}
              className={cn('relative inline-flex shrink-0 items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors', i === active ? 'border-transparent text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground')}
            >
              {i === active && <motion.span layoutId="uc-pill" className="absolute inset-0 rounded-full bg-primary" transition={{ type: 'spring', stiffness: 400, damping: 34 }} />}
              <u.icon className="relative size-4" aria-hidden />
              <span className="relative">{u.industry}</span>
            </button>
          ))}
        </div>
        <div id="uc-panel" role="tabpanel" aria-labelledby={`uc-tab-${active}`} className="relative mt-6 min-h-[180px] overflow-hidden rounded-[1.75rem] border bg-gradient-to-br from-accent/80 via-card to-card p-8 shadow-card sm:p-10">
          <div className="mk-grid-soft pointer-events-none absolute inset-0 opacity-50" aria-hidden />
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={active} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3, ease: EASE }} className="relative flex flex-col gap-5 sm:flex-row sm:items-start">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/25">
                <uc.icon className="size-6" aria-hidden />
              </span>
              <div>
                <h3 className="text-xl font-semibold tracking-tight">{uc.industry}</h3>
                <p className="mt-2 text-lg leading-relaxed text-muted-foreground">{uc.text}</p>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </Reveal>
    </Section>
  )
}

function ComplianceAndPricing({ p }: { p: Product }) {
  return (
    <Section labelledBy="pricing-snippet-title" className="bg-muted/40">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
        <div className="min-w-0">
          <SectionHeading align="left" eyebrow="Compliance" title={<>Safe to use <Accent>at scale.</Accent></>} />
          <Stagger as="ul" className="mt-10 space-y-4">
            {p.compliance.map((c) => (
              <StaggerItem as="li" key={c.title} className="flex gap-4 rounded-2xl border bg-card p-5 shadow-card">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-success-soft text-success-strong">
                  <ShieldCheck className="size-4" aria-hidden />
                </span>
                <div>
                  <h3 className="font-semibold">{c.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{c.text}</p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
        <div className="min-w-0">
          <SectionHeading align="left" id="pricing-snippet-title" eyebrow="Pricing" title={<>Live rates, <Accent>no surprises.</Accent></>} />
          <Reveal className="mt-10">
            <ProductPricing product={p} />
          </Reveal>
        </div>
      </div>
    </Section>
  )
}

function PrevNext({ p }: { p: Product }) {
  const i = PRODUCTS.findIndex((x) => x.slug === p.slug)
  const prev = PRODUCTS[(i - 1 + PRODUCTS.length) % PRODUCTS.length]
  const next = PRODUCTS[(i + 1) % PRODUCTS.length]
  return (
    <nav aria-label="More products" className="mx-auto grid max-w-6xl grid-cols-2 gap-4 px-4 sm:px-6">
      <Link to={`/products/${prev.slug}`} className="group rounded-2xl border bg-card p-5 transition hover:border-primary/40">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ArrowLeft className="size-3.5 transition group-hover:-translate-x-0.5" aria-hidden /> Previous
        </span>
        <span className="mt-1 block truncate font-semibold">{prev.name}</span>
      </Link>
      <Link to={`/products/${next.slug}`} className="group rounded-2xl border bg-card p-5 text-right transition hover:border-primary/40">
        <span className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
          Next <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" aria-hidden />
        </span>
        <span className="mt-1 block truncate font-semibold">{next.name}</span>
      </Link>
    </nav>
  )
}

function ProductNotFound() {
  usePageMeta('Product not found · Signalcraft', 'This product page does not exist. Explore the nine Signalcraft products.')
  return (
    <section className="mk-ink relative overflow-hidden px-4 pb-28 pt-44 sm:px-6 sm:pb-36 sm:pt-52" aria-labelledby="nf-title">
      <Aurora />
      <div className="relative mx-auto max-w-3xl text-center">
        <p className="font-serif text-7xl italic text-indigo-200/80">404</p>
        <h1 id="nf-title" className="mt-4 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">We couldn’t find that product.</h1>
        <p className="mt-4 text-lg text-white/60">It may have moved. Here’s everything Signalcraft does:</p>
        <ul className="mt-10 grid grid-cols-1 gap-2 text-left sm:grid-cols-2">
          {PRODUCTS.map((p) => (
            <li key={p.slug}>
              <Link to={`/products/${p.slug}`} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 transition hover:bg-white/[0.07]">
                <p.icon className="size-4 text-indigo-300" aria-hidden />
                <span className="text-sm font-medium">{p.name}</span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-10">
          <CtaLink to="/" variant="white" arrow>
            Back to home
          </CtaLink>
        </div>
      </div>
    </section>
  )
}

function ProductContent({ p }: { p: Product }) {
  usePageMeta(p.meta.title, p.meta.description)
  return (
    <>
      <ProductHero p={p} />
      <Features p={p} />
      <WorksWith p={p} />
      <UseCases p={p} />
      <ComplianceAndPricing p={p} />
      <Section labelledBy="pfaq-title">
        <div className="mx-auto max-w-3xl">
          <SectionHeading id="pfaq-title" eyebrow="FAQ" title={<>{p.name}, <Accent>answered.</Accent></>} />
          <Reveal className="mt-12">
            <FAQ items={p.faq} />
          </Reveal>
        </div>
      </Section>
      <PrevNext p={p} />
      {p.soon ? (
        <CTA
          title={
            <>
              {p.name} is <Accent tone="dark">coming soon.</Accent>
            </>
          }
          lead="Until it opens, capture leads with forms and the AI chatbot, and follow up by email and AI voice calls. All of them are available today."
        />
      ) : (
        <CTA />
      )}
    </>
  )
}

export function ProductPage() {
  const { slug } = useParams()
  const p = findProduct(slug)
  // Keyed by slug so state (use-case tab, FAQ) resets when moving between products.
  return p ? <ProductContent key={p.slug} p={p} /> : <ProductNotFound />
}
