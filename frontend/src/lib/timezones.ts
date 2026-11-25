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
  return ['UTC', 'Asia/Kolkata', 'Asia/Dubai', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Asia/Singapore']
})()

/** The viewer's timezone with legacy names normalised (Asia/Calcutta → Asia/Kolkata). */
export const browserTimezone = () => normalise(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')

export const normaliseTimezone = normalise

/** Default timezone for each country offered in pickers. */
export const COUNTRY_DEFAULT_TIMEZONE: Record<string, string> = {
  IN: 'Asia/Kolkata',
  US: 'America/New_York',
  AE: 'Asia/Dubai',
  AU: 'Australia/Sydney',
  BD: 'Asia/Dhaka',
  CA: 'America/Toronto',
  DE: 'Europe/Berlin',
  GB: 'Europe/London',
  LK: 'Asia/Colombo',
  NP: 'Asia/Kathmandu',
  QA: 'Asia/Qatar',
  SA: 'Asia/Riyadh',
  SG: 'Asia/Singapore',
}

const US_ZONES = new Set([
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'America/Juneau', 'America/Sitka', 'America/Nome', 'America/Yakutat', 'America/Metlakatla',
  'America/Adak', 'Pacific/Honolulu', 'America/Detroit', 'America/Boise', 'America/Menominee', 'America/Puerto_Rico',
])
const CA_ZONES = new Set([
  'America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax', 'America/St_Johns',
  'America/Regina', 'America/Moncton', 'America/Whitehorse', 'America/Yellowknife', 'America/Iqaluit',
])

/** Whether a timezone belongs to a country (approximate; only used to pick sensible defaults). */
export function timezoneInCountry(tz: string, country: string): boolean {
  const z = normalise(tz)
  if (country === 'US') return US_ZONES.has(z) || /^America\/(Indiana|Kentucky|North_Dakota)\//.test(z)
  if (country === 'CA') return CA_ZONES.has(z)
  if (country === 'AU') return z.startsWith('Australia/')
  return COUNTRY_DEFAULT_TIMEZONE[country] === z
}

/** The browser's timezone when it is inside `country`, otherwise that country's default. */
export function timezoneForCountry(country: string | null | undefined): string {
  const browser = browserTimezone()
  if (!country) return browser
  return timezoneInCountry(browser, country) ? browser : COUNTRY_DEFAULT_TIMEZONE[country] ?? browser
}
