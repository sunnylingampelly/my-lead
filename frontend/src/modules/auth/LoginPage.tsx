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
import { ApiError, errorMessage } from '@/api/client'
import type { AuthResponse } from '@/types/api'
import { useAuth } from '@/hooks/useAuth'
import { emailSchema } from '@/lib/forms'

const schema = z.object({ email: emailSchema, password: z.string().min(1, 'Password is required') })
type Values = z.infer<typeof schema>

export function LoginPage() {
  const { acceptAuth } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [mfaToken, setMfaToken] = useState<string | null>(null)
  const { register, handleSubmit, formState } = useForm<Values>({ resolver: zodResolver(schema) })

  const finish = (res: AuthResponse) => {
    acceptAuth(res)
    // Owners/admins whose organization requires two-factor are taken straight to setup.
    const next = res.user.mfa_setup_required ? '/account?setup=1' : params.get('next') || '/'
    navigate(next, { replace: true })
  }

  const onSubmit = handleSubmit(async (values) => {
    setError(null)
    try {
      const res = await authApi.login(values)
      if ('mfa_required' in res) setMfaToken(res.mfa_token)
      else finish(res)
    } catch (e) {
      setError(errorMessage(e))
    }
  })

  if (mfaToken) {
    return (
      <MfaStep
        token={mfaToken}
        onDone={finish}
        onRestart={() => { setMfaToken(null); setError('Please sign in again.') }}
      />
    )
  }

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

/** Second sign-in step: a 6-digit authenticator code, or a one-time recovery code. */
function MfaStep({ token, onDone, onRestart }: { token: string; onDone: (r: AuthResponse) => void; onRestart: () => void }) {
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      onDone(await authApi.loginMfa({ mfa_token: token, code: code.trim() }))
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_CHALLENGE_EXPIRED') return onRestart()
      setError(errorMessage(err))
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Two-factor authentication"
      subtitle={recovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-soft p-3 text-sm text-danger-strong">
            <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
          </div>
        )}
        <Field label={recovery ? 'Recovery code' : 'Authentication code'} htmlFor="mfa-code">
          <Input
            id="mfa-code"
            autoFocus
            autoComplete="one-time-code"
            inputMode={recovery ? 'text' : 'numeric'}
            maxLength={recovery ? 20 : 6}
            placeholder={recovery ? 'xxxxx-xxxxx' : '123456'}
            value={code}
            onChange={(e) => setCode(recovery ? e.target.value : e.target.value.replace(/\D/g, ''))}
            className="text-center font-mono text-lg tracking-widest"
          />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={recovery ? code.trim().length < 10 : code.length !== 6}>
          Verify
        </Button>
      </form>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-sm">
        <button type="button" className="font-medium text-primary hover:underline" onClick={() => { setRecovery(!recovery); setCode(''); setError(null) }}>
          {recovery ? 'Use authenticator app' : 'Use a recovery code'}
        </button>
        <button type="button" className="text-muted-foreground hover:underline" onClick={onRestart}>
          Back to sign in
        </button>
      </div>
    </AuthLayout>
  )
}
