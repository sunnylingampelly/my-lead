import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import {
  Building2,
  CornerDownLeft,
  Filter,
  Keyboard,
  LayoutGrid,
  Loader2,
  LogOut,
  type LucideIcon,
  Moon,
  Plus,
  Search,
  Sun,
  Upload,
  User,
  UserPlus,
  UserRound,
} from 'lucide-react'
import { audienceApi } from '@/api/audience'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/hooks/useTheme'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn } from '@/lib/utils'
import { appNav, orgNav } from './navigation'

interface Entry {
  id: string
  group: string
  label: string
  hint?: string
  icon: LucideIcon
  run: () => void
  keywords?: string
  shortcut?: string
}

const RECENT_KEY = 'sc-palette-recent'

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
  } catch {
    return []
  }
}

/** Ctrl/Cmd+K: actions, navigation, live contact search, and app/org switching. */
export function CommandPalette({ open, onOpenChange, onShortcuts }: { open: boolean; onOpenChange: (o: boolean) => void; onShortcuts: () => void }) {
  const navigate = useNavigate()
  const { orgs, apps, org, app, can, canOrg } = useWorkspace()
  const { resolved, toggle } = useTheme()
  const { logout } = useAuth()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200)
    return () => clearTimeout(t)
  }, [query])
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  const contacts = useQuery({
    queryKey: ['palette-contacts', app?.id, debounced],
    queryFn: () => audienceApi(app!.id).contacts({ search: debounced, page: 1, page_size: 6 }),
    enabled: open && !!app && debounced.length >= 2 && can('audience.read'),
    staleTime: 10_000,
  })

  const go = (to: string) => () => navigate(to)

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = []
    const base = app ? `/apps/${app.id}` : null
    if (base && can('audience.write')) {
      list.push({ id: 'a-contact', group: 'Actions', label: 'Add a contact', icon: UserPlus, run: go(`${base}/audience/contacts?new=1`), keywords: 'create new person' })
      list.push({ id: 'a-import', group: 'Actions', label: 'Import contacts from CSV or Excel', icon: Upload, run: go(`${base}/audience/import`), keywords: 'upload file xlsx' })
      list.push({ id: 'a-segment', group: 'Actions', label: 'Create a segment', icon: Filter, run: go(`${base}/audience/segments/new`), keywords: 'filter audience' })
    }
    if (org && canOrg('members.invite'))
      list.push({ id: 'a-invite', group: 'Actions', label: 'Invite a teammate', icon: UserPlus, run: go(`/orgs/${org.id}/team?invite=1`), keywords: 'member user' })
    if (org && canOrg('apps.create'))
      list.push({ id: 'a-app', group: 'Actions', label: 'Create an application', icon: Plus, run: go(`/onboarding/application?org=${org.id}`) })
    list.push({ id: 'a-theme', group: 'Actions', label: resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', icon: resolved === 'dark' ? Sun : Moon, run: toggle, keywords: 'theme appearance', shortcut: 'Shift D' })
    list.push({ id: 'a-keys', group: 'Actions', label: 'Keyboard shortcuts', icon: Keyboard, run: onShortcuts, shortcut: '?' })

    for (const item of [...appNav(app), ...orgNav(org)]) {
      if (item.to) list.push({ id: `n-${item.to}`, group: 'Go to', label: item.label, icon: item.icon, run: go(item.to), shortcut: item.shortcut })
      for (const c of item.children ?? [])
        list.push({ id: `n-${c.to}`, group: 'Go to', label: c.label, hint: item.label, icon: item.icon, run: go(c.to), shortcut: c.shortcut })
    }
    list.push({ id: 'n-account', group: 'Go to', label: 'Account and security', icon: User, run: go('/account'), keywords: 'profile password sessions' })

    for (const c of contacts.data?.items ?? [])
      list.push({
        id: `c-${c.id}`,
        group: 'Contacts',
        label: c.full_name || c.email || c.phone_display || 'Unnamed contact',
        hint: [c.email, c.phone_display].filter(Boolean).join(' · '),
        icon: UserRound,
        run: go(`/apps/${app!.id}/audience/contacts/${c.id}`),
        keywords: debounced,
      })
    for (const a of apps)
      if (a.id !== app?.id) list.push({ id: `app-${a.id}`, group: 'Switch application', label: a.name, hint: a.timezone, icon: LayoutGrid, run: go(`/apps/${a.id}`) })
    for (const o of orgs)
      if (o.id !== org?.id) list.push({ id: `org-${o.id}`, group: 'Switch organization', label: o.name, hint: o.role_label, icon: Building2, run: go(`/orgs/${o.id}/applications`) })
    list.push({
      id: 'a-logout',
      group: 'Actions',
      label: 'Sign out',
      icon: LogOut,
      run: async () => {
        await logout()
        navigate('/login')
      },
    })
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, org, apps, orgs, resolved, contacts.data, debounced])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      const recent = readRecent()
      const recentEntries = recent.map((id) => entries.find((e) => e.id === id)).filter(Boolean) as Entry[]
      return [
        ...recentEntries.map((e) => ({ ...e, group: 'Recent' })),
        ...entries.filter((e) => e.group !== 'Contacts' && !recent.includes(e.id)),
      ]
    }
    const words = q.split(/\s+/)
    return entries.filter((e) => {
      if (e.group === 'Contacts') return true
      const hay = `${e.label} ${e.hint ?? ''} ${e.group} ${e.keywords ?? ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [entries, query])

  useEffect(() => {
    setActive(0)
  }, [query, open])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (e?: Entry) => {
    if (!e) return
    try {
      const recent = [e.id, ...readRecent().filter((x) => x !== e.id)].slice(0, 4)
      if (!e.id.startsWith('c-')) localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
    } catch {
      /* ignore */
    }
    onOpenChange(false)
    e.run()
  }

  let lastGroup = ''
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-[12%] z-50 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-pop data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b px-4">
            {contacts.isFetching ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <Search className="size-4 text-muted-foreground" />}
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActive((i) => Math.min(i + 1, visible.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActive((i) => Math.max(i - 1, 0))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  run(visible[active])
                }
              }}
              placeholder={app ? 'Search contacts, pages and actions…' : 'Search pages and actions…'}
              className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
              aria-label="Command"
            />
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Esc</kbd>
          </div>
          <ul ref={listRef} className="max-h-[min(60vh,440px)] overflow-y-auto p-2" role="listbox">
            {visible.length === 0 && (
              <li className="px-3 py-10 text-center text-sm text-muted-foreground">
                {contacts.isFetching ? 'Searching…' : `No results for “${query}”`}
              </li>
            )}
            {visible.map((e, i) => {
              const header = e.group !== lastGroup
              lastGroup = e.group
              return (
                <li key={`${e.group}-${e.id}`}>
                  {header && <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground first:pt-1">{e.group}</div>}
                  <div
                    role="option"
                    data-index={i}
                    aria-selected={i === active}
                    onMouseMove={() => setActive(i)}
                    onClick={() => run(e)}
                    className={cn('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm', i === active && 'bg-accent text-accent-foreground')}
                  >
                    <e.icon className={cn('size-4 shrink-0', i === active ? 'text-accent-foreground' : 'text-muted-foreground')} />
                    <span className="truncate font-medium">{e.label}</span>
                    {e.hint && <span className="truncate text-xs text-muted-foreground">{e.hint}</span>}
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      {e.shortcut && <kbd className="rounded border bg-background px-1.5 font-mono text-[10px] text-muted-foreground">{e.shortcut}</kbd>}
                      {i === active && <CornerDownLeft className="size-3.5 text-muted-foreground" />}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="flex items-center gap-4 border-t bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
            <span>
              <kbd className="font-mono">↑↓</kbd> navigate
            </span>
            <span>
              <kbd className="font-mono">↵</kbd> open
            </span>
            {app && <span className="ml-auto">Type 2+ letters to search contacts in {app.name}</span>}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
