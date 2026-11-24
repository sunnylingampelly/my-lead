import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AuthLayout } from '@/layouts/AuthLayout'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { appApi, orgApi } from '@/api/services'
import { qk, useOrganizations } from '@/api/queries'
import { applyServerErrors } from '@/lib/forms'
import { useAuth } from '@/hooks/useAuth'
import { ApplicationForm } from '@/modules/applications/ApplicationForm'
import { FullPageSpinner } from '@/components/page'
import { browserCountry, OTHER_COUNTRIES, PRIMARY_COUNTRIES } from '@/lib/regions'

const INDUSTRIES = ['E-commerce', 'Education', 'Financial services', 'Healthcare', 'Real estate', 'SaaS', 'Travel', 'Other']

const orgSchema = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(120),
  industry: z.string().optional(),
  website: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^https?:\/\/\S+\.\S+/.test(v), 'Use a full URL such as https://example.com'),
  country: z.string().length(2, 'Choose your primary market'),
})

function Steps({ step }: { step: 1 | 2 }) {
  return (
    <div className="mb-6 flex items-center gap-2 text-xs font-medium text-muted-foreground">
      <span className={step === 1 ? 'text-primary' : ''}>1. Organization</span>
      <span className="h-px w-6 bg-border" />
      <span className={step === 2 ? 'text-primary' : ''}>2. First application</span>
    </div>
  )
}

export function CreateOrganizationPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user, setUser } = useAuth()
  const orgs = useOrganizations()
  const { register, handleSubmit, formState, setError } = useForm<z.infer<typeof orgSchema>>({
    resolver: zodResolver(orgSchema),
    defaultValues: { country: ['IN', 'US'].includes(browserCountry() ?? '') ? browserCountry()! : 'IN' },
  })

  if (user && !user.email_verified) return <Navigate to="/verify-email-sent" replace />

  const onSubmit = handleSubmit(async (v) => {
    try {
      const org = await orgApi.create({ name: v.name, industry: v.industry || null, website: v.website || null, country: v.country })
      await qc.invalidateQueries({ queryKey: qk.orgs })
      if (user) setUser({ ...user, last_organization_id: org.id, last_application_id: null })
      navigate(`/onboarding/application?org=${org.id}`, { replace: true })
    } catch (e) {
      applyServerErrors(e, setError, ['name', 'industry', 'website', 'country'])
    }
  })

  const first = !orgs.data?.length
  return (
    <AuthLayout
      title={first ? 'Set up your organization' : 'Create another organization'}
      subtitle="Organizations hold your team, billing and applications."
    >
      {first && <Steps step={1} />}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Organization name" htmlFor="org-name" error={formState.errors.name?.message}>
          <Input id="org-name" autoFocus placeholder="Acme Inc." {...register('name')} aria-invalid={!!formState.errors.name} />
        </Field>
        <Field
          label="Primary market"
          htmlFor="org-country"
          error={formState.errors.country?.message}
          hint="Sets defaults for phone numbers, timezones, date formats and compliance rules (TRAI DLT in India; TCPA and CAN-SPAM in the US)."
        >
          <Select id="org-country" {...register('country')}>
            <optgroup label="Fully supported">
              {PRIMARY_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Other (strictest defaults)">
              {OTHER_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
        <Field label="Industry" htmlFor="org-industry">
          <Select id="org-industry" defaultValue="" {...register('industry')}>
            <option value="">Select an industry (optional)</option>
            {INDUSTRIES.map((i) => (
              <option key={i}>{i}</option>
            ))}
          </Select>
        </Field>
        <Field label="Website" htmlFor="org-website" error={formState.errors.website?.message}>
          <Input id="org-website" placeholder="https://acme.com" {...register('website')} />
        </Field>
        <div className="flex gap-2">
          {!first && (
            <Button type="button" variant="outline" onClick={() => navigate(-1)}>
              Cancel
            </Button>
          )}
          <Button type="submit" className="flex-1" loading={formState.isSubmitting}>
            Continue
          </Button>
        </div>
      </form>
    </AuthLayout>
  )
}

export function CreateApplicationPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user, setUser } = useAuth()
  const orgs = useOrganizations()
  const orgId = params.get('org') ?? user?.last_organization_id ?? orgs.data?.[0]?.id

  if (orgs.isLoading) return <FullPageSpinner />
  const org = orgs.data?.find((o) => o.id === orgId)
  if (!org) return <Navigate to="/onboarding/organization" replace />
  const first = org.application_count === 0

  return (
    <AuthLayout
      title={first ? 'Create your first application' : `New application in ${org.name}`}
      subtitle="An application is one brand or product with its own contacts, campaigns and settings. You can add more later."
    >
      {first && <Steps step={2} />}
      {!org.permissions.includes('apps.create') ? (
        <p className="text-sm text-destructive">Your role in {org.name} cannot create applications.</p>
      ) : (
        <ApplicationForm
          defaultValues={{ default_country: org.country ?? browserCountry() ?? 'IN' }}
          compactTimezone
          submitLabel="Create application"
          onSubmit={async (values) => {
            const app = await appApi.create({ ...values, organization_id: org.id })
            await qc.invalidateQueries({ queryKey: ['apps'] })
            await qc.invalidateQueries({ queryKey: qk.orgs })
            if (user) setUser({ ...user, last_organization_id: org.id, last_application_id: app.id })
            toast.success(`${app.name} is ready`)
            navigate(`/apps/${app.id}`, { replace: true })
          }}
        />
      )}
      {!first && (
        <Button variant="ghost" className="mt-3 w-full" onClick={() => navigate(-1)}>
          Cancel
        </Button>
      )}
    </AuthLayout>
  )
}
