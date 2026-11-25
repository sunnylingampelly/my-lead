import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Copy, Download, ShieldAlert, ShieldCheck } from 'lucide-react'
import { userApi } from '@/api/services'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/form-controls'
import { PasswordInput } from '@/components/ui/password-input'
import { Badge } from '@/components/ui/misc'
import { useAuth, useUser } from '@/hooks/useAuth'
import type { MfaSetup } from '@/types/api'

const mfaKey = ['me', 'mfa'] as const

/** Account → Security: two-factor authentication with an authenticator app (TOTP) and recovery codes. */
export function TwoFactorCard() {
  const user = useUser()
  const { setUser } = useAuth()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const status = useQuery({ queryKey: mfaKey, queryFn: userApi.mfaStatus })
  const [setup, setSetup] = useState<MfaSetup | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [mode, setMode] = useState<'idle' | 'disable' | 'regenerate'>('idle')

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: mfaKey })
    setUser(await userApi.me())
  }

  const start = async () => {
    try {
      setCodes(null)
      setSetup(await userApi.mfaSetup())
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  // Arriving from sign-in because the organization requires two-factor: open setup straight away.
  const wantsSetup = params.get('setup') === '1'
  useEffect(() => {
    if (wantsSetup && status.data && !status.data.enabled && !setup) {
      void start()
      document.getElementById('two-factor')?.scrollIntoView({ behavior: 'smooth' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsSetup, status.data])

  const enabled = status.data?.enabled ?? !!user.mfa_enabled

  return (
    <Card id="two-factor">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Two-factor authentication
          {enabled ? <Badge variant="success">On</Badge> : <Badge variant="warning">Off</Badge>}
        </CardTitle>
        <CardDescription>
          Sign-ins need a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator,
          1Password, Authy…) in addition to your password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!enabled && (status.data?.required_by_organization || user.mfa_setup_required) && (
          <Notice tone="warning">
            Your organization requires two-factor authentication for owners and admins. Organization admin actions
            are paused until you turn it on.
          </Notice>
        )}
        {!enabled && status.data?.recommended && (
          <Notice tone="warning">Platform administrators should always use two-factor authentication.</Notice>
        )}
        {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
        {!enabled && setup && (
          <SetupSteps
            setup={setup}
            onEnabled={async (c) => {
              setSetup(null)
              setCodes(c)
              if (wantsSetup) setParams({}, { replace: true })
              await refresh()
              toast.success('Two-factor authentication is on')
            }}
            onCancel={() => setSetup(null)}
          />
        )}
        {enabled && !codes && (
          <EnabledPanel
            remaining={status.data?.recovery_codes_remaining ?? 0}
            mode={mode}
            setMode={setMode}
            onCodes={(c) => { setCodes(c); setMode('idle'); void refresh() }}
            onDisabled={async () => { setMode('idle'); await refresh(); toast.success('Two-factor authentication is off') }}
          />
        )}
      </CardContent>
      {!enabled && !setup && (
        <CardFooter>
          <Button onClick={start} loading={status.isLoading}>
            <ShieldCheck className="size-4" /> Set up two-factor authentication
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}

function Notice({ tone, children }: { tone: 'warning' | 'info'; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={
        tone === 'warning'
          ? 'flex items-start gap-2 rounded-md border border-warning-border bg-warning-soft p-3 text-sm text-warning-strong'
          : 'flex items-start gap-2 rounded-md border bg-muted p-3 text-sm'
      }
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0" /> <div>{children}</div>
    </div>
  )
}

function SetupSteps({ setup, onEnabled, onCancel }: { setup: MfaSetup; onEnabled: (codes: string[]) => void; onCancel: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const grouped = setup.secret.replace(/(.{4})/g, '$1 ').trim()

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onEnabled((await userApi.mfaEnable(code)).recovery_codes)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={confirm} className="space-y-4 rounded-lg border p-4" data-testid="mfa-setup">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>Open your authenticator app and add an account.</li>
        <li>Scan the QR code, or type the setup key.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        {setup.qr_data_uri && (
          <img src={setup.qr_data_uri} alt="QR code for your authenticator app" className="size-44 shrink-0 rounded-md border bg-white p-1" />
        )}
        <div className="w-full min-w-0 space-y-2">
          <div className="text-xs font-medium uppercase text-muted-foreground">Setup key</div>
          <div className="flex items-center gap-2">
            <code data-testid="mfa-secret" data-secret={setup.secret} className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-sm">
              {grouped}
            </code>
            <Button type="button" variant="outline" size="icon" aria-label="Copy setup key"
              onClick={() => navigator.clipboard?.writeText(setup.secret).then(() => toast.success('Key copied'))}>
              <Copy className="size-4" />
            </Button>
          </div>
          <Field label="6-digit code" htmlFor="mfa-enable-code" error={error ?? undefined}>
            <Input id="mfa-enable-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="font-mono tracking-widest" />
          </Field>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} disabled={code.length !== 6}>Turn on</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join('\n')
  const download = () => {
    const href = URL.createObjectURL(new Blob([`Signalcraft recovery codes\nEach code works once.\n\n${text}\n`], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = href
    a.download = 'signalcraft-recovery-codes.txt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(href), 1000)
  }
  return (
    <div className="space-y-3 rounded-lg border border-warning-border bg-warning-soft/40 p-4" data-testid="recovery-codes">
      <div className="text-sm font-medium">Save your recovery codes</div>
      <p className="text-sm text-muted-foreground">
        Each code signs you in once if you lose your phone. They are shown only now: store them somewhere safe.
      </p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((c) => <li key={c} data-testid="recovery-code">{c}</li>)}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => navigator.clipboard?.writeText(text).then(() => toast.success('Codes copied'))}>
          <Copy className="size-4" /> Copy
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}><Download className="size-4" /> Download</Button>
        <Button type="button" size="sm" onClick={onDone}>I saved them</Button>
      </div>
    </div>
  )
}

function EnabledPanel({ remaining, mode, setMode, onCodes, onDisabled }: {
  remaining: number
  mode: 'idle' | 'disable' | 'regenerate'
  setMode: (m: 'idle' | 'disable' | 'regenerate') => void
  onCodes: (codes: string[]) => void
  onDisabled: () => void
}) {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reset = (m: 'idle' | 'disable' | 'regenerate') => { setMode(m); setPassword(''); setCode(''); setError(null) }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode === 'regenerate') onCodes((await userApi.mfaRegenerateCodes(password)).recovery_codes)
      else { await userApi.mfaDisable({ password, code: code.trim() }); onDisabled() }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'idle') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {remaining} of 10 recovery codes left.{remaining <= 3 && ' Generate new ones soon.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => reset('regenerate')}>New recovery codes</Button>
          <Button variant="outline" onClick={() => reset('disable')}>Turn off</Button>
        </div>
      </div>
    )
  }
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border p-4">
      <div className="text-sm font-medium">
        {mode === 'disable' ? 'Turn off two-factor authentication' : 'Replace your recovery codes (the old ones stop working)'}
      </div>
      <Field label="Password" htmlFor="mfa-password">
        <PasswordInput id="mfa-password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {mode === 'disable' && (
        <Field label="Authentication code or recovery code" htmlFor="mfa-disable-code">
          <Input id="mfa-disable-code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
      )}
      {error && <p role="alert" className="text-sm text-danger-strong">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={mode === 'disable' ? 'destructive' : 'default'} loading={busy}
          disabled={!password || (mode === 'disable' && code.trim().length < 6)}>
          {mode === 'disable' ? 'Turn off' : 'Generate new codes'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => reset('idle')}>Cancel</Button>
      </div>
    </form>
  )
}
