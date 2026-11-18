import { useEffect, useState } from 'react'
import { useIsFetching, useIsMutating } from '@tanstack/react-query'

/** Thin indeterminate bar while any request is in flight (shown after a short delay to avoid flicker). */
export function TopProgress() {
  const busy = useIsFetching() + useIsMutating() > 0
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!busy) {
      setVisible(false)
      return
    }
    const t = setTimeout(() => setVisible(true), 250)
    return () => clearTimeout(t)
  }, [busy])
  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5 overflow-hidden transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}
    >
      <div className="h-full w-1/3 animate-progress-indeterminate rounded-full bg-gradient-to-r from-transparent via-primary to-transparent" />
    </div>
  )
}
