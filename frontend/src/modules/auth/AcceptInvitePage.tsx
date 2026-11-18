import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Building2 } from 'lucide-react'
import { AuthLayout } from '@/layouts/AuthLayout'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/misc'
import { invitationApi } from '@/api/services'
import { errorMessage } from '@/api/client'
import { useAuth } from '@/hooks/useAuth'
import { formatDate } from '@/lib/utils'

export function AcceptInvitePage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const { status, user, logout } = useAuth()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [accepting, setAccepting] = useState(false)
  const preview = useQuery({
    queryKey: ['invite-preview', token],
    queryFn: () => invitationApi.preview(token),
    enabled: !!token,
    retry: false,
  })

  const here = `/invite?token=${encodeURIComponent(token)}`
  const inv = preview.data
  const valid = inv?.status === 'pending'
  const emailMatches = !!user && !!inv && user.email.toLowerCase() === inv.email.toLowerCase()

  return (
    <AuthLayout title="You're invited" subtitle="Join your team's workspace.">
      {preview.isLoading && <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />}
      {(preview.isError || !token) && (
        <div className="space-y-4">
          <p className="text-sm text-destructive">{token ? errorMessage(preview.error) : 'This link is missing its token.'}</p>
          <Button asChild variant="outline">
            <Link to="/">Go to app</Link>
          </Button>
        </div>
      )}
      {inv && (
        <div className="space-y-6">
          <div className="flex items-center gap-3 rounded-lg border bg-card p-4 shadow-card">
            <div className="flex size-10 items-center justify-center rounded-md bg-accent text-primary">
              <Building2 className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="truncate font-medium">{inv.organization_name}</div>
              <div className="text-xs text-muted-foreground">
                {inv.email} · <Badge variant="secondary">{inv.role_label}</Badge>
              </div>
            </div>
          </div>
          {!valid && (
            <p className="text-sm text-destructive">
              This invitation is {inv.status}. Ask an administrator to send a new one.
            </p>
          )}
          {valid && status === 'anonymous' && (
            <div className="flex flex-col gap-2">
              {inv.account_exists ? (
                <Button asChild>
                  <Link to={`/login?next=${encodeURIComponent(here)}`}>Sign in to accept</Link>
                </Button>
              ) : (
                <Button asChild>
                  <Link to={`/register?invite=${encodeURIComponent(token)}`}>Create account and join</Link>
                </Button>
              )}
              <p className="text-xs text-muted-foreground">Expires {formatDate(inv.expires_at)}.</p>
            </div>
          )}
          {valid && status === 'authenticated' && !emailMatches && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                You're signed in as <strong className="text-foreground">{user?.email}</strong>, but this invitation was sent to{' '}
                <strong className="text-foreground">{inv.email}</strong>.
              </p>
              <Button
                variant="outline"
                onClick={async () => {
                  await logout()
                  navigate(`/login?next=${encodeURIComponent(here)}`)
                }}
              >
                Sign in with {inv.email}
              </Button>
            </div>
          )}
          {valid && emailMatches && (
            <Button
              className="w-full"
              loading={accepting}
              onClick={async () => {
                setAccepting(true)
                try {
                  const org = await invitationApi.accept(token)
                  await qc.invalidateQueries()
                  toast.success(`You joined ${org.name}`)
                  navigate(`/orgs/${org.id}/applications`, { replace: true })
                } catch (e) {
                  toast.error(errorMessage(e))
                } finally {
                  setAccepting(false)
                }
              }}
            >
              Accept invitation
            </Button>
          )}
        </div>
      )}
    </AuthLayout>
  )
}
