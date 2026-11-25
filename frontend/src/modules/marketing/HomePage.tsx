/**
 * The public home page. Everything shown exists in the product; prices are read live from
 * /public/pricing. No stock photos, customer logos or invented numbers.
 */
import { CTA } from './components/CTA'
import { FAQ } from './components/FAQ'
import { Accent } from './components/GradientText'
import { Reveal } from './components/Reveal'
import { Section, SectionHeading } from './components/Section'
import { Bento } from './home/Bento'
import { Hero } from './home/Hero'
import { LeadFlow } from './home/LeadFlow'
import { AiSection, Compliance, PricingTeaser } from './home/Sections'
import { usePageMeta } from './usePageMeta'

const FAQ_ITEMS = [
  {
    q: 'Do I need to connect providers before I can try it?',
    a: 'No. A new workspace runs in simulation mode: forms, chat, emails and calls all work and show up in your reports, without sending anything real. Switch to live sending when you are ready.',
  },
  {
    q: 'Do I need my own phone number for calls?',
    a: 'No. Signalcraft places calls from numbers it manages for each country, using the series Indian rules require for promotional and service calls. There is nothing to rent or register. Calls to the UAE are coming soon: UAE rules require calling from your own licensed UAE number.',
  },
  {
    q: 'How does the AI learn about my business?',
    a: 'You write instructions in plain words, add FAQs, paste website links or upload documents. The chatbot and calling agents answer only from what you gave them, and hand over to a person when they are not sure. You can correct any answer in one click.',
  },
  {
    q: 'How does billing work?',
    a: 'You add credit to a prepaid wallet and pay only for what you send, priced per email, call minute and AI reply (SMS is coming soon). Starter has no monthly fee. Pro adds a monthly fee and takes a discount off all usage. Indian customers get GST tax invoices for every top-up; UAE customers (VAT-registered, with a TRN) pay in AED and get reverse-charge invoices with no UAE VAT.',
  },
  {
    q: 'Is my customers’ data safe?',
    a: 'Consent is recorded with evidence for every contact, people can be exported or erased on request (DPDP Act, the UAE PDPL and GDPR), sign-in supports two-factor authentication, and every sensitive action is written to an audit log.',
  },
  {
    q: 'Can my team work together?',
    a: 'Yes. Invite teammates with roles, keep separate applications for each brand, assign leads automatically and answer website chats together from a shared inbox.',
  },
]

export function HomePage() {
  usePageMeta(
    'Signalcraft · Lead forms, AI chatbot, email, AI calls and CRM',
    'Capture every lead and follow up on every channel. Lead forms, an AI chatbot, email and AI voice calls, a CRM and automation in one workspace (SMS coming soon), with compliance for India, the UAE and the US built in.',
  )
  return (
    <>
      <Hero />
      <Bento />
      <LeadFlow />
      <AiSection />
      <Compliance />
      <PricingTeaser />
      <Section id="faq" labelledBy="faq-title">
        <div className="mx-auto max-w-3xl">
          <SectionHeading
            id="faq-title"
            eyebrow="FAQ"
            title={
              <>
                Questions, <Accent>answered.</Accent>
              </>
            }
          />
          <Reveal className="mt-12">
            <FAQ items={FAQ_ITEMS} />
          </Reveal>
        </div>
      </Section>
      <CTA />
    </>
  )
}
