import type { CallerKind, VoiceCategory } from '@/types/voice'

export const CATEGORY_LABEL: Record<VoiceCategory, string> = {
  promotional: 'Promotional',
  transactional: 'Transactional',
  service: 'Service',
}

export const CALLER_KIND_LABEL: Record<CallerKind, string> = {
  series_140: '140-series (promotional)',
  series_160: '160-series (service & transactional)',
  local: 'Local number',
  toll_free: 'Toll-free number',
}

export const CALL_STATUS: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' | 'default' }> = {
  queued: { label: 'Queued', variant: 'secondary' },
  deferred: { label: 'Waiting', variant: 'warning' },
  placing: { label: 'Dialling', variant: 'default' },
  dialing: { label: 'Dialling', variant: 'default' },
  ringing: { label: 'Ringing', variant: 'default' },
  in_progress: { label: 'On call', variant: 'default' },
  completed: { label: 'Answered', variant: 'success' },
  voicemail: { label: 'Voicemail', variant: 'secondary' },
  no_answer: { label: 'No answer', variant: 'warning' },
  busy: { label: 'Busy', variant: 'warning' },
  failed: { label: 'Failed', variant: 'destructive' },
  skipped: { label: 'Skipped', variant: 'warning' },
}

export function formatDuration(seconds: number | string | null | undefined) {
  const s = Math.round(Number(seconds ?? 0))
  if (!s) return '0s'
  const m = Math.floor(s / 60)
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
