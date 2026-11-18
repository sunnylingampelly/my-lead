/** Public pages reached from email links: sender confirmation and unsubscribe. */
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CheckCircle2, MailX, XCircle } from 'lucide-react'
import { http, errorMessage } from '@/api/client'
import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-pop">
        <Logo className="mb-8 justify-center" />
        {children}
      </div>
    </div>
  )
}

export function VerifySenderPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [state, setState] = useState<{ ok?: boolean; email?: string; error?: string }>({})
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    http
      .post<{ from_email: string }>('/public/email-senders/verify', { token })
      .then((r) => setState({ ok: true, email: r.data.from_email }))
      .catch((e) => setState({ ok: false, error: errorMessage(e) }))
  }, [token])
  return (
    <Shell>
      {state.ok === undefined ? (
        <div className="mx-auto size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      ) : state.ok ? (
        <>
          <CheckCircle2 className="mx-auto size-10 text-success-strong" />
          <h1 className="mt-4 text-xl font-semibold">Sender confirmed</h1>
          <p className="mt-2 text-sm text-muted-foreground" data-testid="sender-verified">
            {state.email} can now be used to send campaigns. You can close this tab.
          </p>
        </>
      ) : (
        <>
          <XCircle className="mx-auto size-10 text-destructive" />
          <h1 className="mt-4 text-xl font-semibold">Link not valid</h1>
          <p className="mt-2 text-sm text-muted-foreground">{state.error}</p>
        </>
      )}
    </Shell>
  )
}

export function UnsubscribePage() {
  const [params] = useSearchParams()
  const token = params.get('t') ?? ''
  const [info, setInfo] = useState<{ sender: string; email: string; unsubscribed: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (token === 'preview') {
      setError('This is a preview link. Real emails contain a personal unsubscribe link.')
      return
    }
    http
      .get(`/public/unsubscribe/${encodeURIComponent(token)}`)
      .then((r) => setInfo(r.data))
      .catch((e) => setError(errorMessage(e)))
  }, [token])
  return (
    <Shell>
      {error ? (
        <>
          <XCircle className="mx-auto size-10 text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">{error}</p>
        </>
      ) : !info ? (
        <div className="mx-auto size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      ) : info.unsubscribed ? (
        <>
          <CheckCircle2 className="mx-auto size-10 text-success-strong" />
          <h1 className="mt-4 text-xl font-semibold">You're unsubscribed</h1>
          <p className="mt-2 text-sm text-muted-foreground" data-testid="unsubscribed">
            {info.email} will no longer receive marketing email from {info.sender}. It can take a few minutes to take effect everywhere.
          </p>
        </>
      ) : (
        <>
          <MailX className="mx-auto size-10 text-primary" />
          <h1 className="mt-4 text-xl font-semibold">Unsubscribe from {info.sender}?</h1>
          <p className="mt-2 text-sm text-muted-foreground">You will stop receiving marketing email at {info.email}. Important account messages may still be sent.</p>
          <Button
            className="mt-6 w-full"
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await http.post('/public/unsubscribe', { token })
                setInfo(r.data)
              } catch (e) {
                setError(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Unsubscribe
          </Button>
        </>
      )}
    </Shell>
  )
}
