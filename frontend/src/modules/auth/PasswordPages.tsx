import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { MailCheck } from 'lucide-react'
import { AuthLayout } from '@/layouts/AuthLayout'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/form-controls'
import { PasswordInput, PasswordStrength } from '@/components/ui/password-input'
import { authApi } from '@/api/services'
import { errorMessage } from '@/api/client'
import { applyServerErrors, emailSchema, passwordSchema } from '@/lib/forms'
import { DevMailboxHint } from '@/modules/dev/DevMailboxHint'

const forgotSchema = z.object({ email: emailSchema })

export function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string | null>(null)
  const { register, handleSubmit, formState } = useForm<z.infer<typeof forgotSchema>>({
    resolver: zodResolver(forgotSchema),
  })
  const onSubmit = handleSubmit(async ({ email }) => {
    try {
      await authApi.forgotPassword(email)
      setSentTo(email)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  })

  if (sentTo)
    return (
      <AuthLayout title="Check your email" subtitle={`If an account exists for ${sentTo}, a reset link is on its way.`}>
        <div className="flex size-12 items-center justify-center rounded-full bg-accent text-primary">
          <MailCheck className="size-6" />
        </div>
        <Button asChild variant="outline" className="mt-6 w-full">
          <Link to="/login">Back to sign in</Link>
        </Button>
        <DevMailboxHint email={sentTo} />
      </AuthLayout>
    )

  return (
    <AuthLayout title="Reset your password" subtitle="Enter your account email and we'll send you a reset link.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" htmlFor="email" error={formState.errors.email?.message}>
          <Input id="email" type="email" autoFocus autoComplete="email" {...register('email')} aria-invalid={!!formState.errors.email} />
        </Field>
        <Button type="submit" className="w-full" loading={formState.isSubmitting}>
          Send reset link
        </Button>
      </form>
      <p className="mt-6 text-center text-sm">
        <Link to="/login" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  )
}

const resetSchema = z
  .object({ new_password: passwordSchema, confirm: z.string() })
  .refine((v) => v.new_password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' })

export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const navigate = useNavigate()
  const { register, handleSubmit, formState, setError, watch } = useForm<z.infer<typeof resetSchema>>({
    resolver: zodResolver(resetSchema),
  })
  const onSubmit = handleSubmit(async ({ new_password }) => {
    try {
      const r = await authApi.resetPassword(token, new_password)
      toast.success(r.message)
      navigate('/login', { replace: true })
    } catch (e) {
      applyServerErrors(e, setError, ['new_password'])
    }
  })

  return (
    <AuthLayout title="Choose a new password" subtitle="Signing in again will be required on all your devices.">
      {!token ? (
        <p className="text-sm text-destructive">This link is missing its token. Request a new reset email.</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="New password" htmlFor="new_password" error={formState.errors.new_password?.message} hint="At least 10 characters with a letter and a number.">
            <PasswordInput id="new_password" autoComplete="new-password" autoFocus {...register('new_password')} aria-invalid={!!formState.errors.new_password} />
            <PasswordStrength value={watch('new_password') ?? ''} />
          </Field>
          <Field label="Confirm password" htmlFor="confirm" error={formState.errors.confirm?.message}>
            <PasswordInput id="confirm" autoComplete="new-password" {...register('confirm')} aria-invalid={!!formState.errors.confirm} />
          </Field>
          <Button type="submit" className="w-full" loading={formState.isSubmitting}>
            Update password
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}
