import { useEffect } from 'react'
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { AdminPage } from '@/modules/admin/AdminPage'

/** /admin for someone without a platform role: say why instead of silently redirecting. */
export function AdminGuard() {
  const { user } = useAuth()
  const allowed = !!user?.platform_role
  useEffect(() => {
    if (!allowed) toast.error("You don't have platform admin access", { id: 'no-admin-access' })
  }, [allowed])
  return allowed ? <AdminPage /> : <Navigate to="/" replace />
}

const CRM_SECTIONS: Record<string, string> = {
  deals: 'Deals',
  leads: 'Leads',
  companies: 'Companies',
  tasks: 'Tasks',
  reports: 'Reports',
  settings: 'CRM settings',
}

/** Breadcrumbs for CRM list pages (detail pages render their own). */
export function CrmCrumbs() {
  const { app } = useWorkspace()
  const { pathname } = useLocation()
  const section = pathname.match(/\/crm\/([a-z]+)\/?$/)?.[1]
  const label = section ? CRM_SECTIONS[section] : undefined
  return (
    <>
      {app && label && (
        <nav aria-label="Breadcrumb" className="mb-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground" data-testid="crm-breadcrumbs">
          <Link to={`/apps/${app.id}`} className="truncate hover:text-foreground">
            {app.name}
          </Link>
          <ChevronRight className="size-3 shrink-0" />
          <Link to={`/apps/${app.id}/crm/deals`} className="hover:text-foreground">
            CRM
          </Link>
          <ChevronRight className="size-3 shrink-0" />
          <span className="text-foreground/80">{label}</span>
        </nav>
      )}
      <Outlet />
    </>
  )
}
