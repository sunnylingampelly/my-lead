import { Link, useNavigate } from 'react-router-dom'
import { BookOpen, Check, ChevronsUpDown, Keyboard, LogOut, Menu, Monitor, Moon, Plus, Search, ShieldCheck, Sun, User as UserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/tooltip'
import { useAuth, useUser } from '@/hooks/useAuth'
import { useTheme, type ThemePreference } from '@/hooks/useTheme'
import { useWorkspace } from '@/hooks/useWorkspace'
import { APP_COLORS, cn } from '@/lib/utils'
import { countryFlag } from '@/lib/regions'
import { NotificationsBell } from './NotificationsBell'

function Switcher({ label, value, children, testId, swatch }: { label: string; value: string; children: React.ReactNode; testId: string; swatch?: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-testid={testId}
          className="flex h-10 max-w-[240px] items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-muted data-[state=open]:bg-muted"
        >
          {swatch}
          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase leading-none tracking-wide text-muted-foreground">{label}</div>
            <div className="truncate font-medium leading-tight">{value}</div>
          </div>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Topbar({ onMenu, onSearch, onShortcuts }: { onMenu: () => void; onSearch: () => void; onShortcuts: () => void }) {
  const navigate = useNavigate()
  const user = useUser()
  const { logout } = useAuth()
  const { preference, setPreference, resolved, toggle } = useTheme()
  const { orgs, org, apps, app, canOrg } = useWorkspace()

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b bg-card/80 px-3 backdrop-blur-md supports-[backdrop-filter]:bg-card/70 sm:px-5">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onMenu} aria-label="Open navigation">
        <Menu />
      </Button>

      {org && (
        <Switcher
          label="Organization"
          value={org.name}
          testId="org-switcher"
          swatch={<span className="hidden size-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs sm:flex">{countryFlag(org.country)}</span>}
        >
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {orgs.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => navigate(`/orgs/${o.id}/applications`)}>
              <span className="flex-1 truncate">{o.name}</span>
              <span className="text-xs text-muted-foreground">{o.role_label}</span>
              {o.id === org.id && <Check />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate('/onboarding/organization')}>
            <Plus /> Create organization
          </DropdownMenuItem>
        </Switcher>
      )}
      {org && <span className="hidden text-muted-foreground/40 sm:inline">/</span>}
      {org && (
        <Switcher
          label="Application"
          value={app?.name ?? 'No application'}
          testId="app-switcher"
          swatch={app && <span className={cn('hidden size-2.5 shrink-0 rounded-full sm:block', APP_COLORS[app.color] ?? 'bg-indigo-500')} />}
        >
          <DropdownMenuLabel>Applications in {org.name}</DropdownMenuLabel>
          {apps.length === 0 && <div className="px-2 py-2 text-sm text-muted-foreground">No applications yet</div>}
          {apps.map((a) => (
            <DropdownMenuItem key={a.id} onSelect={() => navigate(`/apps/${a.id}`)}>
              <span className={cn('size-2 rounded-full', APP_COLORS[a.color] ?? 'bg-indigo-500')} />
              <span className="flex-1 truncate">{a.name}</span>
              {a.default_country && <span className="text-xs">{countryFlag(a.default_country)}</span>}
              {a.id === app?.id && <Check />}
            </DropdownMenuItem>
          ))}
          {canOrg('apps.create') && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate(`/onboarding/application?org=${org.id}`)}>
                <Plus /> New application
              </DropdownMenuItem>
            </>
          )}
        </Switcher>
      )}

      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={onSearch}
          className="group hidden h-9 w-72 items-center gap-2 rounded-lg border bg-background/60 px-3 text-sm text-muted-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-background md:flex"
        >
          <Search className="size-4" />
          <span className="flex-1 text-left">Search or jump to…</span>
          <kbd className="rounded border bg-muted px-1.5 font-mono text-[10px]">Ctrl K</kbd>
        </button>
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onSearch} aria-label="Search">
          <Search />
        </Button>
        <Tooltip content={resolved === 'dark' ? 'Light mode' : 'Dark mode'} shortcut="Shift D">
          <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme" data-testid="theme-toggle">
            {resolved === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </Tooltip>
        <NotificationsBell />
        <DropdownMenu>
          <Tooltip content="Help">
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Help">
                <BookOpen />
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel>Help</DropdownMenuLabel>
            <DropdownMenuItem onSelect={onShortcuts}>
              <Keyboard /> Keyboard shortcuts <span className="ml-auto font-mono text-xs text-muted-foreground">?</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onSearch}>
              <Search /> Command palette <span className="ml-auto font-mono text-xs text-muted-foreground">Ctrl K</span>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href="/docs" target="_blank" rel="noreferrer">
                <BookOpen /> API reference
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="ml-1 rounded-full ring-offset-2 ring-offset-background transition hover:ring-2 hover:ring-primary/30" aria-label="Account menu" data-testid="profile-menu">
              <Avatar name={user.full_name} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <div className="flex items-center gap-3 px-2 py-2">
              <Avatar name={user.full_name} className="size-9" />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{user.full_name}</div>
                <div className="truncate text-xs text-muted-foreground">{user.email}</div>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/account">
                <UserIcon /> Account and security
              </Link>
            </DropdownMenuItem>
            {user.is_platform_admin && (
              <DropdownMenuItem asChild>
                <Link to="/admin">
                  <ShieldCheck /> Platform admin
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {resolved === 'dark' ? <Moon /> : <Sun />} Appearance
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
                  <DropdownMenuRadioItem value="light">
                    <Sun /> Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <Moon /> Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <Monitor /> System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={async () => {
                await logout()
                navigate('/login')
              }}
            >
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
