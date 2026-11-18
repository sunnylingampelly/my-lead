import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useState } from 'react'
import { AlertCircle } from 'lucide-react'
import { AuthLayout } from '@/layouts/AuthLayout'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/form-controls'
import { PasswordInput } from '@/components/ui/password-input'
import { authApi } from '@/api/services'
import { errorMessage } from '@/api/client'
import { useAuth } from '@/hooks/useAuth'
import { emailSchema } from '@/lib/forms'

const schema = z.object({ email: emailSchema, password: z.string().min(1, 'Password is required') })
type Values = z.infer<typeof schema>

export function LoginPage() {
  const { acceptAuth } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const { register, handleSubmit, formState } = useForm<Values>({ resolver: zodResolver(schema) })

  const onSubmit = handleSubmit(async (values) => {
    setError(null)
    try {
      acceptAuth(await authApi.login(values))
      navigate(params.get('next') || '/', { replace: true })
    } catch (e) {
      setError(errorMessage(e))
    }
  })

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your workspace.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-soft p-3 text-sm text-danger-strong">
            <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
          </div>
        )}
        <Field label="Email" htmlFor="email" error={formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" autoFocus {...register('email')} aria-invalid={!!formState.errors.email} />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          error={formState.errors.password?.message}
          action={
            <Link to="/forgot-password" className="text-xs font-medium text-primary hover:underline">
              Forgot password?
            </Link>
          }
        >
          <PasswordInput id="password" autoComplete="current-password" {...register('password')} aria-invalid={!!formState.errors.password} />
        </Field>
        <Button type="submit" className="w-full" loading={formState.isSubmitting}>
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        New here?{' '}
        <Link to="/register" className="font-medium text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  )
}
