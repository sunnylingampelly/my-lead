import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/misc'
import { useTheme } from '@/hooks/useTheme'
import { useWorkspace } from '@/hooks/useWorkspace'
import { shortcutTargets } from './navigation'

const isTyping = (el: EventTarget | null) => {
  const t = el as HTMLElement | null
  return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
}

/** Global keyboard shortcuts. Ignored while typing in a field. */
export function useGlobalShortcuts(handlers: { palette: () => void; help: () => void; sidebar: () => void }) {
  const navigate = useNavigate()
  const { app, org } = useWorkspace()
  const { toggle } = useTheme()
  const pendingG = useRef<number | null>(null)
  const h = useRef(handlers)
  h.current = handlers

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        h.current.palette()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return
      const key = e.key.toLowerCase()
      if (pendingG.current) {
        window.clearTimeout(pendingG.current)
        pendingG.current = null
        const to = shortcutTargets(app, org)[key]
        if (to) {
          e.preventDefault()
          navigate(to)
        }
        return
      }
      if (key === 'g') {
        pendingG.current = window.setTimeout(() => (pendingG.current = null), 1200)
      } else if (e.key === '?') {
        e.preventDefault()
        h.current.help()
      } else if (key === '/') {
        const search = document.querySelector<HTMLInputElement>('[data-page-search]')
        if (search) {
          e.preventDefault()
          search.focus()
          search.select()
        }
      } else if (key === '[') {
        h.current.sidebar()
      } else if (e.shiftKey && key === 'd') {
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [app, org, navigate, toggle])
}

const GROUPS: { title: string; items: [string[], string][] }[] = [
  {
    title: 'General',
    items: [
      [['Ctrl', 'K'], 'Open command palette'],
      [['Ctrl', 'J'], 'Open the AI Assistant'],
      [['/'], 'Search on this page'],
      [['?'], 'Show keyboard shortcuts'],
      [['['], 'Collapse or expand sidebar'],
      [['Shift', 'D'], 'Toggle dark mode'],
    ],
  },
  {
    title: 'Go to',
    items: [
      [['G', 'D'], 'Overview'],
      [['G', 'A'], 'Audience'],
      [['G', 'M'], 'Email'],
      [['G', 'C'], 'All contacts'],
      [['G', 'S'], 'Segments'],
      [['G', 'L'], 'Lists'],
      [['G', 'I'], 'Import contacts'],
      [['G', 'E'], 'Application settings'],
      [['G', 'T'], 'Team'],
    ],
  },
]

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Work faster without the mouse. Shortcuts are disabled while typing in a field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</h4>
              <ul className="space-y-2">
                {g.items.map(([keys, label]) => (
                  <li key={label} className="flex items-center justify-between gap-3 text-sm">
                    <span>{label}</span>
                    <span className="flex gap-1">
                      {keys.map((k, i) => (
                        <span key={k} className="flex items-center gap-1">
                          {i > 0 && keys[0] === 'G' && <span className="text-[10px] text-muted-foreground">then</span>}
                          <Kbd>{k}</Kbd>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
