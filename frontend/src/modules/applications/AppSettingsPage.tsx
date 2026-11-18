import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Trash2, UserMinus } from 'lucide-react'
import { qk, useAppMembers, useAppSettings, useMembers } from '@/api/queries'
import { appApi } from '@/api/services'
import { errorMessage } from '@/api/client'
import { ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { Avatar, Badge } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useWorkspace } from '@/hooks/useWorkspace'
import { ApplicationForm } from './ApplicationForm'
import { ComplianceTab } from './ComplianceTab'
import type { ApplicationSettings, RoleKey } from '@/types/api'

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  application_manager: 'Application manager',
  campaign_manager: 'Campaign manager',
  analyst: 'Analyst',
  viewer: 'Viewer',
}

export function AppSettingsPage() {
  const { app, org, can } = useWorkspace()
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${app!.id}` }, { label: 'Settings' }]}
        title="Application settings"
        description="Configuration that applies only to this application."
      />
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="delivery">Delivery</TabsTrigger>
          <TabsTrigger value="compliance">Compliance</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          {can('app.delete') && <TabsTrigger value="danger">Danger zone</TabsTrigger>}
        </TabsList>
        <TabsContent value="general">
          <GeneralTab />
        </TabsContent>
        <TabsContent value="delivery">
          <DeliveryTab />
        </TabsContent>
        <TabsContent value="compliance">
          <ComplianceTab />
        </TabsContent>
        <TabsContent value="access">
          <AccessTab />
        </TabsContent>
        {can('app.delete') && (
          <TabsContent value="danger">
            <DangerTab />
          </TabsContent>
        )}
      </Tabs>
    </>
  )
}

function GeneralTab() {
  const { app, can } = useWorkspace()
  const qc = useQueryClient()
  const a = app!
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Details</CardTitle>
        <CardDescription>Name, timezone and defaults for {a.name}.</CardDescription>
      </CardHeader>
      <CardContent>
        <ApplicationForm
          key={a.updated_at}
          disabled={!can('app.update')}
          defaultValues={{
            name: a.name,
            description: a.description ?? '',
            color: a.color,
            timezone: a.timezone,
            default_country: a.default_country ?? '',
          }}
          submitLabel="Save changes"
          onSubmit={async (values) => {
            const updated = await appApi.update(a.id, values)
            qc.setQueryData(qk.app(a.id), updated)
            await qc.invalidateQueries({ queryKey: ['apps', 'list'] })
            toast.success('Application updated')
          }}
        />
      </CardContent>
    </Card>
  )
}

function DeliveryTab() {
  const { app, can } = useWorkspace()
  const q = useAppSettings(app!.id)
  const qc = useQueryClient()
  const { register, handleSubmit, formState } = useForm<ApplicationSettings>({ values: q.data })
  const editable = can('settings.write')

  if (q.isLoading) return <Card className="max-w-2xl"><LoadingRows /></Card>
  if (q.isError) return <Card className="max-w-2xl"><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>

  return (
    <form
      onSubmit={handleSubmit(async (v) => {
        try {
          const s = await appApi.updateSettings(app!.id, v)
          qc.setQueryData(qk.appSettings(app!.id), s)
          toast.success('Settings saved')
        } catch (e) {
          toast.error(errorMessage(e))
        }
      })}
    >
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Audience and delivery</CardTitle>
          <CardDescription>
            Providers stay in simulation until real credentials are configured by a platform administrator.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <fieldset disabled={!editable} className="grid gap-4 sm:grid-cols-2">
            <Field label="Duplicate contact rule" htmlFor="identity" hint="How imports and API calls match existing contacts. Locked once the first contact exists." className="sm:col-span-2">
              <Select id="identity" {...register('contact_identity_rule')}>
                <option value="email_or_phone">Match on email, then phone</option>
                <option value="email">Match on email only</option>
                <option value="phone">Match on phone only</option>
              </Select>
            </Field>
            <Field label="Email provider" htmlFor="ep">
              <Select id="ep" {...register('default_email_provider')}>
                <option value="simulation">Simulation</option>
                <option value="ses">Amazon SES</option>
                <option value="brevo">Brevo</option>
              </Select>
            </Field>
            <Field label="SMS provider" htmlFor="sp">
              <Select id="sp" {...register('default_sms_provider')}>
                <option value="simulation">Simulation</option>
                <option value="msg91">MSG91</option>
                <option value="twilio">Twilio</option>
              </Select>
            </Field>
            <Field label="Voice provider" htmlFor="vp">
              <Select id="vp" {...register('default_voice_provider')}>
                <option value="simulation">Simulation</option>
                <option value="exotel">Exotel</option>
                <option value="twilio">Twilio</option>
              </Select>
            </Field>
            <div />
            <Field label="Quiet hours start" htmlFor="qs" hint="Promotional SMS and calls wait until quiet hours end.">
              <Input id="qs" type="time" {...register('quiet_hours_start')} />
            </Field>
            <Field label="Quiet hours end" htmlFor="qe" hint={`In each recipient's time zone, or ${app!.timezone} when unknown.`}>
              <Input id="qe" type="time" {...register('quiet_hours_end')} />
            </Field>
          </fieldset>
        </CardContent>
        {editable && (
          <CardFooter>
            <Button type="submit" loading={formState.isSubmitting} disabled={!formState.isDirty}>
              Save settings
            </Button>
          </CardFooter>
        )}
      </Card>
    </form>
  )
}

