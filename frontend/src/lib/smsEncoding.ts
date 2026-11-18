/** SMS segment counting (3GPP TS 23.038). Mirrors backend/app/services/sms/encoding.py. */
const GSM7_BASIC = new Set(
  Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'),
)
const GSM7_EXTENDED = new Set(Array.from('^{}\\[~]|€\f'))

export interface SegmentInfo {
  encoding: 'GSM-7' | 'UCS-2'
  characters: number
  units: number
  segments: number
  perSegment: number
  remaining: number
  nonGsm: string[]
}

export function analyseSms(text: string): SegmentInfo {
  const chars = Array.from(text)
  const nonGsm = [...new Set(chars.filter((c) => !GSM7_BASIC.has(c) && !GSM7_EXTENDED.has(c)))].sort()
  let units: number
  let single: number
  let multi: number
  let encoding: SegmentInfo['encoding']
  if (!nonGsm.length) {
    units = chars.reduce((n, c) => n + (GSM7_EXTENDED.has(c) ? 2 : 1), 0)
    single = 160
    multi = 153
    encoding = 'GSM-7'
  } else {
    units = text.length // UTF-16 code units, as UCS-2 counts them on the wire
    single = 70
    multi = 67
    encoding = 'UCS-2'
  }
  if (units === 0) return { encoding, characters: 0, units: 0, segments: 0, perSegment: single, remaining: single, nonGsm }
  const segments = units <= single ? 1 : Math.ceil(units / multi)
  const per = units <= single ? single : multi
  return { encoding, characters: chars.length, units, segments, perSegment: per, remaining: segments * per - units, nonGsm: nonGsm.slice(0, 20) }
}

const VAR = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|\s*default\s*:\s*("[^"]*"|'[^']*'))?\s*\}\}/g

/** {{field}} placeholders written the way DLT templates register them. */
export const toDltPattern = (body: string) => body.replace(VAR, '{#var#}').replace(/\s+/g, ' ').trim()

export const SAMPLE_VALUES: Record<string, string> = {
  first_name: 'Asha',
  last_name: 'Rao',
  full_name: 'Asha Rao',
  email: 'asha@example.com',
  company: 'Acme',
  city: 'Hyderabad',
  state: 'Telangana',
  country: 'IN',
}

export function personaliseSample(body: string) {
  return body.replace(VAR, (_m, k: string, d?: string) => SAMPLE_VALUES[k] || (d ? d.slice(1, -1) : ''))
}

export const OPT_OUT_TEXT = 'Reply STOP to opt out'

export function finalBody(body: string, country: string | null | undefined, category: string, appendOptOut: boolean) {
  const t = body.trim()
  return country === 'US' && category === 'promotional' && appendOptOut && !t.toLowerCase().includes('stop') ? `${t} ${OPT_OUT_TEXT}` : t
}
