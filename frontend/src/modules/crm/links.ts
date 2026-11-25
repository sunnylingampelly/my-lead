/** URL builders for the shared campaign / workflow contracts (C3, C4) and reachability helpers. */
import type { Channel } from '@/types/audience'
import type { Reach } from '@/types/crm'

// ------------------------------------------------------------------ links (shared contracts C3 / C4)

export type CampaignChannel = 'email' | 'sms' | 'voice'

/** C3: a new draft campaign with the audience preselected. */
export function campaignUrl(appId: string, channel: CampaignChannel, audience: { segment_id?: string; list_id?: string; contact_ids?: string[] }) {
  const q = new URLSearchParams()
  if (audience.segment_id) q.set('segment_id', audience.segment_id)
  if (audience.list_id) q.set('list_id', audience.list_id)
  if (audience.contact_ids?.length) q.set('contact_ids', audience.contact_ids.join(','))
  return `/apps/${appId}/${channel}/campaigns/new?${q.toString()}`
}

/** C4: a new workflow triggered when someone enters a segment or is added to a list. */
export function workflowUrl(appId: string, audience: { segment_id?: string; list_id?: string }) {
  return audience.segment_id
    ? `/apps/${appId}/automation/new?trigger=segment_entered&segment_id=${encodeURIComponent(audience.segment_id)}`
    : `/apps/${appId}/automation/new?trigger=added_to_list&list_id=${encodeURIComponent(audience.list_id ?? '')}`
}

export const CHANNEL_LABEL: Record<Channel, string> = { email: 'Email', sms: 'SMS', voice: 'Voice' }

/** Reach from a contact's eligibility (ContactDetail.eligibility). */
export function reachFromEligibility(e: Record<Channel, { eligible: boolean; reasons: string[] }> | undefined): { reach: Reach; reasons: Record<Channel, string[]> } | null {
  if (!e) return null
  return {
    reach: { email: !!e.email?.eligible, sms: !!e.sms?.eligible, voice: !!e.voice?.eligible },
    reasons: { email: e.email?.reasons ?? [], sms: e.sms?.reasons ?? [], voice: e.voice?.reasons ?? [] },
  }
}