function AccessTab() {
  const { app, org, can } = useWorkspace()
  const members = useAppMembers(app!.id)
  const manage = can('app.members.manage')
  const orgMembers = useMembers(org!.id, { page: 1, page_size: 200 }, manage)
  const qc = useQueryClient()
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<RoleKey | ''>('')
  const [adding, setAdding] = useState(false)

  const candidates =
    orgMembers.data?.items.filter(
      (m) => !['owner', 'admin'].includes(m.role) && !members.data?.some((x) => x.user_id === m.user.id),
    ) ?? []

  const refresh = () => qc.invalidateQueries({ queryKey: qk.appMembers(app!.id) })

  return (
    <Card>
      <CardHeader>
        <CardTitle>People with access</CardTitle>
        <CardDescription>Owners and admins can access every application. Other members need to be added here.</CardDescription>
      </CardHeader>
      {manage && (
        <div className="flex flex-col gap-2 border-y bg-muted/30 px-5 py-3 sm:flex-row">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Member to add" className="sm:w-72">
            <option value="">{candidates.length ? 'Select a member…' : 'Everyone already has access'}</option>
            {candidates.map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.full_name} ({m.role_label})
              </option>
            ))}
          </Select>
          <Select value={role} onChange={(e) => setRole(e.target.value as RoleKey | '')} aria-label="Application role" className="sm:w-56">
            <option value="">Same as organization role</option>
            <option value="campaign_manager">Campaign manager</option>
            <option value="analyst">Analyst</option>
            <option value="viewer">Viewer</option>
          </Select>
          <Button
            disabled={!userId}
            loading={adding}
            onClick={async () => {
              setAdding(true)
              try {
                await appApi.addMember(app!.id, { user_id: userId, role: role || null })
                setUserId('')
                setRole('')
                await refresh()
                toast.success('Access granted')
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setAdding(false)
              }
            }}
          >
            Add
          </Button>
        </div>
      )}
      {members.isLoading ? (
        <LoadingRows />
      ) : members.isError ? (
        <ErrorState error={members.error} onRetry={() => members.refetch()} />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Member</TH>
              <TH>Access</TH>
              <TH>Role here</TH>
              {manage && <TH className="w-10" />}
            </TR>
          </THead>
          <TBody>
            {members.data?.map((m) => (
              <TR key={m.user_id}>
                <TD>
                  <div className="flex items-center gap-3">
                    <Avatar name={m.full_name} />
                    <div>
                      <div className="font-medium">{m.full_name}</div>
                      <div className="text-xs text-muted-foreground">{m.email}</div>
                    </div>
                  </div>
                </TD>
                <TD>
                  {m.access === 'org_wide' ? <Badge variant="secondary">All applications</Badge> : <Badge>Explicit</Badge>}
                </TD>
                <TD>{ROLE_LABEL[m.effective_role]}</TD>
                {manage && (
                  <TD>
                    {m.access === 'explicit' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${m.full_name}`}
                        onClick={async () => {
                          try {
                            await appApi.removeMember(app!.id, m.user_id)
                            await refresh()
                            toast.success('Access removed')
                          } catch (e) {
                            toast.error(errorMessage(e))
                          }
                        }}
                      >
                        <UserMinus />
                      </Button>
                    )}
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  )
}

function DangerTab() {
  const { app, org } = useWorkspace()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const qc = useQueryClient()
  const navigate = useNavigate()

  return (
    <Card className="max-w-2xl border-danger-border">
      <CardHeader>
        <CardTitle className="text-destructive">Delete application</CardTitle>
        <CardDescription>
          Removes {app!.name} and everything in it for every member. Data is retained for a recovery window, then purged.
        </CardDescription>
      </CardHeader>
      <CardFooter className="justify-start border-danger-border bg-danger-soft">
        <Button variant="destructive" onClick={() => setOpen(true)}>
          <Trash2 /> Delete application
        </Button>
      </CardFooter>
      <ConfirmDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          setConfirm('')
        }}
        title={`Delete ${app!.name}?`}
        description="This cannot be undone from the app. Type the application name to confirm."
        confirmLabel="Delete application"
        destructive
        loading={loading}
        confirmDisabled={confirm !== app!.name}
        onConfirm={async () => {
          setLoading(true)
          try {
            await appApi.remove(app!.id, confirm)
            await qc.invalidateQueries({ queryKey: ['apps'] })
            await qc.invalidateQueries({ queryKey: qk.orgs })
            toast.success('Application deleted')
            navigate(`/orgs/${org!.id}/applications`, { replace: true })
          } catch (e) {
            toast.error(errorMessage(e))
          } finally {
            setLoading(false)
          }
        }}
      >
        <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={app!.name} aria-label="Application name" />
      </ConfirmDialog>
    </Card>
  )
}
