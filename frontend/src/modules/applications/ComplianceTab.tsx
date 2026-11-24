import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, Circle, Clock, Scale } from 'lucide-react'
import { aqk, useCompliance } from '@/api/audience'
import { qk, useAppSettings } from '@/api/queries'
import { appApi } from '@/api/services'
import { errorMessage } from '@/api/client'
import { ErrorState, LoadingRows } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input, Textarea } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn } from '@/lib/utils'
import { CountryFlag } from '@/components/CountryFlag'

/** Setup checks computed by the backend from real records, with the page that completes each one. */
type SetupCheck = { key: string; label: string; done: boolean; href?: string; detail?: string | null; steps?: { label: string; done: boolean; href: string }[] }

/** Regional rules for the application's market (India or the US) and the setup they require. */
export function ComplianceTab() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const comp = useCompliance(appId)
  const settings = useAppSettings(appId)
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [saving, setSaving] = useState(false)
  const editable = can('settings.write')

  useEffect(() => {
    if (settings.data) {
      setName(settings.data.business_name ?? '')
      setAddress(settings.data.business_address ?? '')
    }
  }, [settings.data])

  if (comp.isLoading) return <Card className="max-w-3xl"><LoadingRows /></Card>
  if (comp.isError) return <Card className="max-w-3xl"><ErrorState error={comp.error} onRetry={() => comp.refetch()} /></Card>
  const c = comp.data!

  return (
    <div className="grid max-w-5xl gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Scale className="size-4 text-primary" /> <CountryFlag code={c.region === 'XX' ? null : c.region} /> {c.region === 'XX' ? 'No regional profile' : `${c.region_name} rules`}
            </CardTitle>
            <CardDescription>
              Based on this application's default country. {c.region === 'XX' && 'Set India or the United States as the default country to apply a market profile.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {c.regulations.map((r) => (
              <div key={r.name}>
                <div className="text-sm font-semibold">{r.name}</div>
                <p className="text-sm text-muted-foreground">{r.summary}</p>
              </div>
            ))}
            <div className="flex flex-wrap gap-2 pt-1">
              <Badge variant="secondary">
                <Clock className="size-3" /> Promotional window {c.marketing_window[0]}–{c.marketing_window[1]} recipient time
              </Badge>
              <Badge variant="secondary">Currency {c.currency}</Badge>
              {c.sms_voice_requires_written_consent && <Badge variant="warning">Written consent for SMS and calls</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">{c.disclaimer}</p>
          </CardContent>
        </Card>

        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setSaving(true)
            try {
              const s = await appApi.updateSettings(appId, { business_name: name.trim() || null, business_address: address.trim() || null })
              qc.setQueryData(qk.appSettings(appId), s)
              await qc.invalidateQueries({ queryKey: aqk.compliance(appId) })
              toast.success('Business details saved')
            } catch (err) {
              toast.error(errorMessage(err))
            } finally {
              setSaving(false)
            }
          }}
        >
          <Card>
            <CardHeader>
              <CardTitle>Sender identity</CardTitle>
              <CardDescription>
                Shown in the footer of every marketing email.
                {c.email_requires_postal_address && ' A valid physical postal address is required for US commercial email (CAN-SPAM).'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <fieldset disabled={!editable} className="space-y-4">
                <Field label="Legal business name" htmlFor="biz-name">
                  <Input id="biz-name" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field
                  label="Postal address"
                  htmlFor="biz-address"
                  hint={c.region === 'IN' ? 'Registered office address, including PIN code.' : 'Street address or registered P.O. box, city, state and ZIP.'}
                >
                  <Textarea id="biz-address" rows={3} value={address} onChange={(e) => setAddress(e.target.value)} />
                </Field>
              </fieldset>
            </CardContent>
            {editable && (
              <CardFooter>
                <Button type="submit" loading={saving}>
                  Save
                </Button>
              </CardFooter>
            )}
          </Card>
        </form>
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Setup checklist</CardTitle>
          <CardDescription>Requirements for this market.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {(c.checks as SetupCheck[]).map((k) => (
              <li key={k.key} className="flex items-start gap-2 text-sm" data-testid={`check-${k.key}`}>
                {k.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-strong" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />}
                <span className={cn('min-w-0', k.done && 'text-muted-foreground')}>
                  {k.label}
                  {k.steps && k.steps.length > 1 && (
                    <span className="mt-1 block space-y-0.5">
                      {k.steps.map((s) => (
                        <Link key={s.label} to={s.href} className={cn('flex items-center gap-1.5 text-xs hover:underline', s.done ? 'text-muted-foreground' : 'text-primary')}>
                          {s.done ? <CheckCircle2 className="size-3 text-success-strong" /> : <Circle className="size-3" />} {s.label.charAt(0).toUpperCase() + s.label.slice(1)}
                        </Link>
                      ))}
                    </span>
                  )}
                  {!k.done && k.href && !(k.steps && k.steps.length > 1) && (
                    <Link to={k.href} className="block text-xs font-medium text-primary hover:underline">
                      {k.detail ?? 'Set up'} →
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-4 space-y-1 border-t pt-3 text-xs">
            <Link to={`/apps/${appId}/sms/registration`} className="block font-medium text-primary hover:underline">
              SMS registration (DLT / 10DLC) →
            </Link>
            <Link to={`/apps/${appId}/voice/registration`} className="block font-medium text-primary hover:underline">
              Voice DLT registration (India) →
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
