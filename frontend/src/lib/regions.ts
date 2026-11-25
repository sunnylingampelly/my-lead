/** Countries offered in pickers. India, the UAE and the United States are the primary markets and come first. */
export interface Country {
  code: string
  name: string
  dial: string
  flag: string
}

export const PRIMARY_COUNTRIES: Country[] = [
  { code: 'IN', name: 'India', dial: '+91', flag: '🇮🇳' },
  { code: 'AE', name: 'United Arab Emirates', dial: '+971', flag: '🇦🇪' },
  { code: 'US', name: 'United States', dial: '+1', flag: '🇺🇸' },
]

/** Wallet currency per primary market (default time zones: COUNTRY_DEFAULT_TIMEZONE in lib/timezones). */
export const MARKET_CURRENCY: Record<string, string> = { IN: 'INR', AE: 'AED', US: 'USD' }

/** Number-format locale for a currency: Indian grouping for INR, en-AE for AED, en-US otherwise. */
export const currencyLocale = (currency?: string | null) =>
  currency === 'INR' ? 'en-IN' : currency === 'AED' ? 'en-AE' : 'en-US'

/** The seven emirates (billing address of UAE organizations). */
export const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah']

export const OTHER_COUNTRIES: Country[] = [
  { code: 'AU', name: 'Australia', dial: '+61', flag: '🇦🇺' },
  { code: 'BD', name: 'Bangladesh', dial: '+880', flag: '🇧🇩' },
  { code: 'CA', name: 'Canada', dial: '+1', flag: '🇨🇦' },
  { code: 'DE', name: 'Germany', dial: '+49', flag: '🇩🇪' },
  { code: 'GB', name: 'United Kingdom', dial: '+44', flag: '🇬🇧' },
  { code: 'LK', name: 'Sri Lanka', dial: '+94', flag: '🇱🇰' },
  { code: 'NP', name: 'Nepal', dial: '+977', flag: '🇳🇵' },
  { code: 'QA', name: 'Qatar', dial: '+974', flag: '🇶🇦' },
  { code: 'SA', name: 'Saudi Arabia', dial: '+966', flag: '🇸🇦' },
  { code: 'SG', name: 'Singapore', dial: '+65', flag: '🇸🇬' },
]

export const ALL_COUNTRIES = [...PRIMARY_COUNTRIES, ...OTHER_COUNTRIES]

export const countryName = (code?: string | null) =>
  ALL_COUNTRIES.find((c) => c.code === code)?.name ?? code ?? '—'

let flagSupport: boolean | null = null
/** Windows has no flag emoji glyphs (they render as two letters), so detect support once. */
export function supportsFlagEmoji(): boolean {
  if (flagSupport !== null) return flagSupport
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return (flagSupport = false)
    ctx.font = '16px sans-serif'
    // A supported flag is one glyph; unsupported ones are two regional-indicator letters.
    flagSupport = ctx.measureText('\u{1F1FA}\u{1F1F8}').width < ctx.measureText('\u{1F1FA}').width * 1.5
  } catch {
    flagSupport = false
  }
  return flagSupport
}

/** Emoji flag, or '' where the platform cannot draw it (use <CountryFlag> for an always-visible flag). */
export const countryFlag = (code?: string | null) =>
  supportsFlagEmoji() ? ALL_COUNTRIES.find((c) => c.code === code)?.flag ?? '' : ''

/** Best guess of the viewer's market from the browser locale (en-IN, hi-IN → IN; en-US → US). */
export function browserCountry(): string | null {
  const locales = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const l of locales) {
    const region = l.split('-')[1]?.toUpperCase()
    if (region && /^[A-Z]{2}$/.test(region)) return region
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'IN'
  if (tz === 'Asia/Dubai') return 'AE'
  if (tz?.startsWith('America/')) return 'US'
  return null
}

export const US_STATES: [string, string][] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'],
  ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'], ['PR', 'Puerto Rico'],
]

export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
]

/** Grouped number formatting: Indian lakh/crore grouping for India, western grouping elsewhere. */
export function formatCount(n: number, country?: string | null) {
  return new Intl.NumberFormat(country === 'IN' ? 'en-IN' : 'en-US').format(n)
}

/** Readable E.164 for India, UAE and US numbers; other numbers are returned unchanged. */
export function formatPhone(e164: string) {
  let m = /^\+91(\d{5})(\d{5})$/.exec(e164)
  if (m) return `+91 ${m[1]} ${m[2]}`
  m = /^\+971(5\d)(\d{3})(\d{4})$/.exec(e164)
  if (m) return `+971 ${m[1]} ${m[2]} ${m[3]}`
  m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  if (m) return `+1 ${m[1]}-${m[2]}-${m[3]}`
  return e164
}
