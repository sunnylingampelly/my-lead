const LABELS: Record<string, string> = {
  'user.registered': 'created an account',
  'user.email_verified': 'verified their email',
  'user.login': 'signed in',
  'user.login_failed': 'had a failed sign-in attempt',
  'user.password_changed': 'changed their password',
  'user.password_reset': 'reset their password',
  'user.password_reset_requested': 'requested a password reset',
  'user.profile_updated': 'updated their profile',
  'user.refresh_token_reuse': 'triggered a session security reset',
  'organization.created': 'created the organization',
  'organization.updated': 'updated organization details',
  'member.updated': 'updated a member',
  'member.removed': 'removed a member',
  'member.left': 'left the organization',
  'invitation.created': 'sent an invitation',
  'invitation.resent': 'resent an invitation',
  'invitation.revoked': 'revoked an invitation',
  'invitation.accepted': 'joined via invitation',
  'application.created': 'created an application',
  'application.updated': 'updated an application',
  'application.deleted': 'deleted an application',
  'application.settings_updated': 'changed application settings',
  'application.member_added': 'granted application access',
  'application.member_removed': 'removed application access',
}


/** What each audited record type is called in sentences ("created a deal"). */
const NOUNS: Record<string, string> = {
  crm_deal: 'a deal',
  crm_company: 'a company',
  crm_note: 'a note',
  crm_pipeline: 'a pipeline',
  crm_settings: 'CRM settings',
  crm_assignment_rule: 'an assignment rule',
  crm_scoring_rule: 'a lead scoring rule',
  email_campaign: 'an email campaign',
  email_template: 'an email template',
  email_sender: 'an email sender',
  sms_campaign: 'an SMS campaign',
  voice_campaign: 'a voice campaign',
  workflow: 'a workflow',
  segment: 'a segment',
  list: 'a list',
  tag: 'a tag',
  custom_field: 'a custom field',
  import: 'a contact import',
  contacts: 'contacts',
  suppression: 'a suppression entry',
  sms: 'SMS setup',
  voice: 'voice setup',
  billing: 'billing',
}

/** Past-tense verbs for action suffixes, with an optional object override ("sender_created" → "added an SMS sender ID"). */
const VERBS: Record<string, string> = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  moved: 'moved',
  launched: 'launched',
  scheduled: 'scheduled',
  unscheduled: 'unscheduled',
  paused: 'paused',
  resumed: 'resumed',
  cancelled: 'cancelled',
  published: 'published',
  archived: 'archived',
  saved: 'saved',
  uploaded: 'uploaded',
  started: 'started',
  exported: 'exported',
  added: 'added',
  removed: 'removed',
  test_sent: 'sent a test of',
  test_call: 'placed a test call for',
  contacts_linked: 'linked contacts to',
}

const SPECIAL: Record<string, string> = {
  'sms.registration_updated': 'updated DLT / 10DLC registration',
  'sms.sender_created': 'added an SMS sender ID',
  'sms.sender_attested': 'confirmed an SMS sender ID',
  'sms.sender_deleted': 'removed an SMS sender ID',
  'voice.caller_created': 'added a voice caller ID',
  'voice.caller_attested': 'confirmed a voice caller ID',
  'voice.caller_deleted': 'removed a voice caller ID',
  'voice.number_assigned': 'got a phone number',
  'voice.number_released': 'released a phone number',
  'voice.agent_created': 'created an AI agent',
  'voice.agent_duplicated': 'duplicated an AI agent',
  'voice.agent_activated': 'activated an AI agent',
  'voice.agent_deactivated': 'switched off an AI agent',
  'voice.agent_deleted': 'deleted an AI agent',
  'admin.phone_numbers_added': 'added numbers to the phone number pool',
  'admin.phone_number_retired': 'retired a pool phone number',
  'voice.audio_uploaded': 'uploaded voice audio',
  'voice.audio_deleted': 'deleted voice audio',
  'billing.test_credit': 'added test credit',
  'billing.checkout_created': 'started a payment',
  'contacts.deleted': 'deleted contacts',
  'contacts.exported': 'exported contacts',
  'support.access_started': 'started a platform support session',
  'support.access_ended': 'ended a platform support session',
  'crm_deal.moved': 'moved a deal to another stage',
}

/** Human sentence fragment for an audit action key, e.g. "crm_deal.moved" → "moved a deal to another stage". */
export const describeAction = (action: string): string => {
  if (LABELS[action]) return LABELS[action]!
  if (SPECIAL[action]) return SPECIAL[action]!
  const [entity = '', verb = ''] = action.split('.', 2)
  if (entity === 'contacts' && verb.startsWith('bulk_')) return `bulk-updated contacts (${verb.slice(5).replace(/_/g, ' ')})`
  const noun = NOUNS[entity]
  const v = VERBS[verb]
  if (noun && v) return `${v} ${noun}`
  return action.replace(/^crm_/, '').replace(/[._]/g, ' ')
}
