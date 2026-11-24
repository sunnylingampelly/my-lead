import { useSyncExternalStore } from 'react'

/** Per-application "Hide checklist" flag, shared by the dashboard card and the sidebar's setup pill. */
const key = (appId: string) => `sc-checklist-hidden-${appId}`
const EVENT = 'sc-checklist-hidden'

function read(appId: string): boolean {
  try {
    return localStorage.getItem(key(appId)) === '1'
  } catch {
    return false
  }
}

export function setChecklistHidden(appId: string, hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(key(appId), '1')
    else localStorage.removeItem(key(appId))
  } catch {
    /* storage unavailable: the flag lasts for this page view only */
  }
  memory.set(appId, hidden)
  window.dispatchEvent(new Event(EVENT))
}

// Fallback when storage throws, so hiding still works until reload.
const memory = new Map<string, boolean>()

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

export function useChecklistHidden(appId: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => (appId ? memory.get(appId) ?? read(appId) : false))
}

/** Anchor of the checklist card on the dashboard. */
export const CHECKLIST_ANCHOR = 'getting-started'
