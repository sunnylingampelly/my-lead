import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AuthLayout } from '@/layouts/AuthLayout'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/form-controls'
import { PasswordInput, PasswordStrength } from '@/components/ui/password-input'
import { authApi, invitationApi } from '@/api/services'
import { useAuth } from '@/hooks/useAuth'
import { applyServerErrors, emailSchema, passwordSchema } from '@/lib/forms'
import { ApiError } from '@/api/client'

const schema = z.object({
  full_name: z.string().trim().min(1, 'Your name is required').max(150),
  email: emailSchema,
  password: passwordSchema,
})
type Values = z.infer<typeof schema>

export function RegisterPage() {
  const { acceptAuth } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const inviteToken = params.get('invite') ?? undefined
  const invite = useQuery({
    queryKey: ['invite-preview', inviteToken],
    queryFn: () => invitationApi.preview(inviteToken!),
    enabled: !!inviteToken,
    retry: false,
  })

  const { register, handleSubmit, formState, setError, watch } = useForm<Values>({
    resolver: zodResolver(schema),
    values: invite.data ? { full_name: '', email: invite.data.email, password: '' } : undefined,
    resetOptions: { keepDirtyValues: true },
  })

  const onSubmit = handleSubmit(async (values) => {
    try {
      const res = await authApi.register({ ...values, invitation_token: inviteToken })
      acceptAuth(res)
      navigate(res.user.email_verified ? '/' : '/verify-email-sent', { replace: true })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'EMAIL_TAKEN') {
        setError('email', { message: 'An account with this email already exists. Sign in instead.' })
        return
      }
      applyServerErrors(e, setError, ['full_name', 'email', 'password'])
    }
  })

  return (
    <AuthLayout
      title={invite.data ? `Join ${invite.data.organization_name}` : 'Create your account'}
      subtitle={
        invite.data
          ? `You've been invited as ${invite.data.role_label}.`
          : 'Start with a free workspace. No card required.'
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Full name" htmlFor="full_name" error={formState.errors.full_name?.message}>
          <Input id="full_name" autoComplete="name" autoFocus {...register('full_name')} aria-invalid={!!formState.errors.full_name} />
        </Field>
        <Field label="Work email" htmlFor="email" error={formState.errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            readOnly={!!invite.data}
            {...register('email')}
            aria-invalid={!!formState.errors.email}
          />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          error={formState.errors.password?.message}
          hint="At least 10 characters with a letter and a number."
        >
          <PasswordInput id="password" autoComplete="new-password" {...register('password')} aria-invalid={!!formState.errors.password} />
          <PasswordStrength value={watch('password') ?? ''} />
        </Field>
        <Button type="submit" className="w-full" loading={formState.isSubmitting}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link to={inviteToken ? `/login?next=${encodeURIComponent(`/invite?token=${inviteToken}`)}` : '/login'} className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  )
}
