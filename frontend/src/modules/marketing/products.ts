/**
 * The nine Signalcraft products, as shown on the marketing site: menu entries, home bento cards and the
 * content of each /products/:slug page. Everything described here exists in the product. Prices are
 * never written here; the pricing snippet names the rate and limit keys to read from /public/pricing.
 */
import {
  BarChart3,
  Bot,
  Briefcase,
  Building2,
  ClipboardList,
  GraduationCap,
  Handshake,
  Mail,
  MessageSquare,
  PhoneCall,
  ShoppingBag,
  Sparkles,
  Stethoscope,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { FaqItem } from './components/FAQ'
import type { LimitKey, RateKey } from './pricing'

export type ProductSlug = 'lead-forms' | 'chatbot' | 'email' | 'sms' | 'voice' | 'crm' | 'automation' | 'analytics' | 'ai-team'

export type MiniVisual =
  | { kind: 'chips'; items: string[] }
  | { kind: 'checks'; items: string[] }
  | { kind: 'steps'; items: string[] }
  | { kind: 'bars'; items: { label: string; value: number }[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'chat'; lines: { who: 'them' | 'us'; text: string }[]; tag?: string }

export interface Feature {
  title: string
  text: string
  bullets: string[]
  visual: MiniVisual
}

export interface UseCase {
  industry: string
  icon: LucideIcon
  text: string
}

export interface Product {
  slug: ProductSlug
  name: string
  /** One line for the menu, footer and cards. */
  line: string
  icon: LucideIcon
  /** Not available yet: shown with a "Coming soon" badge, no live price and no sign-up pitch. */
  soon?: boolean
  meta: { title: string; description: string }
  hero: { eyebrow: string; title: [string, string, string?]; subhead: string }
  features: Feature[]
  related: { slug: ProductSlug; text: string }[]
  useCases: UseCase[]
  compliance: { title: string; text: string }[]
  pricing: { rates?: { key: RateKey; label: string; unit: string }[]; limits?: { key: LimitKey; label: string }[]; note: string }
  faq: FaqItem[]
}

const RE: Pick<UseCase, 'industry' | 'icon'> = { industry: 'Real estate', icon: Building2 }
const EDU: Pick<UseCase, 'industry' | 'icon'> = { industry: 'Education', icon: GraduationCap }
const D2C: Pick<UseCase, 'industry' | 'icon'> = { industry: 'D2C brands', icon: ShoppingBag }
const CLINIC: Pick<UseCase, 'industry' | 'icon'> = { industry: 'Clinics', icon: Stethoscope }
const AGENCY: Pick<UseCase, 'industry' | 'icon'> = { industry: 'Agencies', icon: Briefcase }

export const PRODUCTS: Product[] = [
  {
    slug: 'lead-forms',
    name: 'Lead forms',
    line: 'Inline, popup, slide-in or hosted forms that land in your CRM.',
    icon: ClipboardList,
    meta: {
      title: 'Lead forms · Signalcraft',
      description: 'Build inline, popup, slide-in and hosted lead forms with UTM capture, spam protection and consent records. Every submission lands in your contacts and CRM.',
    },
    hero: {
      eyebrow: 'Lead forms',
      title: ['Forms that turn visitors into ', 'leads you can call', ' in minutes.'],
      subhead:
        'Design a form, paste one line of code, and every submission arrives in your contacts with its source page, UTM tags and consent, ready for a follow-up workflow.',
    },
    features: [
      {
        title: 'Four ways to show up',
        text: 'Embed a form in a page, open it as a popup on scroll, delay or exit intent, slide it in from the corner, or share a hosted link in ads and bios.',
        bullets: ['Shown once per visitor, never on every page view', 'Matches your brand colours and fonts', 'One snippet for every form on the site'],
        visual: { kind: 'chips', items: ['Inline', 'Popup', 'Slide-in', 'Hosted link', 'Exit intent', 'Scroll 50%'] },
      },
      {
        title: 'Know where every lead came from',
        text: 'Hidden fields capture UTM tags and the page a visitor was on, so your reports show which campaign, ad or post brought each lead in.',
        bullets: ['UTM source, medium and campaign', 'Landing page and referrer', 'Works with any ad platform link'],
        visual: { kind: 'code', lines: ['utm_source   = instagram', 'utm_campaign = diwali_offer', 'page         = /menu/catering', 'consent      = ✓ recorded 21:02'] },
      },
      {
        title: 'Clean data, no bots',
        text: 'Spam protection, allowed domains and double opt-in keep junk out of your list, and every submission is checked before it becomes a contact.',
        bullets: ['Spam and bot filtering', 'Only runs on the domains you allow', 'Double opt-in when you need proof'],
        visual: { kind: 'checks', items: ['Spam check passed', 'Domain allowed', 'Email confirmed (double opt-in)', 'Consent stored with wording'] },
      },
      {
        title: 'Straight into a follow-up',
        text: 'A submission can create a contact, open a deal, assign an owner and start a workflow, so nobody has to copy leads out of an inbox.',
        bullets: ['Round-robin owner assignment', 'Instant welcome email or text', 'Score points for high-intent answers'],
        visual: { kind: 'steps', items: ['Form submitted', 'Owner assigned', 'Welcome email', 'Call task'] },
      },
    ],
    related: [
      { slug: 'crm', text: 'Each submission becomes a contact and, if you like, a deal with an owner.' },
      { slug: 'automation', text: 'Start a journey the moment a form is submitted.' },
      { slug: 'voice', text: 'Have an AI agent call new leads while they are still interested.' },
    ],
    useCases: [
      { ...RE, text: 'A site-visit form on each project page, with the project captured in a hidden field and the lead routed to that site’s sales team.' },
      { ...EDU, text: 'An admissions enquiry form with course and city fields, feeding a counsellor pipeline and a brochure email.' },
      { ...D2C, text: 'An exit-intent popup that trades a first-order discount for an email address, with double opt-in for marketing.' },
      { ...CLINIC, text: 'A hosted appointment-request link for Instagram and Google profiles, with a confirmation text sent straight away.' },
      { ...AGENCY, text: 'Separate forms and branding for every client, each in its own application, with reports per campaign.' },
    ],
    compliance: [
      { title: 'Consent with evidence', text: 'Each opt-in is stored with the exact wording, page, time and source, so you can prove it later.' },
      { title: 'Double opt-in', text: 'Ask people to confirm their email before they receive marketing, where your market expects it.' },
      { title: 'Data rights', text: 'Leads can be exported or erased on request under the DPDP Act, the UAE PDPL and GDPR.' },
    ],
    pricing: {
      limits: [{ key: 'lead_forms', label: 'Lead forms' }, { key: 'contacts', label: 'Contacts' }],
      note: 'Lead forms are free to use. There is no charge per submission.',
    },
    faq: [
      { q: 'Do I need a developer to add a form?', a: 'No. Copy one line of code into your site (or your website builder’s custom code box) and every form you publish appears where you choose. Hosted forms need no code at all.' },
      { q: 'Can a form create a deal in the CRM?', a: 'Yes. A submission can create or update the contact, open a deal in a pipeline, assign an owner round-robin and start a workflow.' },
      { q: 'How do you stop spam submissions?', a: 'Forms run only on the domains you allow, submissions are checked for bots and spam, and you can require double opt-in for email marketing.' },
      { q: 'Is there a limit on submissions?', a: 'No. Starter includes a set number of forms and Pro has unlimited forms; submissions themselves are not charged.' },
    ],
  },
  {
    slug: 'chatbot',
    name: 'AI chatbot & live chat',
    line: 'An AI assistant trained on your business, with a shared live inbox.',
    icon: Bot,
    meta: {
      title: 'AI chatbot & live chat · Signalcraft',
      description: 'A website chatbot trained on your pages, FAQs and documents. It answers, captures leads and hands over to your team in a shared live-chat inbox.',
    },
    hero: {
      eyebrow: 'AI chatbot & live chat',
      title: ['An assistant that knows your business ', 'and never sleeps.', ''],
      subhead:
        'Teach it with your website, FAQs and documents. It answers visitors day and night, captures their details, and hands over to your team the moment a person is needed.',
    },
    features: [
      {
        title: 'Trained in plain words',
        text: 'Write instructions the way you would brief a new hire, then add FAQs, website links and documents. The assistant answers only from what you gave it.',
        bullets: ['Website pages, FAQs and uploaded documents', 'Tone and rules in plain language', 'Correct any answer in one click'],
        visual: { kind: 'chips', items: ['menu.pdf', 'Delivery FAQ', '/catering', 'Price list', 'Return policy', 'Tone: warm'] },
      },
      {
        title: 'Captures the lead, not just the question',
        text: 'Ask for a name, email or phone number at the right moment. Captured details create a contact, tag the conversation and can start a workflow.',
        bullets: ['Collects the fields you choose', 'Creates or updates the contact', 'Summary and mood saved to the timeline'],
        visual: { kind: 'chat', lines: [{ who: 'them', text: 'Can you cater for 40 people on Friday?' }, { who: 'us', text: 'Yes! May I have your name and number so our team can confirm the menu?' }], tag: 'Lead captured' },
      },
      {
        title: 'A shared inbox for your team',
        text: 'Live chat lands in one inbox. Teammates can watch, take over any AI conversation instantly, and pass chats to each other.',
        bullets: ['Hand-over when the AI is unsure', 'Take over any chat in one click', 'Assign chats to agents'],
        visual: { kind: 'checks', items: ['Priya · waiting 12s → assigned to Arjun', 'Rahul · AI answering', 'Meera · resolved, summary saved'] },
      },
      {
        title: 'Speaks your visitors’ language',
        text: 'Reply in the language your visitor writes in, including Hindi and Arabic (shown right to left), and keep the same knowledge across every language.',
        bullets: ['English, Hindi, Arabic and more', 'Same answers, any language', 'Works on mobile and desktop'],
        visual: { kind: 'chat', lines: [{ who: 'them', text: 'क्या आप पुणे में डिलीवरी करते हैं?' }, { who: 'us', text: 'हाँ, पुणे में 2 दिनों में डिलीवरी होती है।' }] },
      },
    ],
    related: [
      { slug: 'crm', text: 'Chats are saved to the contact timeline, with a summary of what was asked.' },
      { slug: 'automation', text: 'Start a workflow when the bot captures a lead or a chat closes.' },
      { slug: 'voice', text: 'The same knowledge can power an AI agent that calls leads back.' },
    ],
    useCases: [
      { ...RE, text: 'Answer questions on price, possession dates and amenities at midnight, and book site visits for the sales team.' },
      { ...EDU, text: 'Explain courses, fees and eligibility, then capture the student’s details for a counsellor.' },
      { ...D2C, text: 'Handle delivery, returns and sizing questions, and pass order problems to a person.' },
      { ...CLINIC, text: 'Share timings, doctors and services, and collect appointment requests without giving medical advice.' },
      { ...AGENCY, text: 'Run a separate, branded assistant for each client from one account.' },
    ],
    compliance: [
      { title: 'Answers only from your sources', text: 'The assistant is told to stay within what you taught it and to hand over when unsure.' },
      { title: 'Consent when capturing details', text: 'Details collected in chat are stored with their source and time, like any other opt-in.' },
      { title: 'Transcripts you control', text: 'Conversations can be exported or erased with the contact on request.' },
    ],
    pricing: {
      rates: [{ key: 'chat_reply', label: 'AI reply', unit: 'per AI reply' }],
      limits: [{ key: 'chatbots', label: 'Website chatbots' }, { key: 'chat_seats', label: 'Live-chat agents' }],
      note: 'Live chat between your team and visitors is free. You pay only for replies the AI writes.',
    },
    faq: [
      { q: 'Will the bot make things up?', a: 'It is instructed to answer only from the instructions, FAQs, pages and documents you provide, and to hand over to a person when it is not sure. You can correct any answer and the correction is used from then on.' },
      { q: 'Can my team take over a conversation?', a: 'Yes. Agents see live conversations in a shared inbox and can take over from the AI at any moment.' },
      { q: 'What does it cost?', a: 'Each reply the AI writes is charged from your wallet at the AI reply rate. Messages your team sends in live chat are free.' },
      { q: 'How do I add it to my site?', a: 'Paste one line of code. The chat widget then appears on every page that has the code.' },
    ],
  },
  {
    slug: 'email',
    name: 'Email campaigns',
    line: 'A visual editor, readiness checks and authenticated sending.',
    icon: Mail,
    meta: {
      title: 'Email campaigns · Signalcraft',
      description: 'Design emails in a visual editor, send to segments, and track opens and clicks. Readiness checks, domain authentication and suppression are built in.',
    },
    hero: {
      eyebrow: 'Email campaigns',
      title: ['Emails that ', 'reach the inbox', ' and get opened.'],
      subhead:
        'Design in a drag-and-drop editor, send to the right segment, and see who opened and clicked. Readiness checks catch problems before a single email goes out.',
    },
    features: [
      {
        title: 'A visual editor with templates',
        text: 'Drag in sections, images and buttons, save your brand as a template, and preview on desktop and mobile before you send.',
        bullets: ['Drag-and-drop blocks', 'Reusable templates', 'Personalisation with contact fields'],
        visual: { kind: 'chips', items: ['Header', 'Hero image', 'Text', 'Button', 'Products', 'Footer'] },
      },
      {
        title: 'Readiness checks before you send',
        text: 'Signalcraft checks your sender, domain, links, unsubscribe footer and audience before launch, and shows the cost up front.',
        bullets: ['Sender and domain verified', 'Unsubscribe link present', 'Cost shown before launch'],
        visual: { kind: 'checks', items: ['Sending domain authenticated', 'Unsubscribe footer present', 'All links valid', 'Suppressed contacts excluded'] },
      },
      {
        title: 'Authenticated sending',
        text: 'Verify your domain with SPF, DKIM and DMARC so mailbox providers know the email is really from you. Bounces and complaints are suppressed automatically.',
        bullets: ['SPF, DKIM and DMARC guidance', 'Automatic bounce suppression', 'One-click unsubscribe'],
        visual: { kind: 'code', lines: ['SPF    ✓  include:signalcraft', 'DKIM   ✓  sc1._domainkey', 'DMARC  ✓  p=quarantine', 'Status    Ready to send'] },
      },
      {
        title: 'Reports that lead to action',
        text: 'See deliveries, opens, clicks and unsubscribes for every campaign, and turn clickers into a segment for the next step.',
        bullets: ['Opens, clicks and bounces', 'Clicks for each link', 'Start a workflow on a click'],
        visual: { kind: 'bars', items: [{ label: 'Delivered', value: 0.98 }, { label: 'Opened', value: 0.46 }, { label: 'Clicked', value: 0.12 }] },
      },
    ],
    related: [
      { slug: 'automation', text: 'Send emails as steps in a journey, triggered by forms, chats or deals.' },
      { slug: 'crm', text: 'Opens and clicks appear on the contact timeline and can raise a lead score.' },
      { slug: 'analytics', text: 'Compare email with voice in one report, with spend.' },
    ],
    useCases: [
      { ...RE, text: 'Send new-launch announcements to past enquirers, segmented by budget and city.' },
      { ...EDU, text: 'Nurture applicants with deadlines, scholarship news and campus-visit invitations.' },
      { ...D2C, text: 'Festive offers, back-in-stock alerts and win-back emails to lapsed buyers.' },
      { ...CLINIC, text: 'Monthly health tips and check-up reminders to patients who opted in.' },
      { ...AGENCY, text: 'Run each client’s newsletter from their own application and sending domain.' },
    ],
    compliance: [
      { title: 'Unsubscribe on every email', text: 'Marketing emails carry an unsubscribe link, and opt-outs are honoured across every campaign.' },
      { title: 'Suppression list', text: 'Bounced, complained and unsubscribed addresses are excluded automatically.' },
      { title: 'Consent-aware sending', text: 'Campaigns go only to contacts with a valid email consent.' },
    ],
    pricing: {
      rates: [{ key: 'email', label: 'Email', unit: 'per email' }],
      note: 'Pay per email sent, from your prepaid wallet. Templates, the editor and reports are included.',
    },
    faq: [
      { q: 'Do I need my own domain?', a: 'To send at volume you should verify a domain you own. Signalcraft shows the SPF, DKIM and DMARC records to add, and checks them for you.' },
      { q: 'What happens to bounces and unsubscribes?', a: 'They are added to your suppression list automatically and excluded from future sends.' },
      { q: 'Can I test before sending?', a: 'Yes. Send a test to yourself, preview on mobile, and run the readiness checks. New workspaces also run in simulation mode, so nothing real is sent until you go live.' },
    ],
  },
  {
    slug: 'sms',
    name: 'SMS',
    line: 'Coming soon: DLT, 10DLC and UAE-ready texts with two-way replies.',
    icon: MessageSquare,
    soon: true,
    meta: {
      title: 'SMS (coming soon) · Signalcraft',
      description: 'SMS is coming soon to Signalcraft: promotional and transactional texts with TRAI DLT in India, 10DLC in the US and TDRA rules in the UAE, plus two-way replies. Email, AI calls, lead forms and the AI chatbot are available today.',
    },
    hero: {
      eyebrow: 'SMS · Coming soon',
      title: ['Texts that follow ', 'the rules', ', coming soon.'],
      subhead:
        'SMS is not available yet. When it opens, you will send promotional and transactional texts with DLT headers and templates in India, 10DLC registration in the US and TDRA rules in the UAE, with replies in a shared inbox. Until then, follow up with email and AI calls.',
    },
    features: [
      {
        title: 'DLT, 10DLC and TDRA, handled',
        text: 'You will register sender headers and templates for India’s DLT, or your brand and campaign for US 10DLC. In the UAE, promotional sender IDs will use the "AD-" prefix. Messages will be matched to an approved template before they are sent.',
        bullets: ['Header and template registration', 'Template matching before every send', 'Promotional and transactional routes'],
        visual: { kind: 'checks', items: ['Header approved', 'Template matched', 'Promotional route', 'Within legal hours'] },
      },
      {
        title: 'Know the cost of every message',
        text: 'Signalcraft will count message parts as you type, including Unicode for Hindi, Arabic and other scripts, and show the campaign cost before you launch.',
        bullets: ['Live character and part count', 'Unicode-aware for regional languages', 'Cost shown before launch'],
        visual: { kind: 'code', lines: ['Characters   142 / 160', 'Encoding     GSM-7', 'Parts        1', 'Recipients   3,200'] },
      },
      {
        title: 'Two-way conversations',
        text: 'Replies will arrive in a shared inbox, linked to the contact, so you can answer from the inbox or start a workflow when someone replies.',
        bullets: ['Shared SMS inbox', 'Replies on the contact timeline', 'STOP handled automatically'],
        visual: { kind: 'chat', lines: [{ who: 'us', text: 'Your table for 4 is confirmed for 8 pm. Reply C to change.' }, { who: 'them', text: 'C - can we make it 8:30?' }], tag: 'Coming soon' },
      },
    ],
    related: [
      { slug: 'email', text: 'Available today: reach the same audience and segments by email.' },
      { slug: 'voice', text: 'Available today: follow up interested leads with an AI call.' },
      { slug: 'automation', text: 'Build email and call journeys now; SMS steps arrive when SMS opens.' },
    ],
    useCases: [
      { ...RE, text: 'Site-visit reminders and launch-day offers to registered enquirers.' },
      { ...EDU, text: 'Admission deadlines, test schedules and fee reminders.' },
      { ...D2C, text: 'Order, shipping and delivery updates on the transactional route.' },
      { ...CLINIC, text: 'Appointment confirmations and reminders, with replies to reschedule.' },
      { ...AGENCY, text: 'Separate sender headers and templates for each client.' },
    ],
    compliance: [
      { title: 'TRAI DLT (coming soon)', text: 'Registered headers and templates, with promotional and transactional traffic kept apart.' },
      { title: 'US 10DLC and TCPA (coming soon)', text: 'Brand and campaign registration, and sends held to permitted local hours.' },
      { title: 'UAE TDRA (coming soon)', text: '"AD-" sender IDs for promotions, no promotional texts from 21:00 to 07:00 UAE time, and opt-out text on every promotion.' },
      { title: 'Opt-outs everywhere', text: 'STOP replies will be honoured automatically and suppressed across campaigns.' },
      { title: 'Quiet hours', text: 'Messages will be scheduled inside legal sending windows in the recipient’s time zone.' },
    ],
    pricing: {
      note: 'SMS is coming soon. Prices will be published here when it opens; nothing is charged for SMS today.',
    },
    faq: [
      { q: 'When can I send SMS?', a: 'SMS is coming soon and is not available in any market yet. Email, AI voice calls, lead forms, the AI chatbot, CRM and automation are available today.' },
      { q: 'Will I need DLT registration to send in India?', a: 'Yes, Indian regulations require registered sender headers and templates. When SMS opens, Signalcraft will guide you through registration and check every message against your approved templates.' },
      { q: 'Will people be able to reply?', a: 'Yes. Replies will arrive in the SMS inbox on the contact’s record, and you will be able to start a workflow when someone replies.' },
      { q: 'What is a message part?', a: 'A standard text holds 160 characters; Unicode text (for example Hindi or Arabic) holds 70. Longer messages are split into parts, and each part is charged.' },
    ],
  },
  {
    slug: 'voice',
    name: 'Voice & AI calls',
    line: 'Recorded calls, text-to-speech, or an AI agent that talks.',
    icon: PhoneCall,
    meta: {
      title: 'Voice & AI calling agents · Signalcraft',
      description: 'Call leads with recorded messages, text-to-speech or a trained AI agent that holds a real conversation, from numbers Signalcraft manages. No numbers to rent.',
    },
    hero: {
      eyebrow: 'Voice & AI calls',
      title: ['AI agents that ', 'call, qualify', ' and book the next step.'],
      subhead:
        'Run recorded or text-to-speech campaigns, or let a trained AI agent hold a real conversation. Calls come from numbers Signalcraft manages, so there is nothing to rent.',
    },
    features: [
      {
        title: 'Three kinds of call',
        text: 'Play a recorded message, read a script with text-to-speech, or hand the call to an AI agent that listens and replies in real time.',
        bullets: ['Recorded audio', 'Text-to-speech in seven languages', 'Conversational AI agents'],
        visual: { kind: 'chips', items: ['Recorded', 'Text-to-speech', 'AI agent', 'English', 'Hindi', 'Press 9 to opt out'] },
      },
      {
        title: 'An agent you train like a teammate',
        text: 'Give it a goal, instructions, FAQs and the details to collect. It qualifies the lead, books a callback and knows when to stop.',
        bullets: ['Goal and questions in plain words', 'Collects interest, budget, callback time', 'Ends politely on request'],
        visual: { kind: 'chat', lines: [{ who: 'us', text: 'Hi Priya, this is Maya from Chai & Co. Is this a good time?' }, { who: 'them', text: 'Yes, I asked about catering for our office.' }], tag: 'Live transcript' },
      },
      {
        title: 'Every call becomes data',
        text: 'Each call is recorded and summarised, with the outcome, mood and next step written to the contact. Callbacks become CRM tasks.',
        bullets: ['Recording and transcript', 'Summary, interest and sentiment', 'Callback tasks created automatically'],
        visual: { kind: 'checks', items: ['Outcome: Interested', 'Callback: Thu 11:00', 'Task created for Arjun', 'Summary saved'] },
      },
      {
        title: 'No numbers to rent',
        text: 'Signalcraft places calls from numbers it manages in each country, using the series Indian rules require for promotional and service calls.',
        bullets: ['140 series for promotional calls', '160 series for service calls', 'Caller ID handled for you'],
        visual: { kind: 'steps', items: ['Campaign', 'Rules check', 'Managed number', 'Call placed'] },
      },
    ],
    related: [
      { slug: 'lead-forms', text: 'Call new form leads within minutes, while they still remember you.' },
      { slug: 'crm', text: 'Outcomes, summaries and callbacks land on the deal and contact.' },
      { slug: 'automation', text: 'Branch a journey on whether the call was answered or went to voicemail.' },
    ],
    useCases: [
      { ...RE, text: 'Call every new enquiry within minutes to confirm budget and book a site visit.' },
      { ...EDU, text: 'Reach applicants who started but did not finish, and book a counsellor call.' },
      { ...D2C, text: 'Confirm cash-on-delivery orders before dispatch with a short automated call.' },
      { ...CLINIC, text: 'Appointment reminders with an easy way to confirm or reschedule.' },
      { ...AGENCY, text: 'Run qualification calls for clients’ ad campaigns, with outcomes in their CRM.' },
    ],
    compliance: [
      { title: '140 and 160 series', text: 'Promotional calls use the 140 series and service calls the 160 series, as TRAI requires.' },
      { title: 'Calling windows', text: 'Calls are held to legal hours in India and TCPA windows in the recipient’s US time zone.' },
      { title: 'UAE: coming soon', text: 'UAE rules (Cabinet Resolution 56/2024) require calls from your own licensed UAE number, which isn’t supported yet. The rules are built in: weekdays 09:00 to 18:00, a recording notice, no calls after a refusal or to DNCR numbers.' },
      { title: 'Opt-out on every call', text: 'Press 9 to opt out, or ask the AI agent to stop calling; both are honoured everywhere.' },
      { title: 'Do-not-call checks', text: 'Opted-out and do-not-call contacts are skipped before a campaign starts.' },
    ],
    pricing: {
      rates: [
        { key: 'voice_minute', label: 'Recorded or text-to-speech call', unit: 'per started minute' },
        { key: 'voice_ai_minute', label: 'AI agent call', unit: 'per started minute' },
      ],
      limits: [{ key: 'voice_agents', label: 'AI calling agents' }],
      note: 'Pay per started minute of connected call time. Numbers, recording and summaries are included.',
    },
    faq: [
      { q: 'Do I need to buy a phone number?', a: 'No. Signalcraft places calls from numbers it manages in each country, in the series Indian rules require. There is nothing to rent or register.' },
      { q: 'What languages can the AI agent speak?', a: 'For India: English, Hindi, Tamil and Telugu. For the US: English and Spanish. Arabic (UAE) is available too; calls to UAE numbers are coming soon. Each agent speaks the language you set for it.' },
      { q: 'What happens after a call?', a: 'The recording, transcript, summary, interest level and any callback time are saved to the contact, and a callback becomes a CRM task.' },
      { q: 'Can people opt out?', a: 'Yes. They can press 9, or simply tell the AI agent to stop calling. Either way they are added to your do-not-call list.' },
    ],
  },
  {
    slug: 'crm',
    name: 'CRM',
    line: 'Pipelines, deals, tasks, lead scoring and round-robin owners.',
    icon: Handshake,
    meta: {
      title: 'CRM · Signalcraft',
      description: 'Pipelines, deals, companies, tasks and reports, with lead scoring, round-robin assignment and a timeline of every form, chat, email and call.',
    },
    hero: {
      eyebrow: 'CRM',
      title: ['A CRM that ', 'already knows', ' what happened.'],
      subhead:
        'Every form, chat, email click and call outcome is on the contact’s timeline. Leads are scored, routed to an owner and turned into deals your team can close.',
    },
    features: [
      {
        title: 'Drag-and-drop pipelines',
        text: 'Move deals through your stages, see the value in each, and record why deals are won or lost.',
        bullets: ['Multiple pipelines', 'Win and loss reasons', 'Alerts on deals that go quiet'],
        visual: { kind: 'steps', items: ['New', 'Qualified', 'Proposal', 'Won'] },
      },
      {
        title: 'Leads scored and routed',
        text: 'Score leads on what they do, assign them round-robin to the right owners, and get alerted when a lead waits too long.',
        bullets: ['Lead scoring rules', 'Round-robin assignment', 'Response-time alerts'],
        visual: { kind: 'bars', items: [{ label: 'Priya · 82', value: 0.82 }, { label: 'Rahul · 64', value: 0.64 }, { label: 'Meera · 31', value: 0.31 }] },
      },
      {
        title: 'One timeline per person',
        text: 'Forms, chats, emails and calls appear on one timeline, alongside notes and logged activity from your team.',
        bullets: ['Every channel in one place', 'Notes, calls and meetings', 'Companies with their contacts'],
        visual: { kind: 'checks', items: ['21:02 Submitted “Request a demo”', '21:04 Chatted with the assistant', '21:20 AI call · Interested', '09:00 Task: send proposal'] },
      },
    ],
    related: [
      { slug: 'lead-forms', text: 'Forms create contacts and deals with their source attached.' },
      { slug: 'automation', text: 'Trigger journeys when a deal is created, moves stage, is won or goes quiet.' },
      { slug: 'analytics', text: 'Pipeline and conversion reports next to channel performance.' },
    ],
    useCases: [
      { ...RE, text: 'A pipeline from enquiry to site visit to booking, with owners per project.' },
      { ...EDU, text: 'Counsellor pipelines from enquiry to application to enrolment.' },
      { ...D2C, text: 'Track bulk and corporate orders alongside your retail customers.' },
      { ...CLINIC, text: 'Follow up treatment enquiries and package sales with tasks and reminders.' },
      { ...AGENCY, text: 'Run each client’s pipeline separately, and your own new-business pipeline too.' },
    ],
    compliance: [
      { title: 'Roles and permissions', text: 'Control who can see and change contacts and deals in each application.' },
      { title: 'Audit log', text: 'Sensitive actions such as exports and deletions are recorded with who did them.' },
      { title: 'Export and erase', text: 'Export everything about a person or erase them everywhere, as the DPDP Act, the UAE PDPL and GDPR require.' },
    ],
    pricing: {
      limits: [{ key: 'contacts', label: 'Contacts' }, { key: 'members', label: 'Team members' }],
      note: 'The CRM is included on every plan. There is no per-seat charge.',
    },
    faq: [
      { q: 'Can I import my existing contacts?', a: 'Yes. Import from a spreadsheet, map the columns to fields, and Signalcraft merges duplicates.' },
      { q: 'Is the CRM a separate product?', a: 'No. It shares one contact record with forms, chat, email and voice, so every interaction is already there.' },
      { q: 'Can I have more than one pipeline?', a: 'Yes. Create pipelines with their own stages, for example one for new business and one for renewals.' },
    ],
  },
  {
    slug: 'automation',
    name: 'Automation',
    line: 'Journeys that react to forms, chats, calls, clicks and deals.',
    icon: Workflow,
    meta: {
      title: 'Automation · Signalcraft',
      description: 'Build visual journeys that react to forms, chats, calls, email clicks and deal changes, then send, wait, branch and assign across every channel.',
    },
    hero: {
      eyebrow: 'Automation',
      title: ['Follow-ups that ', 'run themselves.', ''],
      subhead:
        'Draw a journey once: when a form is submitted, wait, send an email, call if it was not opened, and assign the lead. Signalcraft runs it for every contact.',
    },
    features: [
      {
        title: 'Triggers from every channel',
        text: 'Start a journey when a form is submitted, a chat captures a lead, a call is answered, an email is clicked, or a deal changes. SMS replies will join when SMS opens (coming soon).',
        bullets: ['Forms, chats and calls', 'Email clicks', 'Deal created, moved, won, lost or quiet'],
        visual: { kind: 'chips', items: ['Form submitted', 'Chat lead captured', 'Call answered', 'Email clicked', 'Deal won', 'Tag added'] },
      },
      {
        title: 'Branch on what people do',
        text: 'Wait for a time or an event, then branch: opened or not, answered or voicemail, tagged or not. Each path can use a different channel.',
        bullets: ['Waits and delays', 'If/else branches', 'Answered vs voicemail'],
        visual: { kind: 'steps', items: ['Wait 1 day', 'Opened?', 'Yes → AI call', 'No → Reminder email'] },
      },
      {
        title: 'Actions across the platform',
        text: 'Send an email or place a call (SMS steps are coming soon), add or remove tags and lists, update contact fields, and create deals and tasks for your team.',
        bullets: ['Send on any channel', 'Create deals and tasks', 'Update fields, tags and lists'],
        visual: { kind: 'checks', items: ['Send email “Welcome”', 'Add tag “hot lead”', 'Create task for owner', 'Add to list “Q4 nurture”'] },
      },
    ],
    related: [
      { slug: 'lead-forms', text: 'The most common trigger: a new form submission.' },
      { slug: 'voice', text: 'Use AI calls as a step, and branch on the outcome.' },
      { slug: 'crm', text: 'Create deals, move stages and assign owners from a journey.' },
    ],
    useCases: [
      { ...RE, text: 'New enquiry → instant text → AI call in 5 minutes → site-visit task for the owner.' },
      { ...EDU, text: 'Abandoned application → reminder email → counsellor call if not completed in 2 days.' },
      { ...D2C, text: 'First order → thank-you email → review request a week after delivery.' },
      { ...CLINIC, text: 'Appointment booked → reminder text the day before → feedback email after the visit.' },
      { ...AGENCY, text: 'Reusable journeys copied into each client’s application.' },
    ],
    compliance: [
      { title: 'Every step checks consent', text: 'Sends inside a journey follow the same consent, opt-out and quiet-hour rules as campaigns.' },
      { title: 'Quiet hours respected', text: 'Steps that fall outside legal hours wait until the window opens.' },
      { title: 'Visible history', text: 'Each contact’s path through a journey is recorded, so you can see what happened and why.' },
    ],
    pricing: {
      note: 'Journeys are included on every plan. Messages and calls they send are charged at the normal channel rates.',
    },
    faq: [
      { q: 'Do workflows cost extra?', a: 'No. Building and running journeys is included. Emails, calls and AI replies they send are charged at the usual rates from your wallet.' },
      { q: 'Can a journey call someone with the AI agent?', a: 'Yes. Add a call step that uses one of your AI agents, then branch on whether the call was answered or went to voicemail.' },
      { q: 'Can one journey use several channels?', a: 'Yes. A single journey can send an email, wait and place a call, choosing the next step from what the contact did.' },
    ],
  },
  {
    slug: 'analytics',
    name: 'Analytics',
    line: 'Every channel in one report, with spend and conversion.',
    icon: BarChart3,
    meta: {
      title: 'Analytics · Signalcraft',
      description: 'See leads, conversations, campaigns, calls, deals and spend across every channel in one report, so you know what is working.',
    },
    hero: {
      eyebrow: 'Analytics',
      title: ['See what ', 'actually works', ', in one place.'],
      subhead: 'Leads, conversations, campaigns, calls, deals and spend from every channel in one report, so you can put your budget where it converts.',
    },
    features: [
      {
        title: 'All channels, one view',
        text: 'Compare forms, chat, email and voice side by side, with the volume, engagement and cost of each.',
        bullets: ['Per-channel performance', 'Spend from your wallet', 'Any date range'],
        visual: { kind: 'bars', items: [{ label: 'Forms', value: 0.72 }, { label: 'Chat', value: 0.56 }, { label: 'Email', value: 0.88 }, { label: 'Voice', value: 0.41 }] },
      },
      {
        title: 'From lead to revenue',
        text: 'Follow leads from their source to won deals, and see which forms, campaigns and calls brought in the business.',
        bullets: ['Lead sources and UTM campaigns', 'Pipeline and win rate', 'Revenue from won deals'],
        visual: { kind: 'steps', items: ['Visitors', 'Leads', 'Qualified', 'Won'] },
      },
      {
        title: 'Reports for every module',
        text: 'Dig into a campaign’s clicks, a bot’s conversations, a call campaign’s outcomes or a pipeline’s velocity.',
        bullets: ['Campaign and call reports', 'Chat analytics', 'CRM reports'],
        visual: { kind: 'chips', items: ['Campaign report', 'Call outcomes', 'Chat analytics', 'Pipeline', 'Form conversion', 'Spend'] },
      },
    ],
    related: [
      { slug: 'email', text: 'Campaign reports with opens, clicks and bounces.' },
      { slug: 'crm', text: 'Pipeline, win rate and revenue reports.' },
      { slug: 'voice', text: 'Answer rates, outcomes and AI call summaries.' },
    ],
    useCases: [
      { ...RE, text: 'See which project pages and ad campaigns bring in site visits.' },
      { ...EDU, text: 'Track enquiries to enrolments by course and campaign.' },
      { ...D2C, text: 'Compare the cost and return of email and calls for each offer.' },
      { ...CLINIC, text: 'Measure how many enquiries turn into appointments.' },
      { ...AGENCY, text: 'Share clear, per-client results across every channel.' },
    ],
    compliance: [
      { title: 'Per-application data', text: 'Reports are scoped to each application, so brands and clients stay separate.' },
      { title: 'Role-based access', text: 'Only people with permission can see reports and spend.' },
      { title: 'GST-ready spend', text: 'Spend ties back to wallet top-ups with GST tax invoices in India.' },
    ],
    pricing: {
      limits: [{ key: 'applications', label: 'Applications' }],
      note: 'Analytics are included on every plan, for every application.',
    },
    faq: [
      { q: 'Does analytics cost extra?', a: 'No. Reports for every channel are included on every plan.' },
      { q: 'Can I see spend per channel?', a: 'Yes. Spend from your wallet is broken down by channel, so you can compare cost against results.' },
      { q: 'Can I report on each brand separately?', a: 'Yes. Each application has its own reports, and the organisation sees billing across all of them.' },
    ],
  },
  {
    slug: 'ai-team',
    name: 'AI Team',
    line: 'An AI assistant and AI agents that work across every module, and in Slack.',
    icon: Sparkles,
    meta: {
      title: 'AI Team · Signalcraft',
      description: 'An in-app AI assistant that answers questions about your data and prepares changes for you to confirm, plus AI agents that qualify leads, watch deals and post reports to Slack.',
    },
    hero: {
      eyebrow: 'AI Team',
      title: ['A team that ', 'never sleeps', ', and always asks first.'],
      subhead:
        'Ask the assistant about your pipeline, campaigns and chats, and let it prepare tasks, segments and drafts for you to confirm. AI agents watch for new leads and cold deals and report to your team in the app, by email or in Slack.',
    },
    features: [
      {
        title: 'An assistant on every page',
        text: 'Press Ctrl+J anywhere. It knows the page you are on, looks things up with the same permissions you have, and answers with links straight to the right record.',
        bullets: ['Stale deals, tasks due, campaign results', 'Cross-channel KPIs for any date range', 'How-to answers about the product'],
        visual: { kind: 'chat', lines: [{ who: 'them', text: 'Which deals are stale?' }, { who: 'us', text: '3 deals have had no activity past their stage limit. Open Acme renewal →' }], tag: 'Answered from your CRM' },
      },
      {
        title: 'Nothing happens until you confirm',
        text: 'When you ask for a change, the assistant shows a card with exactly what will happen. Confirm, edit or cancel. It never sends campaigns, deletes data, spends credit or changes roles.',
        bullets: ['Confirm, edit or cancel every change', 'Draft emails stay drafts', 'Every action is in the audit log'],
        visual: { kind: 'checks', items: ['Create task: Call Priya tomorrow', 'Create segment: Leads in Mumbai', 'Draft email: Diwali offer', 'Draft workflow: Follow up form leads'] },
      },
      {
        title: 'AI agents from ready templates',
        text: 'Switch on a lead qualifier, a hot-lead alert, a stale-deal watchdog or a daily report, or describe what you want. Each run is logged step by step, and you can test it first with a dry run.',
        bullets: ['Triggered by forms, chats, calls and deals, or on a schedule', 'Ask-for-approval or act-on-its-own modes', 'Run log for every run'],
        visual: { kind: 'steps', items: ['New lead', 'Research & score', 'Note + owner', 'Post to Slack'] },
      },
      {
        title: 'Approve from Slack',
        text: 'Add Signalcraft to Slack and agents post reports and approval requests to the channel you pick, with Approve, Reject and Open in Signalcraft buttons. Clicks are matched to your teammates by email.',
        bullets: ['“Add to Slack” in one click', 'Channel picker', 'Only teammates with permission can approve'],
        visual: { kind: 'chips', items: ['#sales', 'Approve', 'Reject', 'Open in Signalcraft', 'Daily report', 'Hot lead'] },
      },
    ],
    related: [
      { slug: 'automation', text: 'Add an AI step to classify or write, and a Send to Slack step, inside any journey.' },
      { slug: 'crm', text: 'Agents qualify leads, assign owners and flag deals going cold.' },
      { slug: 'analytics', text: 'Daily and weekly reports across every channel, posted where your team works.' },
    ],
    useCases: [
      { ...RE, text: 'Every portal enquiry is researched and scored, and the hot ones become a call task within minutes.' },
      { ...EDU, text: 'A morning report of new enquiries and counsellor tasks, posted to the admissions channel.' },
      { ...D2C, text: 'Chat leads get a personal follow-up email drafted for the team to approve.' },
      { ...CLINIC, text: 'Questions the chatbot couldn’t answer, collected each evening so the team can teach it.' },
      { ...AGENCY, text: 'A weekly campaign report per client application, with the best and worst performers.' },
    ],
    compliance: [
      { title: 'Your permissions, never more', text: 'The assistant and agents act as a person in your team, with that person’s role. A viewer can ask questions but can’t change anything.' },
      { title: 'Data is never instructions', text: 'Text inside contacts, notes, chats and websites is treated as data. Changes still need a person to confirm or approve.' },
      { title: 'Every action is logged', text: 'Everything done through the AI is recorded in the audit log as done via the AI Assistant or a named agent.' },
    ],
    pricing: {
      rates: [
        { key: 'ai_assistant_message_typical', label: 'AI Assistant', unit: 'typical simple question (metered)' },
        { key: 'ai_agent_run_typical', label: 'AI agent run', unit: 'typical run (metered)' },
      ],
      limits: [
        { key: 'ai_assistant_messages_per_day', label: 'Fair-use limit: assistant messages a day' },
        { key: 'ai_agent_runs_per_day', label: 'Fair-use limit: agent runs a day' },
      ],
      note: 'Pay per use from your wallet on both plans: metered at about 3× the AI model’s cost, with a small minimum per reply or run, and the charge is shown on every reply. Test runs are free. Emails and calls the AI prepares are charged at the normal rates when you send them.',
    },
    faq: [
      { q: 'Does the AI send emails or launch campaigns on its own?', a: 'No. It can draft an email campaign, but sending, launching and scheduling are always done by you.' },
      { q: 'Which AI does the AI Team use?', a: 'The AI Team runs on OpenAI models, called without asking the provider to store your data between requests.' },
      { q: 'Do I need Slack?', a: 'No. Agents can report in the app and by email. Slack adds channel posts and Approve / Reject buttons.' },
      { q: 'What does it cost?', a: 'It is pay per use from your wallet on Starter and Pro: each assistant reply and agent run is metered at about 3× the AI model’s cost, with a small minimum, and the charge is shown on the reply or run. Pro’s discount applies. Test runs are free, and anything the AI prepares that costs money, like sending an email, is charged as usual when it is sent.' },
    ],
  },
]

export const PRODUCT_BY_SLUG = Object.fromEntries(PRODUCTS.map((p) => [p.slug, p])) as Record<ProductSlug, Product>

export function findProduct(slug: string | undefined): Product | undefined {
  return PRODUCTS.find((p) => p.slug === slug)
}
