import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { cqk } from '@/api/crm'

export function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = window.setTimeout(() => setD(v), ms)
    return () => window.clearTimeout(t)
  }, [v, ms])
  return d
}

/** Invalidate everything that a write to a record's activity can change. */
export function useRefreshRecord(appId: string) {
  const qc = useQueryClient()
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: cqk.timeline(appId) }),
      qc.invalidateQueries({ queryKey: cqk.notes(appId) }),
      qc.invalidateQueries({ queryKey: cqk.tasks(appId) }),
      qc.invalidateQueries({ queryKey: cqk.taskSummary(appId) }),
    ])
}
