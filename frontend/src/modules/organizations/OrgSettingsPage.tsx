import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { qk } from '@/api/queries'
import { orgApi } from '@/api/services'
import { PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { useWorkspace } from '@/hooks/useWorkspace'
import { applyServerErrors } from '@/lib/forms'
import { formatDate } from '@/lib/utils'

const schema = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(120),
  industry: z.string().max(80).optional(),
  website: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^https?:\/\/\S+\.\S+/.test(v), 'Use a full URL such as https://example.com'),
  country: z
    .string()
    .trim()
    .regex(/^([A-Za-z]{2})?$/, 'Use a 2-letter country code')
    .optional(),
})

export function OrgSettingsPage() {
  const { org, canOrg } = useWorkspace()
  const qc = useQueryClient()
  const editable = canOrg('org.update')
  const { register, handleSubmit, formState, setError, reset } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    values: org
      ? { name: org.name, industry: org.industry ?? '', website: org.website ?? '', country: org.country ?? '' }
      : undefined,
  })
  if (!org) return null

  const submit = handleSubmit(async (v) => {
    try {
      const updated = await orgApi.update(org.id, {
        name: v.name,
        industry: v.industry || null,
        website: v.website || null,
        country: v.country ? v.country.toUpperCase() : null,
      })
      await qc.invalidateQueries({ queryKey: qk.orgs })
      reset({ name: updated.name, industry: updated.industry ?? '', website: updated.website ?? '', country: updated.country ?? '' })
      toast.success('Organization updated')
    } catch (e) {
      applyServerErrors(e, setError, ['name', 'industry', 'website', 'country'])
    }
  })

  return (
    <>
      <PageHeader breadcrumbs={[{ label: org.name }, { label: 'Organization' }]} title="Organization settings" />
      <div className="grid gap-6 lg:grid-cols-3">
        <form onSubmit={submit} className="lg:col-span-2" noValidate>
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>Shown to teammates and on invitations.</CardDescription>
            </CardHeader>
            <CardContent>
              <fieldset disabled={!editable} className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" htmlFor="o-name" error={formState.errors.name?.message} className="sm:col-span-2">
                  <Input id="o-name" {...register('name')} aria-invalid={!!formState.errors.name} />
                </Field>
                <Field label="Industry" htmlFor="o-ind">
                  <Input id="o-ind" {...register('industry')} />
                </Field>
                <Field label="Country" htmlFor="o-country" error={formState.errors.country?.message}>
                  <Input id="o-country" maxLength={2} className="uppercase" {...register('country')} />
                </Field>
                <Field label="Website" htmlFor="o-web" error={formState.errors.website?.message} className="sm:col-span-2">
                  <Input id="o-web" {...register('website')} />
                </Field>
              </fieldset>
            </CardContent>
            {editable && (
              <CardFooter>
                <Button type="submit" loading={formState.isSubmitting} disabled={!formState.isDirty}>
                  Save changes
                </Button>
              </CardFooter>
            )}
          </Card>
        </form>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Your role</dt>
                <dd>
                  <Badge>{org.role_label}</Badge>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Status</dt>
                <dd className="capitalize">{org.status}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Applications</dt>
                <dd>{org.application_count}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Created</dt>
                <dd>{formatDate(org.created_at)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">ID</dt>
                <dd className="truncate font-mono text-xs">{org.id}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
