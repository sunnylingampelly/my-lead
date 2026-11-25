/** Loaded lazily by errorTracking.ts only when VITE_SENTRY_DSN is set. Named imports keep the chunk small. */
import { init, setTag } from '@sentry/react'

export { init, setTag }
