/** Legacy IANA names some browsers (notably Chrome on Windows) still report. */
const LEGACY: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
}

const normalise = (tz: string) => LEGACY[tz] ?? tz

export const TIMEZONES: string[] = (() => {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone')
    if (list?.length) {
      const set = new Set(list.map(normalise))
      set.add('Asia/Kolkata')
      set.delete('UTC')
      return ['UTC', ...[...set].sort()]
    }
  } catch {
    /* older browsers */
  }
  return ['UTC', 'Asia/Kolkata', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Asia/Singapore']
})()

/** The viewer's timezone with legacy names normalised (Asia/Calcutta → Asia/Kolkata). */
export const browserTimezone = () => normalise(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')

export const normaliseTimezone = normalise
