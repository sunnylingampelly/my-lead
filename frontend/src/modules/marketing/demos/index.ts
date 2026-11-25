import type { ComponentType } from 'react'
import type { ProductSlug } from '../products'
import { AiTeamDemo } from './AiTeamDemo'
import { AnalyticsDemo } from './AnalyticsDemo'
import { AutomationDemo } from './AutomationDemo'
import { ChatDemo } from './ChatDemo'
import { CrmDemo } from './CrmDemo'
import { EmailDemo } from './EmailDemo'
import { FormDemo } from './FormDemo'
import { SmsDemo } from './SmsDemo'
import { VoiceDemo } from './VoiceDemo'

export { AiTeamDemo, AnalyticsDemo, AutomationDemo, ChatDemo, CrmDemo, EmailDemo, FormDemo, SmsDemo, VoiceDemo }

/** The interactive demo shown on each product page. */
export const DEMOS: Record<ProductSlug, ComponentType<{ className?: string }>> = {
  'lead-forms': FormDemo,
  chatbot: ChatDemo,
  email: EmailDemo,
  sms: SmsDemo,
  voice: VoiceDemo,
  crm: CrmDemo,
  automation: AutomationDemo,
  analytics: AnalyticsDemo,
  'ai-team': AiTeamDemo,
}
