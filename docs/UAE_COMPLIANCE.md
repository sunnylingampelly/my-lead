# UAE: compliance and launch scope

Research date: 25 Nov 2026. Sources are listed below each section. Items marked **UNVERIFIED** need
confirmation from UAE counsel, a carrier or a tax agent before relying on them.

## Launch scope (decided 25 Nov 2026)

| Area | At launch | Why |
|---|---|---|
| Email, lead forms, AI chatbot (Arabic replies), CRM, automation, analytics | **On** | Rules are workable: opt-in consent, sender identity, easy unsubscribe |
| AED wallet | **On** | Razorpay international payments in AED (settles in INR) |
| Who can buy | **UAE VAT-registered businesses only** (TRN required) | Reverse charge needs no UAE VAT registration; non-registered buyers would require Signalcraft to register first |
| SMS to UAE | **Off ("coming soon")**, rules built | AWS has paused new UAE sender-ID registrations; promotional SMS is limited to UAE-licensed senders |
| Voice / AI calls to UAE | **Off ("coming soon")**, rules built | Marketing calls must come from the customer's own licensed UAE numbers; outbound-capable numbers take 15–120 days |

## SMS
- AWS End User Messaging: "UAE Sender ID registrations temporarily paused … until further notice". Long codes are inbound-only.
  Sender IDs are transactional only for AWS UAE. https://docs.aws.amazon.com/sms-voice/latest/userguide/registrations-united-arab-emirates.html
- All sender IDs are registered with e& and du. Promotional sender IDs need the **"AD-" prefix**, which counts toward the 11 characters.
- Promotional SMS: only from UAE-licensed entities; not delivered **21:00–07:00 UAE time**; opt-out text required
  (e.g. "To opt out SMS N to XXXX"); consent database uploaded to TDRA's Consent Management System.
- URLs, phone numbers and WhatsApp links in message bodies are restricted unless allow-listed at registration.
- Sources: https://www.twilio.com/en-us/guidelines/ae/sms · https://www.clickatell.com/sms-country-regulations/united-arab-emirates-uae/

## Voice and telemarketing (Cabinet Resolutions 56/2024 and 57/2024)
- Calls 09:00–18:00. Weekend and holiday calling **UNVERIFIED**, so blocked.
- Refusal on the first call → never call again. No answer → at most 1 retry per day, 2 per week.
- Calls come from the business's own local numbers, issued by licensed UAE telcos and registered to its trade licence.
- Calls are recorded, with a notice at the start. The caller identifies the company and purpose, and asks whether the person has time to talk.
- Do Not Call Registry (DNCR) numbers must never be called. e& business customers can check numbers in the e& Business portal.
- Automated systems are "permitted only in line with the resolution". The conditions are **UNVERIFIED**; we apply every rule above plus AI disclosure.
- Penalties: AED 10,000–150,000 per violation (calling DNCR numbers: AED 50k / 75k / 150k).
- Twilio: UAE numbers are inbound only; outbound is prohibited. https://www.twilio.com/en-us/guidelines/ae/voice
- Source: https://www.moet.gov.ae/en/ (Ministry of Economy and TDRA telemarketing summary)

## Email
- Opt-in consent, sender identified, free and easy unsubscribe, consent evidence producible within 3 business days
  (TDRA Unsolicited Electronic Communications policy, via law-firm summaries; PDPL consent also applies).

## VAT and invoices
- UAE VAT is 5%. Signalcraft (an Indian company, no UAE establishment) selling to **UAE VAT-registered businesses**:
  the customer accounts for VAT by **reverse charge**. Signalcraft charges no UAE VAT and needs no UAE registration for these sales.
- Selling to non-registered UAE customers requires Signalcraft to register for UAE VAT first (the threshold for non-residents is effectively AED 0).
  https://tax.gov.ae/en/services/vat.registration.aspx
- India side: export of services, zero-rated under an LUT. Invoice wording: "Supply meant for export under LUT without payment of IGST".
- A B2B invoice shows the customer's TRN and "Reverse charge – recipient to account for UAE VAT".
- Whether a prepaid top-up counts as a voucher for VAT timing: get tax advice.

## Data protection
- PDPL (Federal Decree-Law 45/2021) applies to foreign controllers processing UAE residents' data. Its executive regulations are not issued yet.
  Consent is the default basis. Data subjects have access, erasure and portability rights. Cross-border transfers need safeguards.
- DIFC (DP Law 5/2020) and ADGM (DP Regulations 2021) have their own laws.

## Payments
- Razorpay international payments support charging in AED; settlement is in INR (T+7). International payments must be activated.
  https://razorpay.com/docs/payments/international-payments/
- Stripe India is invite-only. Stripe UAE needs a UAE trade licence.

## Phone, time zone, work week
- Mobiles: +971 5X XXX XXXX. Time zone: Asia/Dubai (UTC+4, no daylight saving). Business days: Monday–Friday.

## Owner actions outside code
- Activate Razorpay international payments (AED). File the Indian LUT for FY 2026-27.
- Get quotes for a UAE SMS provider (Unifonic, Infobip, Twilio), since AWS is paused.
- UAE counsel: does Resolution 56 reach Signalcraft as a platform, and what are the conditions for automated or AI calls?
- Before opening sales to non-registered UAE customers: register for UAE VAT through a tax agent.
