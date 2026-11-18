import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { CheckCircle2, MailCheck, XCircle } from 'lucide-react'
import { AuthLayout } from '@/layouts/AuthLayout'
import { Button } from '@/components/ui/button'
import { authApi, userApi } from '@/api/services'
import { errorMessage } from '@/api/client'
import { useAuth } from '@/hooks/useAuth'
import { DevMailboxHint } from '@/modules/dev/DevMailboxHint'

/** Shown after registration until the user clicks the link in their inbox. */
export function VerifyEmailSentPage() {
  const { user, logout, setUser } = useAuth()
  const navigate = useNavigate()
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (user?.email_verified) navigate('/', { replace: true })
  }, [user, navigate])

  // Verifying usually happens in another tab; pick it up when the user comes back.
  useEffect(() => {
    const check = () => userApi.me().then(setUser).catch(() => undefined)
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [setUser])

  return (
    <AuthLayout title="Check your inbox" subtitle={<>We sent a verification link to <strong className="text-foreground">{user?.email}</strong>.</>}>
      <div className="flex size-12 items-center justify-center rounded-full bg-accent text-primary">
        <MailCheck className="size-6" />
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        Click the link in that email to verify your address. Then you can create your organization and first application.
      </p>
      <div className="mt-6 flex flex-col gap-2">
        <Button
          variant="outline"
          loading={sending}
          onClick={async () => {
            setSending(true)
            try {
              const r = await authApi.resendVerification()
              toast.success(r.message)
            } catch (e) {
              toast.error(errorMessage(e))
            } finally {
              setSending(false)
            }
          }}
        >
          Resend email
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            await logout()
            navigate('/login')
          }}
        >
          Use a different account
        </Button>
      </div>
      {user && <DevMailboxHint email={user.email} />}
    </AuthLayout>
  )
}

/** Target of the link in the verification email. Works whether or not the user is signed in. */
export function VerifyEmailPage() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const { status, user, setUser } = useAuth()
  const [state, setState] = useState<'pending' | 'ok' | 'error'>('pending')
  const [message, setMessage] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    if (!token) {
      setState('error')
      setMessage('This link is missing its token.')
      return
    }
    authApi
      .verifyEmail(token)
      .then(() => setState('ok'))
      .catch((e) => {
        setState('error')
        setMessage(errorMessage(e))
      })
  }, [token])

  // The session may finish restoring after verification; reload the profile so the
  // in-memory user reflects the verified state before continuing.
  useEffect(() => {
    if (state === 'ok' && status === 'authenticated' && user && !user.email_verified) {
      userApi.me().then(setUser).catch(() => undefined)
    }
  }, [state, status, user, setUser])

  return (
    <AuthLayout title={state === 'ok' ? 'Email verified' : state === 'error' ? 'Verification failed' : 'Verifying…'}>
      {state === 'pending' && <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />}
      {state === 'ok' && (
        <div className="space-y-6">
          <div className="flex items-center gap-3 text-sm text-success-strong">
            <CheckCircle2 className="size-5" /> Your email address is confirmed.
          </div>
          <Button asChild className="w-full">
            <Link to={status === 'authenticated' ? '/' : '/login'}>
              {status === 'authenticated' ? 'Continue setup' : 'Sign in to continue'}
            </Link>
          </Button>
        </div>
      )}
      {state === 'error' && (
        <div className="space-y-6">
          <div className="flex items-start gap-3 text-sm text-danger-strong">
            <XCircle className="mt-0.5 size-5 shrink-0" /> {message}
          </div>
          <Button asChild variant="outline" className="w-full">
            <Link to={status === 'authenticated' ? '/verify-email-sent' : '/login'}>Request a new link</Link>
          </Button>
        </div>
      )}
    </AuthLayout>
  )
}
