import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { useApplication, useApplications, useOrganizations } from '@/api/queries'
import { userApi } from '@/api/services'
import { useAuth } from '@/hooks/useAuth'
import type { Application, Organization } from '@/types/api'

interface Workspace {
  orgs: Organization[]
  org: Organization | null
  apps: Application[]
  app: Application | null
  loading: boolean
  appError: unknown
  /** Permission check against the current application role (or org role outside an app). */
  can: (perm: string) => boolean
  canOrg: (perm: string) => boolean
}

const WorkspaceContext = createContext<Workspace | null>(null)

/** Resolves the current organization and application from the URL and the user's last context.
 * The server re-verifies membership on every request; this is only for navigation and UI state. */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { appId, orgId: orgParam } = useParams()
  const { user, setUser } = useAuth()
  const orgsQ = useOrganizations()
  const appQ = useApplication(appId)

  const orgId = orgParam ?? appQ.data?.organization_id ?? user?.last_organization_id ?? orgsQ.data?.[0]?.id
  const org = orgsQ.data?.find((o) => o.id === orgId) ?? orgsQ.data?.[0] ?? null
  const appsQ = useApplications(org?.id)

  const app = useMemo(() => {
    if (appId) return appQ.data ?? null
    const apps = appsQ.data ?? []
    return apps.find((a) => a.id === user?.last_application_id) ?? apps[0] ?? null
  }, [appId, appQ.data, appsQ.data, user?.last_application_id])

  // Remember the last application so the next sign-in opens it.
  useEffect(() => {
    const viaSupport = orgsQ.data?.find((o) => o.id === appQ.data?.organization_id)?.support_access_expires_at
    if (appQ.data && user && !viaSupport && user.last_application_id !== appQ.data.id) {
      userApi.setContext({ application_id: appQ.data.id }).then(setUser).catch(() => undefined)
    }
  }, [appQ.data, user, setUser, orgsQ.data])

  const value = useMemo<Workspace>(
    () => ({
      orgs: orgsQ.data ?? [],
      org,
      apps: appsQ.data ?? [],
      app,
      loading: orgsQ.isLoading || (!!appId && appQ.isLoading),
      appError: appQ.error,
      can: (perm) => (app ? app.permissions.includes(perm) : (org?.permissions.includes(perm) ?? false)),
      canOrg: (perm) => org?.permissions.includes(perm) ?? false,
    }),
    [orgsQ.data, orgsQ.isLoading, org, appsQ.data, app, appId, appQ.isLoading, appQ.error],
  )
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWorkspace() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return ctx
}
