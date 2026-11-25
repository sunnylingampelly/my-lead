import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { applyServerErrors } from '@/lib/forms'
import { APP_COLORS, cn } from '@/lib/utils'
import type { AppInput } from '@/api/services'
import { COUNTRY_DEFAULT_TIMEZONE, TIMEZONES, timezoneForCountry, timezoneInCountry } from '@/lib/timezones'
import { OTHER_COUNTRIES, PRIMARY_COUNTRIES } from '@/lib/regions'

const schema = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(120),
  description: z.string().max(1000).optional(),
  color: z.string(),
  timezone: z.string().min(1),
  default_country: z.string().max(2).optional(),
})
export type AppFormValues = z.infer<typeof schema>


interface Props {
  defaultValues?: Partial<AppFormValues>
  submitLabel: string
  onSubmit: (values: AppInput) => Promise<unknown>
  disabled?: boolean
  /** Onboarding: show the timezone as one editable line instead of a full field. */
  compactTimezone?: boolean
}

export function ApplicationForm({ defaultValues, submitLabel, onSubmit, disabled, compactTimezone }: Props) {
  const { register, handleSubmit, formState, setError, watch, setValue } = useForm<AppFormValues>({
    resolver: zodResolver(schema),
    // A new application's timezone follows its country unless the browser is already in that country
    // (a US app created from an Indian browser starts in America/New_York, not Asia/Kolkata).
    defaultValues: {
      name: '',
      description: '',
      color: 'indigo',
      default_country: '',
      ...defaultValues,
      timezone: defaultValues?.timezone ?? timezoneForCountry(defaultValues?.default_country),
    },
  })
  const color = watch('color')
  const timezone = watch('timezone')
  const [editTz, setEditTz] = useState(!compactTimezone)

  const submit = handleSubmit(async (v) => {
    try {
      await onSubmit({
        name: v.name,
        description: v.description || null,
        color: v.color,
        timezone: v.timezone,
        default_country: v.default_country ? v.default_country.toUpperCase() : null,
      })
    } catch (e) {
      applyServerErrors(e, setError, ['name', 'description', 'timezone', 'default_country'])
    }
  })

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <fieldset disabled={disabled} className="space-y-4">
        <Field label="Application name" htmlFor="app-name" error={formState.errors.name?.message} hint="One brand or product with its own contacts, campaigns and settings. You can add more later.">
          <Input id="app-name" placeholder="Acme Retail" {...register('name')} aria-invalid={!!formState.errors.name} />
        </Field>
        <Field label="Description" htmlFor="app-description" error={formState.errors.description?.message}>
          <Textarea id="app-description" rows={2} placeholder="Optional" {...register('description')} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          {editTz ? (
            <Field label="Timezone" htmlFor="app-tz" hint="Used for scheduling and reports.">
              <Select id="app-tz" {...register('timezone')}>
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <div className="space-y-1.5 sm:order-last sm:col-span-2" data-testid="timezone-line">
              <span className="text-sm">
                Timezone: <span className="font-medium">{timezone}</span>{' '}
                <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => setEditTz(true)}>
                  Change
                </button>
              </span>
              <p className="text-xs text-muted-foreground">Used for scheduling and reports.</p>
            </div>
          )}
          <Field
            label="Default country"
            htmlFor="app-country"
            error={formState.errors.default_country?.message}
            hint="Numbers without a country code are read as this country. Also sets compliance defaults."
          >
            <Select
              id="app-country"
              {...register('default_country', {
                onChange: (e) => {
                  const c = e.target.value as string
                  const tz = COUNTRY_DEFAULT_TIMEZONE[c]
                  if (tz && !formState.dirtyFields.timezone && !timezoneInCountry(timezone, c)) setValue('timezone', timezoneForCountry(c))
                },
              })}
            >
              <option value="">None (require +country codes)</option>
              <optgroup label="Fully supported">
                {PRIMARY_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Other">
                {OTHER_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            </Select>
          </Field>
        </div>
        <div className="space-y-1.5">
          <span className="text-sm font-medium">Color</span>
          <div className="flex gap-2" role="radiogroup" aria-label="Color">
            {Object.entries(APP_COLORS).map(([name, cls]) => (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={color === name}
                aria-label={name}
                onClick={() => setValue('color', name, { shouldDirty: true })}
                className={cn('size-6 rounded-full ring-offset-2 transition', cls, color === name ? 'ring-2 ring-foreground' : 'opacity-70 hover:opacity-100')}
              />
            ))}
          </div>
        </div>
      </fieldset>
      {!disabled && (
        <Button type="submit" loading={formState.isSubmitting} className="w-full sm:w-auto">
          {submitLabel}
        </Button>
      )}
    </form>
  )
}
