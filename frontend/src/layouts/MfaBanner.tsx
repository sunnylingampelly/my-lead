import { Link, useLocation } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'

/** Shown when two-factor authentication is required (organization setting) or strongly recommended
 * (platform administrators, in the admin area). Links to Account → Security. */
export function MfaBanner() {
  const { user } = useAuth()
  const { org } = useWorkspace()
  const { pathname } = useLocation()
  if (!user || user.mfa_enabled || pathname.startsWith('/account')) return null
  const required = user.mfa_setup_required || org?.mfa_setup_required
  const adminArea = pathname.startsWith('/admin') && user.mfa_recommended
  if (!required && !adminArea) return null
  return (
    <div role="status" data-testid="mfa-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning-border bg-warning-soft px-4 py-2 text-sm text-warning-strong sm:px-8">
      <ShieldAlert className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {required
          ? <><strong>Two-factor authentication required.</strong> Your organization requires it for owners and admins; organization admin actions are paused until you turn it on.</>
          : <><strong>Protect the platform.</strong> Administrator accounts should use two-factor authentication.</>}
      </span>
      <Link to="/account?setup=1" className="font-medium underline underline-offset-2">Set it up now</Link>
    </div>
  )
}
