import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { applyServerErrors } from '@/lib/forms'
import { APP_COLORS, cn } from '@/lib/utils'
import type { AppInput } from '@/api/services'
import { TIMEZONES, browserTimezone } from '@/lib/timezones'
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
}

export function ApplicationForm({ defaultValues, submitLabel, onSubmit, disabled }: Props) {
  const { register, handleSubmit, formState, setError, watch, setValue } = useForm<AppFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '', color: 'indigo', timezone: browserTimezone(), default_country: '', ...defaultValues },
  })
  const color = watch('color')

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
        <Field label="Application name" htmlFor="app-name" error={formState.errors.name?.message} hint="For example a brand, product or region.">
          <Input id="app-name" placeholder="Acme Retail" {...register('name')} aria-invalid={!!formState.errors.name} />
        </Field>
        <Field label="Description" htmlFor="app-description" error={formState.errors.description?.message}>
          <Textarea id="app-description" rows={2} placeholder="Optional" {...register('description')} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Timezone" htmlFor="app-tz" hint="Used for scheduling and reports.">
            <Select id="app-tz" {...register('timezone')}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </Field>
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
                  const tz = { IN: 'Asia/Kolkata', US: 'America/New_York' }[e.target.value as string]
                  if (tz && !formState.dirtyFields.timezone) setValue('timezone', tz)
                },
              })}
            >
              <option value="">None (require +country codes)</option>
              <optgroup label="Fully supported">
                {PRIMARY_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.flag} {c.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Other">
                {OTHER_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.flag} {c.name}
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
