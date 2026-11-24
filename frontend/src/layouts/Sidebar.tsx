import { useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { ChevronDown, ChevronsLeft, ChevronsRight, Clock3, ListChecks } from 'lucide-react'
import { useChecklist, useProvidersStatus } from '@/api/queries'
import { CHECKLIST_ANCHOR, useChecklistHidden } from '@/modules/dashboard/checklistState'
import { Logo } from '@/components/logo'
import { Tooltip } from '@/components/ui/tooltip'
import { useWorkspace } from '@/hooks/useWorkspace'
import { APP_COLORS, cn } from '@/lib/utils'
import { normaliseTimezone } from '@/lib/timezones'
import { appNav, orgNav, type NavItem } from './navigation'

function usePersistedFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : raw === '1'
    } catch {
      return initial
    }
  })
  return [
    v,
    (next) => {
      setV(next)
      try {
        localStorage.setItem(key, next ? '1' : '0')
      } catch {
        /* ignore */
      }
    },
  ]
}

const rowBase = 'group relative flex h-8 items-center gap-2.5 rounded-md text-[13px] font-medium transition-colors'

function Item({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate?: () => void }) {
  const Icon = item.icon
  const { pathname } = useLocation()
  const inSection = !!item.to && (pathname === item.to || !!item.children?.some((c) => pathname.startsWith(c.to)))
  const [pinnedOpen, setPinnedOpen] = usePersistedFlag(`sc-nav-open-${item.label}`, false)
  const expanded = !!item.children && !collapsed && (inSection || pinnedOpen)
  const base = cn(rowBase, collapsed ? 'w-8 justify-center' : 'px-2.5')

  const link = (
    <NavLink
      to={item.to!}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          base,
          !collapsed && item.children && 'pr-8',
          isActive || (collapsed && inSection)
            ? cn('bg-sidebar-accent text-white', !collapsed && 'before:absolute before:-left-2.5 before:h-4 before:w-[3px] before:rounded-r before:bg-indigo-400')
            : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-white',
        )
      }
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </NavLink>
  )

  if (collapsed)
    return (
      <div className="flex justify-center">
        {/* NavLink's function className cannot pass through Radix's Slot, so the tooltip wraps a span. */}
        <Tooltip content={item.label} side="right" shortcut={item.shortcut}>
          <span className="inline-flex">{link}</span>
        </Tooltip>
      </div>
    )

  return (
    <div>
      <div className="relative">
        {link}
        {item.children && !inSection && (
          <button
            type="button"
            onClick={() => setPinnedOpen(!pinnedOpen)}
            className="absolute right-1 top-1 flex size-6 items-center justify-center rounded text-sidebar-muted transition hover:bg-sidebar-accent hover:text-white"
            aria-label={`${expanded ? 'Hide' : 'Show'} ${item.label} pages`}
            aria-expanded={expanded}
          >
            <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="ml-[17px] mt-0.5 space-y-px border-l border-sidebar-border pl-2.5 animate-in fade-in-0 slide-in-from-top-1">
          {item.children!.map((c) => (
            <NavLink
              key={c.to}
              to={c.to}
              end={c.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex h-7 items-center rounded-md px-2 text-[12.5px] transition-colors',
                  isActive ? 'bg-sidebar-accent font-medium text-white' : 'text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-white',
                )
              }
            >
              {c.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

/** Modules on the roadmap, folded into one row so they inform without crowding the navigation. */
function ComingSoon({ items, collapsed }: { items: NavItem[]; collapsed: boolean }) {
  const [open, setOpen] = usePersistedFlag('sc-nav-soon-open', false)
  if (!items.length) return null
  if (collapsed)
    return (
      <div className="flex justify-center">
        <Tooltip content={`Coming soon: ${items.map((i) => i.label).join(', ')}`} side="right">
          <span className={cn(rowBase, 'w-8 cursor-default justify-center text-sidebar-muted/60')} aria-label="Coming soon">
            <Clock3 className="size-4" />
          </span>
        </Tooltip>
      </div>
    )
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(rowBase, 'w-full px-2.5 text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-white')}
        aria-expanded={open}
      >
        <Clock3 className="size-4 shrink-0" />
        <span className="flex-1 text-left">Coming soon</span>
        <span className="rounded bg-sidebar-accent px-1.5 text-[10px] font-semibold tabular-nums">{items.length}</span>
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="ml-[17px] mt-0.5 space-y-px border-l border-sidebar-border pl-2.5 animate-in fade-in-0 slide-in-from-top-1">
          {items.map((i) => (
            <Tooltip key={i.label} content={i.soon} side="right">
              <div className="flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-[12.5px] text-sidebar-muted/70" aria-disabled="true">
                <i.icon className="size-3.5" /> {i.label}
              </div>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  )
}

/** "Setup x/y" progress pill linking to the dashboard checklist; hidden when complete or dismissed. */
function SetupPill({ appId, collapsed, onNavigate }: { appId: string; collapsed: boolean; onNavigate?: () => void }) {
  const hidden = useChecklistHidden(appId)
  const q = useChecklist(appId, !hidden)
  if (hidden || !q.data?.length) return null
  const done = q.data.filter((c) => c.done).length
  if (done === q.data.length) return null
  const to = `/apps/${appId}#${CHECKLIST_ANCHOR}`
  const label = `Setup ${done}/${q.data.length}`
  if (collapsed)
    return (
      <Tooltip content={label} side="right">
        <Link to={to} onClick={onNavigate} aria-label={label} className="flex size-7 items-center justify-center rounded-md text-indigo-300 hover:bg-sidebar-accent hover:text-white">
          <ListChecks className="size-4" />
        </Link>
      </Tooltip>
    )
  return (
    <Link
      to={to}
      onClick={onNavigate}
      data-testid="setup-pill"
      className="flex items-center gap-1.5 rounded-full bg-indigo-500/20 px-2 py-0.5 text-[11px] font-medium text-indigo-200 transition hover:bg-indigo-500/30 hover:text-white"
    >
      <ListChecks className="size-3" /> {label}
    </Link>
  )
}

export function Sidebar({ collapsed = false, onToggle, onNavigate }: { collapsed?: boolean; onToggle?: () => void; onNavigate?: () => void }) {
  const { app, org } = useWorkspace()
  const all = appNav(app)
  const live = all.filter((i) => i.to)
  const soon = all.filter((i) => !i.to)
  const orgItems = orgNav(org)
  const providers = useProvidersStatus(app?.id, !!app?.permissions.includes('settings.read'))
  // Without app context (org pages) or status, assume simulation: it is the safe default.
  const simulation = providers.data?.simulation ?? true

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className={cn('flex h-14 shrink-0 items-center border-b border-sidebar-border', collapsed ? 'justify-center' : 'px-4')}>
        {collapsed ? (
          <svg viewBox="0 0 32 32" className="size-7" aria-label="Signalcraft">
            <rect width="32" height="32" rx="8" fill="#4f46e5" />
            <path d="M8 19c3-6 6-6 8 0s5 6 8 0" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" />
          </svg>
        ) : (
          <Logo inverted />
        )}
      </div>

      {app && !collapsed && (
        <div className="mx-3 mt-3 flex shrink-0 items-center gap-2.5 rounded-lg bg-sidebar-accent/60 px-2.5 py-2">
          <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white', APP_COLORS[app.color] ?? 'bg-indigo-500')}>
            {app.name.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-white">{app.name}</div>
            <div className="truncate text-[11px] text-sidebar-muted">{normaliseTimezone(app.timezone)}</div>
          </div>
        </div>
      )}

      <nav className={cn('sidebar-scroll flex-1 overflow-y-auto py-3', collapsed ? 'px-0' : 'px-2.5')} aria-label="Main">
        <div className="space-y-0.5">
          {live
            .filter((i) => i.label !== 'Settings')
            .map((i) => (
              <Item key={i.label} item={i} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
          <ComingSoon items={soon} collapsed={collapsed} />
          {live
            .filter((i) => i.label === 'Settings')
            .map((i) => (
              <Item key={i.label} item={i} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
        </div>
        {orgItems.length > 0 && (
          <div className="mt-4 space-y-0.5">
            {collapsed ? (
              <div className="mx-auto mb-2 h-px w-6 bg-sidebar-border" />
            ) : (
              <div className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted">Organization</div>
            )}
            {orgItems.map((i) => (
              <Item key={i.label} item={i} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
          </div>
        )}
      </nav>

      <div className={cn('flex min-h-11 shrink-0 items-center gap-2 border-t border-sidebar-border py-2', collapsed ? 'flex-col justify-center' : 'px-3')}>
        {app && <SetupPill appId={app.id} collapsed={collapsed} onNavigate={onNavigate} />}
        {!collapsed && org && simulation && (
          <Tooltip content="Simulation mode: messages are never sent to real people until a provider is connected." side="top">
            <span className="flex cursor-default items-center gap-1.5 rounded-full bg-sidebar-accent px-2 py-0.5 text-[11px] font-medium text-sidebar-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-amber-400" /> Simulation
            </span>
          </Tooltip>
        )}
        {onToggle && (
          <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="right" shortcut="[">
            <button
              onClick={onToggle}
              className={cn('flex size-7 items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-accent hover:text-white', !collapsed && 'ml-auto')}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
