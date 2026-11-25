/** Properties of the selected field. */
import { ArrowDown, ArrowUp, Copy, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input, Label, Select, Textarea } from '@/components/ui/form-controls'
import { Checkbox } from '@/components/audience'
import { ALL_COUNTRIES } from '@/lib/regions'
import type { Channel, ConditionOp, FieldMap, FormField, FormsMeta, FormStep, HiddenKind } from '@/types/forms'
import { CHANNEL_LABEL, CHOICE_TYPES, CONDITION_OPS, FIELD_META, HIDDEN_KINDS } from './meta'
import { Segmented, Switch, UrlInput } from './ui'

const numOrNull = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v))

export function FieldInspector({
  field: f,
  fields,
  steps,
  meta,
  onChange,
  onDuplicate,
  onRemove,
}: {
  field: FormField
  fields: FormField[]
  steps: FormStep[]
  meta?: FormsMeta
  onChange: (p: Partial<FormField>) => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const M = FIELD_META[f.type]
  const choice = CHOICE_TYPES.includes(f.type)
  const hidden = f.type === 'hidden'
  const consent = f.type === 'consent'
  const hasPlaceholder = !choice && !hidden && !consent && f.type !== 'date'
  const others = fields.filter((x) => x.id !== f.id)
  const condSource = others.find((x) => x.id === f.condition?.field)
  const countries = meta?.countries?.length ? meta.countries : ALL_COUNTRIES

  const setOption = (i: number, p: Partial<{ label: string; value: string }>) => onChange({ options: f.options.map((o, j) => (j === i ? { ...o, ...p } : o)) })
  const moveOption = (i: number, dir: -1 | 1) => {
    const o = [...f.options]
    const j = i + dir
    if (j < 0 || j >= o.length) return
    ;[o[i], o[j]] = [o[j]!, o[i]!]
    onChange({ options: o })
  }

  return (
    <Card data-testid="field-inspector">
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <M.icon className="size-4 text-primary" /> {M.label}
          </CardTitle>
          <p className="mt-1 truncate text-xs text-muted-foreground" title="Used in exports and URL pre-fill">
            Field ID: <code className="font-mono">{f.id}</code>
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="icon" className="size-8" aria-label="Duplicate field" onClick={onDuplicate}>
            <Copy />
          </Button>
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground hover:text-destructive" aria-label="Delete field" onClick={onRemove}>
            <Trash2 />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {consent ? (
          <Field label="Consent text" htmlFor="fi-label">
            <Textarea id="fi-label" value={f.label} maxLength={300} onChange={(e) => onChange({ label: e.target.value })} rows={3} />
          </Field>
        ) : (
          <Field label={hidden ? 'Name (for your team)' : 'Label'} htmlFor="fi-label">
            <Input id="fi-label" value={f.label} maxLength={300} onChange={(e) => onChange({ label: e.target.value })} />
          </Field>
        )}
        {hasPlaceholder && (
          <Field label="Placeholder" htmlFor="fi-ph">
            <Input id="fi-ph" value={f.placeholder} maxLength={200} onChange={(e) => onChange({ placeholder: e.target.value })} />
          </Field>
        )}
        {f.type === 'select' && (
          <Field label="Prompt" htmlFor="fi-ph" hint="The first, empty choice, e.g. “Choose…”.">
            <Input id="fi-ph" value={f.placeholder} maxLength={200} onChange={(e) => onChange({ placeholder: e.target.value })} placeholder="Choose…" />
          </Field>
        )}
        {!hidden && (
          <Field label="Help text" htmlFor="fi-help">
            <Input id="fi-help" value={f.help} maxLength={500} onChange={(e) => onChange({ help: e.target.value })} placeholder="Shown under the field" />
          </Field>
        )}
        {!hidden && <Switch id="fi-required" label="Required" checked={f.required} onChange={(v) => onChange({ required: v })} />}

        {!hidden && (
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <span className="block text-sm font-medium">Width</span>
              <Segmented
                label="Width"
                value={f.width}
                onChange={(v) => onChange({ width: v })}
                options={[
                  ['full', 'Full'],
                  ['half', 'Half'],
                ]}
              />
            </div>
            {steps.length > 1 && (
              <Field label="Step" htmlFor="fi-step" className="min-w-[8rem] flex-1">
                <Select id="fi-step" value={Math.min(f.step, steps.length - 1)} onChange={(e) => onChange({ step: Number(e.target.value) })}>
                  {steps.map((s, i) => (
                    <option key={s.id} value={i}>
                      {s.title || `Step ${i + 1}`}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        )}

        {choice && (
          <div className="space-y-2">
            <Label>Options</Label>
            <ul className="space-y-1.5">
              {f.options.map((o, i) => (
                <li key={i} className="flex items-center gap-1">
                  <Input aria-label={`Option ${i + 1} label`} value={o.label} maxLength={200} className="h-8 min-w-0" onChange={(e) => setOption(i, { label: e.target.value, ...(o.value === o.label && { value: e.target.value }) })} />
                  <Input aria-label={`Option ${i + 1} value`} value={o.value} maxLength={200} className="h-8 w-20 min-w-0 shrink-0 font-mono text-xs sm:w-24" placeholder="value" title="Stored value (defaults to the label)" onChange={(e) => setOption(i, { value: e.target.value })} />
                  <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`Move option ${i + 1} up`} disabled={i === 0} onClick={() => moveOption(i, -1)}>
                    <ArrowUp />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`Move option ${i + 1} down`} disabled={i === f.options.length - 1} onClick={() => moveOption(i, 1)}>
                    <ArrowDown />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`Remove option ${i + 1}`} disabled={f.options.length <= 1} onClick={() => onChange({ options: f.options.filter((_, j) => j !== i) })}>
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="outline"
              disabled={f.options.length >= 100}
              onClick={() => {
                const label = `Option ${f.options.length + 1}`
                onChange({ options: [...f.options, { label, value: label }] })
              }}
            >
              <Plus /> Add option
            </Button>
          </div>
        )}

        {hidden ? (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Hidden fields are filled automatically and never shown to visitors.</p>
            <Field label="Value comes from" htmlFor="fi-hsrc">
              <Select id="fi-hsrc" value={f.hidden?.kind ?? 'fixed'} onChange={(e) => onChange({ hidden: { kind: e.target.value as HiddenKind, value: f.hidden?.value ?? '' } })}>
                {Object.entries(HIDDEN_KINDS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            {(f.hidden?.kind === 'fixed' || f.hidden?.kind === 'url_param' || !f.hidden) && (
              <Field label={f.hidden?.kind === 'url_param' ? 'URL parameter name' : 'Value'} htmlFor="fi-hval" hint={f.hidden?.kind === 'url_param' ? 'e.g. gclid reads ?gclid=… from the page address.' : undefined}>
                <Input id="fi-hval" value={f.hidden?.value ?? ''} maxLength={500} onChange={(e) => onChange({ hidden: { kind: f.hidden?.kind ?? 'fixed', value: e.target.value } })} />
              </Field>
            )}
          </div>
        ) : (
          !consent &&
          !choice && (
            <Field label="Default value" htmlFor="fi-default" hint="Pre-filled; visitors can change it. A ?field_id=value URL parameter also pre-fills.">
              <Input id="fi-default" value={f.default} maxLength={500} onChange={(e) => onChange({ default: e.target.value })} />
            </Field>
          )
        )}

        {consent && (
          <>
            <Field label="Privacy policy link" htmlFor="fi-privacy">
              <UrlInput id="fi-privacy" value={f.privacy_url} onChange={(v) => onChange({ privacy_url: v })} placeholder="https://example.com/privacy" />
            </Field>
            <div className="space-y-1.5">
              <span className="block text-sm font-medium">Ticking this grants consent for</span>
              <div className="flex flex-wrap gap-4">
                {(['email', 'sms', 'voice'] as Channel[]).map((c) => (
                  <label key={c} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={f.consent_channels.includes(c)}
                      onChange={(e) => onChange({ consent_channels: e.target.checked ? [...f.consent_channels, c] : f.consent_channels.filter((x) => x !== c) })}
                    />
                    {CHANNEL_LABEL[c]}
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

        {f.type === 'phone' && (
          <Field label="Default country" htmlFor="fi-country">
            <Select id="fi-country" value={f.default_country ?? ''} onChange={(e) => onChange({ default_country: e.target.value || null })}>
              <option value="">Application default{meta?.default_country ? ` (${meta.default_country})` : ''}</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.dial})
                </option>
              ))}
            </Select>
          </Field>
        )}

        {f.type === 'number' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Minimum" htmlFor="fi-min">
              <Input id="fi-min" type="number" value={f.min ?? ''} onChange={(e) => onChange({ min: numOrNull(e.target.value) })} />
            </Field>
            <Field label="Maximum" htmlFor="fi-max">
              <Input id="fi-max" type="number" value={f.max ?? ''} onChange={(e) => onChange({ max: numOrNull(e.target.value) })} />
            </Field>
          </div>
        )}
        {(f.type === 'text' || f.type === 'textarea') && (
          <Field label="Maximum length" htmlFor="fi-maxlen">
            <Input
              id="fi-maxlen"
              type="number"
              min={1}
              max={5000}
              value={f.max_length ?? ''}
              placeholder="No limit"
              onChange={(e) => {
                const n = numOrNull(e.target.value)
                onChange({ max_length: n === null ? null : Math.max(1, Math.min(5000, Math.round(n))) })
              }}
            />
          </Field>
        )}

        {!consent && <MapTo f={f} meta={meta} onChange={(map_to) => onChange({ map_to })} />}

        {!hidden && (
          <div className="space-y-3 rounded-md border p-3">
            <Switch
              id="fi-cond"
              label="Conditional logic"
              hint="Show this field only when another field matches."
              checked={!!f.condition}
              disabled={others.length === 0}
              onChange={(on) => onChange({ condition: on ? { field: others[0]!.id, op: 'equals', value: '' } : null })}
            />
            {f.condition && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Select aria-label="When field" value={f.condition.field} onChange={(e) => onChange({ condition: { ...f.condition!, field: e.target.value, value: '' } })}>
                  {others.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label || FIELD_META[x.type].label}
                    </option>
                  ))}
                </Select>
                <Select aria-label="Condition" value={f.condition.op} onChange={(e) => onChange({ condition: { ...f.condition!, op: e.target.value as ConditionOp } })}>
                  {Object.entries(CONDITION_OPS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
                {f.condition.op !== 'is_set' && f.condition.op !== 'is_not_set' &&
                  (condSource && CHOICE_TYPES.includes(condSource.type) ? (
                    <Select aria-label="Value" value={f.condition.value} onChange={(e) => onChange({ condition: { ...f.condition!, value: e.target.value } })}>
                      <option value="">Choose…</option>
                      {condSource.options.map((o, i) => (
                        <option key={i} value={o.value || o.label}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  ) : condSource?.type === 'consent' ? (
                    <Select aria-label="Value" value={f.condition.value} onChange={(e) => onChange({ condition: { ...f.condition!, value: e.target.value } })}>
                      <option value="">Choose…</option>
                      <option value="yes">Ticked</option>
                    </Select>
                  ) : (
                    <Input aria-label="Value" value={f.condition.value} maxLength={200} onChange={(e) => onChange({ condition: { ...f.condition!, value: e.target.value } })} placeholder="Value" />
                  ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function MapTo({ f, meta, onChange }: { f: FormField; meta?: FormsMeta; onChange: (m: FieldMap) => void }) {
  const m = f.map_to
  const standard = meta?.standard_fields ?? []
  const custom = meta?.custom_fields ?? []
  return (
    <div className="space-y-2 rounded-md border p-3">
      <Field label="Save to contact" htmlFor="fi-map" hint={m.kind === 'tag' ? (f.type === 'checkboxes' ? 'Every ticked option becomes a tag on the contact.' : 'The answer becomes a tag on the contact.') : m.kind === 'none' ? 'Kept with the submission only.' : undefined}>
        <Select
          id="fi-map"
          value={m.kind === 'none' || m.kind === 'tag' ? m.kind : `${m.kind}:${m.key}`}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'none' || v === 'tag') onChange({ kind: v, key: '' })
            else {
              const [kind, key] = v.split(/:(.*)/s) as ['standard' | 'custom', string]
              onChange({ kind, key })
            }
          }}
        >
          <option value="none">Don’t save to a contact field</option>
          <optgroup label="Contact fields">
            {standard.map((s) => (
              <option key={s.key} value={`standard:${s.key}`}>
                {s.label}
              </option>
            ))}
            {m.kind === 'standard' && !standard.some((s) => s.key === m.key) && <option value={`standard:${m.key}`}>{m.key}</option>}
          </optgroup>
          {(custom.length > 0 || m.kind === 'custom') && (
            <optgroup label="Custom fields">
              {custom.map((c) => (
                <option key={c.key} value={`custom:${c.key}`}>
                  {c.label}
                </option>
              ))}
              {m.kind === 'custom' && !custom.some((c) => c.key === m.key) && <option value={`custom:${m.key}`}>{m.key}</option>}
            </optgroup>
          )}
          <option value="tag">Add as a tag</option>
        </Select>
      </Field>
    </div>
  )
}
