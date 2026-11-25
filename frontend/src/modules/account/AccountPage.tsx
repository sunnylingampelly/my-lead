import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Laptop, LogOut } from 'lucide-react'
import { qk, useSessions } from '@/api/queries'
import { userApi } from '@/api/services'
import { errorMessage } from '@/api/client'
import { ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { PasswordInput, PasswordStrength } from '@/components/ui/password-input'
import { Badge } from '@/components/ui/misc'
import { useAuth, useUser } from '@/hooks/useAuth'
import { applyServerErrors, passwordSchema } from '@/lib/forms'
import { timeAgo } from '@/lib/utils'
import { TIMEZONES } from '@/lib/timezones'
import { TwoFactorCard } from './TwoFactorCard'

const profileSchema = z.object({ full_name: z.string().trim().min(1, 'Required').max(150), timezone: z.string() })
const pwSchema = z
  .object({ current_password: z.string().min(1, 'Required'), new_password: passwordSchema, confirm: z.string() })
  .refine((v) => v.new_password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' })

function describeAgent(ua: string | null) {
  if (!ua) return 'Unknown device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} on ${os}` : browser
}

export function AccountPage() {
  const user = useUser()
  const { setUser } = useAuth()
  const qc = useQueryClient()
  const sessions = useSessions()

  const profile = useForm<z.infer<typeof profileSchema>>({
    resolver: zodResolver(profileSchema),
    values: { full_name: user.full_name, timezone: user.timezone },
  })
  const pw = useForm<z.infer<typeof pwSchema>>({ resolver: zodResolver(pwSchema) })

  return (
    <>
      <PageHeader title="Account" description="Your personal profile and security settings." breadcrumbs={[{ label: 'Account' }]} />
      <div className="grid max-w-3xl gap-6">
        <form
          noValidate
          onSubmit={profile.handleSubmit(async (v) => {
            try {
              setUser(await userApi.update(v))
              toast.success('Profile updated')
            } catch (e) {
              applyServerErrors(e, profile.setError, ['full_name', 'timezone'])
            }
          })}
        >
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
              <CardDescription>
                Signed in as {user.email}{' '}
                {user.email_verified ? <Badge variant="success">Verified</Badge> : <Badge variant="warning">Unverified</Badge>}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name" htmlFor="full_name" error={profile.formState.errors.full_name?.message}>
                <Input id="full_name" {...profile.register('full_name')} />
              </Field>
              <Field label="Timezone" htmlFor="tz">
                <Select id="tz" {...profile.register('timezone')}>
                  {TIMEZONES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
              </Field>
            </CardContent>
            <CardFooter>
              <Button type="submit" loading={profile.formState.isSubmitting} disabled={!profile.formState.isDirty}>
                Save profile
              </Button>
            </CardFooter>
          </Card>
        </form>

        <TwoFactorCard />

        <form
          noValidate
          onSubmit={pw.handleSubmit(async (v) => {
            try {
              const r = await userApi.changePassword({ current_password: v.current_password, new_password: v.new_password })
              pw.reset({ current_password: '', new_password: '', confirm: '' })
              await qc.invalidateQueries({ queryKey: qk.sessions })
              toast.success(r.message)
            } catch (e) {
              applyServerErrors(e, pw.setError, ['current_password', 'new_password'])
            }
          })}
        >
          <Card>
            <CardHeader>
              <CardTitle>Password</CardTitle>
              <CardDescription>Changing your password signs out all other sessions.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <Field label="Current password" htmlFor="cur" error={pw.formState.errors.current_password?.message}>
                <PasswordInput id="cur" autoComplete="current-password" {...pw.register('current_password')} />
              </Field>
              <Field label="New password" htmlFor="new" error={pw.formState.errors.new_password?.message}>
                <PasswordInput id="new" autoComplete="new-password" {...pw.register('new_password')} />
                <PasswordStrength value={pw.watch('new_password') ?? ''} />
              </Field>
              <Field label="Confirm" htmlFor="conf" error={pw.formState.errors.confirm?.message}>
                <PasswordInput id="conf" autoComplete="new-password" {...pw.register('confirm')} />
              </Field>
            </CardContent>
            <CardFooter>
              <Button type="submit" loading={pw.formState.isSubmitting}>
                Change password
              </Button>
            </CardFooter>
          </Card>
        </form>

        <Card>
          <CardHeader>
            <CardTitle>Active sessions</CardTitle>
            <CardDescription>Devices currently signed in to your account.</CardDescription>
          </CardHeader>
          {sessions.isLoading ? (
            <LoadingRows rows={2} />
          ) : sessions.isError ? (
            <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />
          ) : (
            <ul className="divide-y border-t">
              {sessions.data?.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                  <Laptop className="size-5 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {describeAgent(s.user_agent)} {s.current && <Badge variant="success">This device</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {s.ip_address ?? 'Unknown IP'} · signed in {timeAgo(s.created_at)}
                    </div>
                  </div>
                  {!s.current && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        try {
                          await userApi.revokeSession(s.id)
                          await qc.invalidateQueries({ queryKey: qk.sessions })
                          toast.success('Session signed out')
                        } catch (e) {
                          toast.error(errorMessage(e))
                        }
                      }}
                    >
                      <LogOut /> Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}
