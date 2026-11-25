/** Live preview of a form draft, rendered the way the embed renders it. */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { ALL_COUNTRIES } from '@/lib/regions'
import type { FormDefinition, FormField, FormsMeta } from '@/types/forms'
import { conditionPasses, fontStack, googleFontUrl, sanitizeHtml } from './meta'

type Values = Record<string, unknown>

function useGoogleFont(font: string, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !font || font === 'system') return
    const id = `sc-font-${font.replace(/\s+/g, '-')}`
    if (document.getElementById(id)) return
    const link = document.createElement('link')
    link.id = id
    link.rel = 'stylesheet'
    link.href = googleFontUrl(font)
    document.head.appendChild(link)
  }, [font, enabled])
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

export function FormPreview({
  def,
  meta,
  device = 'desktop',
  showSuccess = false,
  selectedId,
  onSelect,
}: {
  def: FormDefinition
  meta?: FormsMeta
  device?: 'desktop' | 'mobile'
  showSuccess?: boolean
  selectedId?: string | null
  onSelect?: (id: string) => void
}) {
  const d = def.design
  useGoogleFont(d.font, !d.use_site_font)
  const [values, setValues] = useState<Values>({})
  const [stepIdx, setStepIdx] = useState(0)
  const [submitted, setSubmitted] = useState(false)
  const [ref, width] = useWidth<HTMLDivElement>()
  const formRef = useRef<HTMLFormElement>(null)

  const steps = def.steps.length ? def.steps : [{ id: 'step_1', title: '' }]
  const last = steps.length - 1
  const step = Math.min(stepIdx, last)
  const narrow = device === 'mobile' || (width > 0 && width < 480)
  const dark = d.theme === 'dark'

  const valueOf = (f: FormField): unknown => (f.id in values ? values[f.id] : f.type === 'checkboxes' ? (f.default ? f.default.split(',').map((s) => s.trim()) : []) : f.type === 'consent' ? f.default === 'true' : f.default)
  const allValues = useMemo(() => {
    const out: Values = {}
    for (const f of def.fields) out[f.id] = f.id in values ? values[f.id] : f.default
    return out
  }, [def.fields, values])
  const visible = def.fields.filter((f) => f.type !== 'hidden' && Math.min(f.step, last) === step && conditionPasses(f, allValues))
  const set = (id: string, v: unknown) => setValues((s) => ({ ...s, [id]: v }))

  const vars = {
    '--sc-primary': d.primary_color,
    '--sc-radius': `${d.radius}px`,
    fontFamily: d.use_site_font ? 'inherit' : fontStack(d.font),
    background: d.background_color,
    color: d.text_color,
    borderRadius: Math.min(d.radius + 4, 28),
    maxWidth: d.max_width,
  } as CSSProperties
  const inputStyle: CSSProperties = {
    borderRadius: d.radius,
    border: `1px solid ${dark ? 'rgba(255,255,255,.22)' : 'rgba(15,23,42,.18)'}`,
    background: dark ? 'rgba(255,255,255,.06)' : '#ffffff',
    color: d.text_color,
    width: '100%',
    minWidth: 0,
    padding: '9px 11px',
    fontSize: 14,
    outlineColor: d.primary_color,
    fontFamily: 'inherit',
  }
  const muted: CSSProperties = { opacity: 0.7, fontSize: 12 }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!formRef.current?.reportValidity()) return
    if (step < last) setStepIdx(step + 1)
    else setSubmitted(true)
  }

  const success = showSuccess || submitted
  const countries = meta?.countries?.length ? meta.countries : ALL_COUNTRIES

  return (
    <div ref={ref} className="w-full min-w-0">
      <div
        className="mx-auto w-full p-5 shadow-card ring-1 ring-black/5 transition-all sm:p-6"
        style={{ ...vars, maxWidth: device === 'mobile' ? Math.min(d.max_width, 360) : d.max_width }}
        data-testid="form-preview"
      >
        {success ? (
          <div>
            <div className="sc-preview-success text-[15px] leading-relaxed [&_a]:underline [&_p]:my-2" dangerouslySetInnerHTML={{ __html: sanitizeHtml(def.success.message_html) }} />
            {def.success.mode !== 'message' && def.success.redirect_url && (
              <p style={muted} className="mt-3">
                {def.success.mode === 'redirect' ? 'Visitors go straight to' : `Then redirects after ${def.success.redirect_delay}s to`} <span className="break-all">{def.success.redirect_url}</span>
              </p>
            )}
            {submitted && !showSuccess && (
              <button
                type="button"
                className="mt-4 text-xs underline"
                style={{ color: d.primary_color }}
                onClick={() => {
                  setSubmitted(false)
                  setStepIdx(0)
                  setValues({})
                }}
              >
                Start over
              </button>
            )}
          </div>
        ) : (
          <form ref={formRef} onSubmit={onSubmit} noValidate={false} aria-label="Form preview">
            {d.show_title && (def.title || def.description) && (
              <div className="mb-4">
                {def.title && <h2 className="text-xl font-semibold leading-tight">{def.title}</h2>}
                {def.description && <p className="mt-1.5 whitespace-pre-line text-sm" style={{ opacity: 0.8 }}>{def.description}</p>}
              </div>
            )}
            {steps.length > 1 && (
              <div className="mb-4">
                <div className="mb-1.5 flex justify-between gap-2" style={muted}>
                  <span className="truncate">{steps[step]?.title || `Step ${step + 1}`}</span>
                  <span className="shrink-0">
                    {step + 1} / {steps.length}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full" style={{ background: dark ? 'rgba(255,255,255,.15)' : 'rgba(15,23,42,.08)' }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${((step + 1) / steps.length) * 100}%`, background: d.primary_color }} />
                </div>
              </div>
            )}
            <div className={narrow ? 'grid grid-cols-1 gap-3.5' : 'grid grid-cols-2 gap-3.5'}>
              {visible.length === 0 && <p style={muted} className="col-span-full">No fields on this step yet.</p>}
              {visible.map((f) => (
                <div
                  key={f.id}
                  className={`${narrow || f.width === 'full' || d.label_position === 'left' ? 'col-span-full' : ''} min-w-0 rounded-md transition ${
                    selectedId === f.id ? 'outline outline-2 outline-offset-4' : ''
                  }`}
                  style={selectedId === f.id ? { outlineColor: d.primary_color } : undefined}
                  onClickCapture={() => onSelect?.(f.id)}
                >
                  <PreviewField key={f.default_country ?? ''} f={f}value={valueOf(f)} onChange={(v) => set(f.id, v)} inputStyle={inputStyle} labelPos={narrow && d.label_position === 'left' ? 'top' : d.label_position} primary={d.primary_color} countries={countries} defaultCountry={meta?.default_country ?? null} />
                </div>
              ))}
            </div>
            {def.settings.subscribe_on_submit.length > 0 && def.settings.consent_text && step === last && (
              <p className="mt-3" style={muted}>
                {def.settings.consent_text}
              </p>
            )}
            <div className="mt-5 flex items-center gap-2">
              {step > 0 && (
                <button type="button" onClick={() => setStepIdx(step - 1)} className="px-4 py-2.5 text-sm font-medium" style={{ ...inputStyle, width: 'auto', padding: '10px 16px' }}>
                  Back
                </button>
              )}
              <button
                type="submit"
                className="flex-1 px-4 py-2.5 text-sm font-semibold transition hover:opacity-90"
                style={{ background: d.button_color, color: d.button_text_color, borderRadius: d.radius }}
              >
                {step < last ? 'Next' : d.button_text || 'Submit'}
              </button>
            </div>
          </form>
        )}
        {(meta?.branding ?? false) && (
          <p className="mt-4 text-center" style={{ ...muted, fontSize: 11 }}>
            Powered by <strong>Signalcraft</strong>
          </p>
        )}
      </div>
    </div>
  )
}

