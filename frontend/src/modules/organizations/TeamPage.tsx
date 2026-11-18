import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { MailPlus, MoreHorizontal, RotateCw, Search, Shield, UserMinus, UserPlus, Users, X } from 'lucide-react'
import { useApplications, useInvitations, useMembers, useRoles } from '@/api/queries'
import { orgApi } from '@/api/services'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { Avatar, Badge } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { useUser } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { applyServerErrors, emailSchema } from '@/lib/forms'
import { formatDate } from '@/lib/utils'
import type { Member, RoleInfo, RoleKey } from '@/types/api'

const ORG_WIDE: RoleKey[] = ['owner', 'admin']
const PAGE_SIZE = 20

function AppPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { org } = useWorkspace()
  const apps = useApplications(org?.id)
  if (!apps.data?.length) return <p className="text-sm text-muted-foreground">No applications yet.</p>
  return (
    <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-2">
      {apps.data.map((a) => (
        <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
          <input
            type="checkbox"
            className="size-4 accent-[hsl(var(--primary))]"
            checked={value.includes(a.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, a.id] : value.filter((x) => x !== a.id))}
          />
          {a.name}
        </label>
      ))}
    </div>
  )
}

function RoleSelect({ roles, ...props }: { roles: RoleInfo[] } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Select {...props}>
      {roles
        .filter((r) => r.assignable)
        .map((r) => (
          <option key={r.key} value={r.key}>
            {r.name}
          </option>
        ))}
    </Select>
  )
}

const inviteSchema = z.object({ email: emailSchema, role: z.string().min(1) })

