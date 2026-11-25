import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ErrorState, FullPageSpinner } from '@/components/page'
import { TopProgress } from '@/components/TopProgress'
import { Button } from '@/components/ui/button'
import { WorkspaceProvider, useWorkspace } from '@/hooks/useWorkspace'
import { ApiError, setAddCreditHandler, setUpgradeHandler } from '@/api/client'
import { cn } from '@/lib/utils'
import { CommandPalette } from './CommandPalette'
import { ShortcutsDialog, useGlobalShortcuts } from './Shortcuts'
import { Sidebar } from './Sidebar'
import { SupportBanner } from './SupportBanner'
import { MfaBanner } from './MfaBanner'
import { Topbar } from './Topbar'
import { AssistantPanel } from '@/modules/ai/AssistantPanel'

const COLLAPSE_KEY = 'sc-sidebar-collapsed'

function Shell() {
  const [mobileNav, setMobileNav] = useState(false)
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch {
      return false
    }
  })
  const { loading, appError, org } = useWorkspace()
  const location = useLocation()
  const navigate = useNavigate()
  // "Add credit" on out-of-credit error toasts opens this organization's billing page with the top-up dialog.
  useEffect(() => {
    if (!org) return
    setAddCreditHandler(() => navigate(`/orgs/${org.id}/billing?topup=1`))
    setUpgradeHandler(() => navigate(`/orgs/${org.id}/billing#plan`))
    return () => {
      setAddCreditHandler(null)
      setUpgradeHandler(null)
    }
  }, [org, navigate])
  // The workflow builder uses the whole content area for its canvas.
  const fullBleed = /\/automation\/[^/]+$/.test(location.pathname)
  // The deals board is a wide kanban; let it use the whole width.
  const wide = /\/crm\/deals$/.test(location.pathname)

  const toggleSidebar = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !c
    })

  useGlobalShortcuts({ palette: () => setPalette((p) => !p), help: () => setHelp(true), sidebar: toggleSidebar })
  useEffect(() => {
    setMobileNav(false)
  }, [location.pathname])
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollTo, which React would treat as a cleanup.
    window.scrollTo({ top: 0 })
  }, [location.pathname])

  return (
    <div className="flex min-h-full">
      <TopProgress />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[80] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground">
        Skip to content
      </a>
      <aside className={cn('hidden shrink-0 transition-[width] duration-200 lg:block', collapsed ? 'w-16' : 'w-64')}>
        <div className={cn('fixed inset-y-0 transition-[width] duration-200', collapsed ? 'w-16' : 'w-64')}>
          <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
        </div>
      </aside>
      <DialogPrimitive.Root open={mobileNav} onOpenChange={setMobileNav}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 lg:hidden" />
          <DialogPrimitive.Content
            className="fixed inset-y-0 left-0 z-50 w-72 data-[state=open]:animate-in data-[state=open]:slide-in-from-left lg:hidden"
            aria-describedby={undefined}
          >
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <Sidebar onNavigate={() => setMobileNav(false)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setMobileNav(true)} onSearch={() => setPalette(true)} onShortcuts={() => setHelp(true)} />
        <SupportBanner />
        <MfaBanner />
        <main id="main" className={cn('mx-auto w-full flex-1', fullBleed ? 'p-0' : cn(!wide && 'max-w-[1400px]', 'px-4 py-6 sm:px-8 sm:py-8'))}>
          {loading ? (
            <FullPageSpinner />
          ) : appError ? (
            appError instanceof ApiError && appError.status === 404 ? (
              <div className="py-20 text-center">
                <h1 className="text-xl font-semibold">Application not found</h1>
                <p className="mt-2 text-sm text-muted-foreground">It may have been deleted, or you no longer have access to it.</p>
                <Button asChild className="mt-6">
                  <Link to="/">Go to my workspace</Link>
                </Button>
              </div>
            ) : (
              <ErrorState error={appError} onRetry={() => window.location.reload()} />
            )
          ) : (
            <div key={location.pathname} className="animate-page-in">
              <Outlet />
            </div>
          )}
        </main>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} onShortcuts={() => setHelp(true)} />
      <AssistantPanel />
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
    </div>
  )
}

export function AppLayout() {
  return (
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  )
}
