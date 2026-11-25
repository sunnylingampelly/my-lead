/**
 * /pricing — plans, comparison, rate card, cost calculator and billing FAQ. Every number is read from
 * GET /public/pricing (the same settings billing charges with); nothing here hard-codes a price.
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import { CalendarDays, Mail, Wallet } from 'lucide-react'
import { Aurora } from './components/Aurora'
import { CtaLink } from './components/Buttons'
import { CTA } from './components/CTA'
import { CurrencyToggle } from './components/CurrencyToggle'
import { FAQ } from './components/FAQ'
import { Accent } from './components/GradientText'
import { PlanCard, PlanCardSkeleton } from './components/PlanCard'
import { Reveal } from './components/Reveal'
import { Section, SectionHeading } from './components/Section'
import { Calculator } from './pricing-page/Calculator'
import { Comparison } from './pricing-page/Comparison'
import { RateCard } from './pricing-page/RateCard'
import { MARKET_LABEL, channelSoon, findPlan, guessCurrency, money, percent, usePublicPricing, type Currency } from './pricing'
import { usePageMeta } from './usePageMeta'

// TODO(sales-email): replace the placeholder with the real sales inbox before launch.
const SALES_EMAIL = 'sales@signalcraft.example'

const EASE = [0.22, 1, 0.36, 1] as const

const BILLING_FAQ = [
  {
    q: 'How does the wallet work?',
    a: 'You add credit to a prepaid wallet in your currency, and every email, call minute and AI reply is charged from it as you use it (SMS is coming soon). The Pro monthly fee is charged from the same wallet. There are no contracts and no per-contact fees.',
  },
  {
    q: 'Do I get a GST tax invoice?',
    a: 'Yes. In India every wallet top-up gets a GST tax invoice with your GSTIN, split into CGST and SGST or IGST depending on your state. GST is added when you top up.',
  },
  {
    q: 'How does billing work in the UAE?',
    a: 'UAE workspaces have a wallet in dirhams (AED). We currently sell to VAT-registered UAE businesses: add your Tax Registration Number (TRN) in billing. Each top-up gets an invoice showing your TRN with no UAE VAT charged, under the reverse charge (you account for the VAT).',
  },
  {
    q: 'What happens when my balance runs low?',
    a: 'Owners and admins are notified when the balance falls below the threshold you set in billing. If the wallet runs out, sending pauses (and AI replies stop) until you top up, so you are never charged more than you added.',
  },
  {
    q: 'Can I get a refund?',
    a: 'Wallet credit is used for usage and plan fees. If something was charged by mistake, contact us and we will put it right by crediting your wallet.',
  },
  {
    q: 'How do plan changes work?',
    a: 'Upgrading to Pro starts straight away: the monthly fee is charged from your wallet and the lower rates apply at once. Moving back to Starter takes effect at the end of the month you have paid for.',
  },
  {
    q: 'Can I try it before paying?',
    a: 'Yes. Every new workspace runs in simulation mode, so you can build forms, bots, campaigns and AI agents and see them work without sending anything real or spending credit.',
  },
]

export function PricingPage() {
  usePageMeta(
    'Pricing · Signalcraft',
    'Simple, usage-based pricing: a prepaid wallet with no monthly fee on Starter, or Pro for lower rates on every channel. See every rate and estimate your monthly cost.',
  )
  const [currency, setCurrency] = useState<Currency>(guessCurrency)
  const q = usePublicPricing(currency)
  const d = q.data
  const pro = findPlan(d, 'pro')
  const gst = currency === 'INR' && !!d?.gst_rate

  return (
    <>
      <section className="mk-ink relative overflow-hidden px-4 pb-20 pt-28 sm:px-6 sm:pb-28 sm:pt-36" aria-labelledby="pricing-title">
        <Aurora />
        <div className="relative mx-auto max-w-6xl">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease: EASE }} className="mx-auto max-w-3xl text-center">
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.18em] text-indigo-200/80">Pricing</p>
            <h1 id="pricing-title" className="text-balance text-[2.6rem] font-semibold leading-[1.03] tracking-[-0.04em] sm:text-6xl lg:text-7xl">
              Simple pricing. <Accent tone="dark" wrap>Pay for what you send.</Accent>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg text-white/65">
              Two parts, nothing hidden: an optional monthly plan, and a prepaid wallet that pays for what you use.
            </p>
            <div className="mt-8 flex justify-center">
              <CurrencyToggle value={currency} onChange={setCurrency} tone="dark" />
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.15, ease: EASE }}
            className="mx-auto mt-10 grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2"
          >
            <div className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm">
              <CalendarDays className="mt-0.5 size-5 shrink-0 text-indigo-300" aria-hidden />
              <div>
                <div className="font-semibold text-white">Monthly plan</div>
                <p className="mt-0.5 text-white/60">
                  Starter is free. Pro is {pro ? `${money(pro.price, currency)}/month${gst ? ' + GST' : ''}` : '…'} and takes {pro ? percent(pro.usage_discount) : '…'} off every rate.
                </p>
              </div>
            </div>
            <div className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm">
              <Wallet className="mt-0.5 size-5 shrink-0 text-indigo-300" aria-hidden />
              <div>
                <div className="font-semibold text-white">What you use</div>
                <p className="mt-0.5 text-white/60">Emails, call minutes and AI replies are charged from a prepaid wallet{gst ? `, with ${d?.gst_rate}% GST on top-ups` : ''}.</p>
              </div>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.3, ease: EASE }}
            className="mx-auto mt-14 grid max-w-4xl grid-cols-1 gap-6 md:grid-cols-2"
            data-testid="plan-cards"
          >
            {d ? d.plans.map((p) => <PlanCard key={p.key} plan={p} currency={currency} gst={gst} />) : [0, 1].map((i) => <PlanCardSkeleton key={i} />)}
          </motion.div>
          {currency === 'AED' && (
            <div className="mx-auto mt-8 max-w-4xl rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm text-white/65" data-testid="uae-pricing-note">
              <span className="font-semibold text-white">For the UAE:</span> prices exclude UAE VAT. We sell to VAT-registered businesses (your TRN is required) and invoice under the reverse charge, so you account for the VAT.
              {' SMS and AI voice calls to UAE numbers are coming soon; email, lead forms, the AI chatbot (with Arabic replies), CRM and automation are available today.'}
            </div>
          )}
          {q.isError && <p className="mt-6 text-center text-sm text-white/60">Prices couldn’t load right now. Please try again in a moment.</p>}
        </div>
      </section>

      <Section id="compare" labelledBy="compare-title">
        <SectionHeading id="compare-title" eyebrow="Compare" title={<>Starter or Pro, <Accent>side by side.</Accent></>} />
        <Reveal className="mx-auto mt-14 max-w-4xl">
          <Comparison data={d} currency={currency} />
        </Reveal>
      </Section>

      <Section id="rates" labelledBy="rates-title" className="bg-muted/40">
        <SectionHeading
          id="rates-title"
          eyebrow="Rate card"
          title={<>Every rate, <Accent>in the open.</Accent></>}
          lead={`Rates ${MARKET_LABEL[currency]}.${gst ? ' GST is added when you top up your wallet, with a tax invoice.' : ''}${
            d?.reverse_charge ? ' No UAE VAT is charged: you account for it under the reverse charge.' : ''
          } SMS is coming soon in every market.${channelSoon(d, 'voice') ? ' Calls to the UAE are coming soon too.' : ''}`}
        />
        <Reveal className="mx-auto mt-14 max-w-4xl">
          <RateCard data={d} currency={currency} />
        </Reveal>
      </Section>

      <Section id="calculator" labelledBy="calc-title">
        <SectionHeading
          id="calc-title"
          eyebrow="Cost calculator"
          title={<>What will a month <Accent>cost you?</Accent></>}
          lead="Move the sliders to match your volumes. We’ll show the cost on each plan and when Pro starts paying for itself."
        />
        <Reveal className="mt-14">
          <Calculator data={d} currency={currency} />
        </Reveal>
      </Section>

      <Section id="billing-faq" labelledBy="bfaq-title" className="bg-muted/40">
        <div className="mx-auto max-w-3xl">
          <SectionHeading id="bfaq-title" eyebrow="Billing FAQ" title={<>Billing, <Accent>explained.</Accent></>} />
          <Reveal className="mt-12">
            <FAQ items={BILLING_FAQ} />
          </Reveal>
        </div>
      </Section>

      <section className="px-4 pt-20 sm:px-6" aria-labelledby="talk-title">
        <Reveal className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 rounded-[1.75rem] border bg-card p-8 shadow-card sm:p-10 md:flex-row md:items-center">
          <div>
            <h2 id="talk-title" className="text-2xl font-semibold tracking-tight">Sending at high volume, or need something special?</h2>
            <p className="mt-2 max-w-xl text-muted-foreground">Tell us about your volumes and channels and we’ll help you set up the right plan.</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <CtaLink to={`mailto:${SALES_EMAIL}?subject=Signalcraft%20pricing`} variant="outline" className="gap-2">
              <Mail className="size-4" aria-hidden /> Talk to us
            </CtaLink>
            <CtaLink to="/register" arrow>
              Create account
            </CtaLink>
          </div>
        </Reveal>
      </section>

      <CTA title={<>Start free. <Accent tone="dark">Upgrade when it pays.</Accent></>} />
    </>
  )
}