function PreviewField({
  f,
  value,
  onChange,
  inputStyle,
  labelPos,
  primary,
  countries,
  defaultCountry,
}: {
  f: FormField
  value: unknown
  onChange: (v: unknown) => void
  inputStyle: CSSProperties
  labelPos: 'top' | 'left' | 'hidden'
  primary: string
  countries: { code: string; name: string; dial: string }[]
  defaultCountry: string | null
}) {
  const id = `pv_${f.id}`
  const label = f.label || '(no label)'
  const req = f.required ? <span aria-hidden style={{ color: '#dc2626' }}> *</span> : null
  const placeholder = f.placeholder || (labelPos === 'hidden' ? f.label : '')
  const str = typeof value === 'string' ? value : value == null ? '' : String(value)
  const [country, setCountry] = useState(f.default_country || defaultCountry || 'IN')
  const help = f.help ? (
    <p className="mt-1" style={{ opacity: 0.65, fontSize: 12 }}>
      {f.help}
    </p>
  ) : null

  if (f.type === 'consent') {
    return (
      <div>
        <label htmlFor={id} className="flex items-start gap-2 text-sm">
          <input id={id} type="checkbox" required={f.required} checked={!!value} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0" style={{ accentColor: primary }} />
          <span>
            {label}
            {req}
            {f.privacy_url && (
              <>
                {' '}
                <a href={f.privacy_url} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: primary }}>
                  Privacy policy
                </a>
              </>
            )}
          </span>
        </label>
        {help}
      </div>
    )
  }

  let control
  switch (f.type) {
    case 'textarea':
      control = <textarea id={id} required={f.required} placeholder={placeholder} value={str} onChange={(e) => onChange(e.target.value)} rows={4} style={{ ...inputStyle, resize: 'vertical' }} maxLength={f.max_length ?? undefined} />
      break
    case 'select':
      control = (
        <select id={id} required={f.required} value={str} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
          <option value="">{f.placeholder || 'Choose…'}</option>
          {f.options.map((o, i) => (
            <option key={`${o.value}-${i}`} value={o.value || o.label}>
              {o.label}
            </option>
          ))}
        </select>
      )
      break
    case 'radio':
    case 'checkboxes': {
      const arr = Array.isArray(value) ? (value as string[]) : []
      control = (
        <div role={f.type === 'radio' ? 'radiogroup' : 'group'} aria-labelledby={`${id}_l`} className="space-y-1.5">
          {f.options.map((o, i) => {
            const v = o.value || o.label
            const oid = `${id}_${i}`
            return (
              <label key={oid} htmlFor={oid} className="flex items-center gap-2 text-sm">
                <input
                  id={oid}
                  type={f.type === 'radio' ? 'radio' : 'checkbox'}
                  name={id}
                  required={f.type === 'radio' && f.required}
                  checked={f.type === 'radio' ? str === v : arr.includes(v)}
                  onChange={(e) => onChange(f.type === 'radio' ? v : e.target.checked ? [...arr, v] : arr.filter((x) => x !== v))}
                  className="size-4 shrink-0"
                  style={{ accentColor: primary }}
                />
                {o.label}
              </label>
            )
          })}
        </div>
      )
      break
    }
    case 'phone':
      control = (
        <div className="flex gap-2">
          <select aria-label="Country code" value={country} onChange={(e) => setCountry(e.target.value)} style={{ ...inputStyle, width: 96, flex: 'none' }}>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} {c.dial}
              </option>
            ))}
          </select>
          <input id={id} type="tel" inputMode="tel" required={f.required} placeholder={placeholder} value={str} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
        </div>
      )
      break
    default: {
      const type = f.type === 'email' ? 'email' : f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'
      control = (
        <input
          id={id}
          type={type}
          required={f.required}
          placeholder={placeholder}
          value={str}
          min={f.type === 'number' ? (f.min ?? undefined) : undefined}
          max={f.type === 'number' ? (f.max ?? undefined) : undefined}
          maxLength={f.max_length ?? undefined}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        />
      )
    }
  }

  const labelEl = (
    <label id={`${id}_l`} htmlFor={f.type === 'radio' || f.type === 'checkboxes' ? undefined : id} className={labelPos === 'hidden' ? 'sr-only' : 'mb-1.5 block text-sm font-medium'}>
      {label}
      {req}
    </label>
  )
  if (labelPos === 'left')
    return (
      <div className="grid grid-cols-[minmax(0,35%)_minmax(0,1fr)] items-start gap-3">
        <div className="pt-2">{labelEl}</div>
        <div className="min-w-0">
          {control}
          {help}
        </div>
      </div>
    )
  return (
    <div>
      {labelEl}
      {control}
      {help}
    </div>
  )
}