function InviteDialog({ open, onOpenChange, roles }: { open: boolean; onOpenChange: (o: boolean) => void; roles: RoleInfo[] }) {
  const { orgId } = useParams()
  const qc = useQueryClient()
  const [appIds, setAppIds] = useState<string[]>([])
  const defaultRole = roles.find((r) => r.key === 'campaign_manager' && r.assignable)?.key ?? roles.find((r) => r.assignable)?.key ?? 'viewer'
  const { register, handleSubmit, formState, setError, watch, reset } = useForm<z.infer<typeof inviteSchema>>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', role: defaultRole },
  })
  const role = watch('role') as RoleKey
  const needsApps = !ORG_WIDE.includes(role)
  const roleInfo = roles.find((r) => r.key === role)

  useEffect(() => {
    if (open) {
      reset({ email: '', role: defaultRole })
      setAppIds([])
    }
  }, [open, reset, defaultRole])

  const submit = handleSubmit(async (v) => {
    if (needsApps && appIds.length === 0) {
      toast.error('Select at least one application for this role')
      return
    }
    try {
      await orgApi.invite(orgId!, { email: v.email, role: v.role as RoleKey, application_ids: needsApps ? appIds : [] })
      await qc.invalidateQueries({ queryKey: ['orgs', orgId] })
      toast.success(`Invitation sent to ${v.email}`)
      onOpenChange(false)
    } catch (e) {
      applyServerErrors(e, setError, ['email', 'role'])
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>They'll receive an email with a link to join. Invitations expire after 7 days.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Email" htmlFor="invite-email" error={formState.errors.email?.message}>
            <Input id="invite-email" type="email" autoFocus placeholder="name@company.com" {...register('email')} aria-invalid={!!formState.errors.email} />
          </Field>
          <Field label="Role" htmlFor="invite-role" hint={roleInfo?.description}>
            <RoleSelect id="invite-role" roles={roles} {...register('role')} />
          </Field>
          {needsApps && (
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Application access</span>
              <AppPicker value={appIds} onChange={setAppIds} />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={formState.isSubmitting}>
              <MailPlus /> Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EditMemberDialog({ member, roles, onClose }: { member: Member | null; roles: RoleInfo[]; onClose: () => void }) {
  const { orgId } = useParams()
  const qc = useQueryClient()
  const [role, setRole] = useState<RoleKey>('viewer')
  const [appIds, setAppIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (member) {
      setRole(member.role)
      setAppIds(member.application_ids)
    }
  }, [member])

  const options = member && !roles.find((r) => r.key === member.role)?.assignable
    ? [...roles.filter((r) => r.assignable), roles.find((r) => r.key === member.role)!]
    : roles.filter((r) => r.assignable)

  return (
    <Dialog open={!!member} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {member?.user.full_name}</DialogTitle>
          <DialogDescription>{member?.user.email}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Role" htmlFor="edit-role" hint={roles.find((r) => r.key === role)?.description}>
            <Select id="edit-role" value={role} onChange={(e) => setRole(e.target.value as RoleKey)}>
              {options.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          {!ORG_WIDE.includes(role) && (
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Application access</span>
              <AppPicker value={appIds} onChange={setAppIds} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={saving}
            onClick={async () => {
              if (!member) return
              setSaving(true)
              try {
                await orgApi.updateMember(orgId!, member.id, {
                  ...(role !== member.role ? { role } : {}),
                  ...(!ORG_WIDE.includes(role) ? { application_ids: appIds } : {}),
                })
                await qc.invalidateQueries({ queryKey: ['orgs', orgId] })
                toast.success('Member updated')
                onClose()
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setSaving(false)
              }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function TeamPage() {
  const { orgId } = useParams()
  const [params, setParams] = useSearchParams()
  const me = useUser()
  const { org, canOrg } = useWorkspace()
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [editing, setEditing] = useState<Member | null>(null)
  const [removing, setRemoving] = useState<Member | null>(null)
  const [busy, setBusy] = useState(false)
  const inviteOpen = params.get('invite') === '1'
  const setInviteOpen = (o: boolean) => setParams(o ? { invite: '1' } : {}, { replace: true })

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search)
      setPage(1)
    }, 250)
    return () => clearTimeout(t)
  }, [search])

  const roles = useRoles(orgId)
  const members = useMembers(orgId!, { page, page_size: PAGE_SIZE, search: debounced || undefined })
  const invitations = useInvitations(orgId!)
  const canInvite = canOrg('members.invite')
  const canManage = canOrg('members.update') || canOrg('members.remove')
  const pages = members.data ? Math.max(1, Math.ceil(members.data.total / PAGE_SIZE)) : 1

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: 'Team' }]}
        title="Team"
        description="Manage who can access this organization and its applications."
        actions={
          canInvite && (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus /> Invite member
            </Button>
          )
        }
      />

      <Card>
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-[15px] font-semibold">Members</h2>
            <p className="text-sm text-muted-foreground">{members.data ? `${members.data.total} total` : ' '}</p>
          </div>
          <div className="relative sm:w-72">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email" className="pl-8" aria-label="Search members" data-page-search />
          </div>
        </div>
        {members.isLoading ? (
          <LoadingRows />
        ) : members.isError ? (
          <ErrorState error={members.error} onRetry={() => members.refetch()} />
        ) : members.data?.items.length === 0 ? (
          <EmptyState icon={Users} title="No members match" description="Try a different search." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Member</TH>
                <TH>Role</TH>
                <TH>Applications</TH>
                <TH>Joined</TH>
                <TH className="w-12" />
              </TR>
            </THead>
            <TBody>
              {members.data?.items.map((m) => {
                const isMe = m.user.id === me.id
                return (
                  <TR key={m.id}>
                    <TD>
                      <div className="flex items-center gap-3">
                        <Avatar name={m.user.full_name} />
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {m.user.full_name} {isMe && <span className="text-xs font-normal text-muted-foreground">(you)</span>}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">{m.user.email}</div>
                        </div>
                      </div>
                    </TD>
                    <TD>
                      <Badge variant={ORG_WIDE.includes(m.role) ? 'default' : 'secondary'}>
                        {ORG_WIDE.includes(m.role) && <Shield className="size-3" />}
                        {m.role_label}
                      </Badge>
                    </TD>
                    <TD className="text-muted-foreground">
                      {ORG_WIDE.includes(m.role) ? 'All' : m.application_ids.length}
                    </TD>
                    <TD className="text-muted-foreground">{formatDate(m.created_at)}</TD>
                    <TD>
                      {(canManage || isMe) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`Actions for ${m.user.full_name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canOrg('members.update') && !isMe && (
                              <DropdownMenuItem onSelect={() => setEditing(m)}>
                                <Shield /> Change role and access
                              </DropdownMenuItem>
                            )}
                            {canOrg('members.update') && isMe && !ORG_WIDE.includes(m.role) && (
                              <DropdownMenuItem onSelect={() => setEditing(m)}>
                                <Shield /> Change application access
                              </DropdownMenuItem>
                            )}
                            {(canOrg('members.remove') || isMe) && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem destructive onSelect={() => setRemoving(m)}>
                                  <UserMinus /> {isMe ? 'Leave organization' : 'Remove from organization'}
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TD>
                  </TR>
                )
              })}
            </TBody>
          </Table>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              Page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Pending invitations</CardTitle>
          <CardDescription>People who have been invited but haven't joined yet.</CardDescription>
        </CardHeader>
        {invitations.isLoading ? (
          <LoadingRows rows={2} />
        ) : invitations.isError ? (
          <ErrorState error={invitations.error} onRetry={() => invitations.refetch()} />
        ) : invitations.data?.length === 0 ? (
          <EmptyState
            icon={MailPlus}
            title="No pending invitations"
            className="py-8"
            action={
              canInvite && (
                <Button variant="outline" size="sm" onClick={() => setInviteOpen(true)}>
                  Invite someone
                </Button>
              )
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Email</TH>
                <TH>Role</TH>
                <TH>Invited by</TH>
                <TH>Expires</TH>
                {canInvite && <TH className="w-40" />}
              </TR>
            </THead>
            <TBody>
              {invitations.data?.map((i) => (
                <TR key={i.id}>
                  <TD className="font-medium">{i.email}</TD>
                  <TD>
                    <Badge variant="secondary">{i.role_label}</Badge>
                  </TD>
                  <TD className="text-muted-foreground">{i.invited_by_name ?? '—'}</TD>
                  <TD>
                    {i.status === 'expired' ? <Badge variant="warning">Expired</Badge> : <span className="text-muted-foreground">{formatDate(i.expires_at)}</span>}
                  </TD>
                  {canInvite && (
                    <TD>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            try {
                              await orgApi.resendInvite(orgId!, i.id)
                              await qc.invalidateQueries({ queryKey: ['orgs', orgId, 'invitations'] })
                              toast.success('Invitation resent')
                            } catch (e) {
                              toast.error(errorMessage(e))
                            }
                          }}
                        >
                          <RotateCw /> Resend
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={async () => {
                            try {
                              await orgApi.revokeInvite(orgId!, i.id)
                              await qc.invalidateQueries({ queryKey: ['orgs', orgId] })
                              toast.success('Invitation revoked')
                            } catch (e) {
                              toast.error(errorMessage(e))
                            }
                          }}
                        >
                          <X /> Revoke
                        </Button>
                      </div>
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {roles.data && <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} roles={roles.data} />}
      {roles.data && <EditMemberDialog member={editing} roles={roles.data} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing?.user.id === me.id ? 'Leave organization?' : `Remove ${removing?.user.full_name}?`}
        description={
          removing?.user.id === me.id
            ? 'You will lose access to every application in this organization.'
            : 'They will immediately lose access to this organization and all of its applications.'
        }
        confirmLabel={removing?.user.id === me.id ? 'Leave' : 'Remove'}
        destructive
        loading={busy}
        onConfirm={async () => {
          if (!removing) return
          setBusy(true)
          try {
            await orgApi.removeMember(orgId!, removing.id)
            if (removing.user.id === me.id) {
              await qc.invalidateQueries()
              window.location.assign('/')
              return
            }
            await qc.invalidateQueries({ queryKey: ['orgs', orgId] })
            toast.success('Member removed')
            setRemoving(null)
          } catch (e) {
            toast.error(errorMessage(e))
          } finally {
            setBusy(false)
          }
        }}
      />
    </>
  )
}
