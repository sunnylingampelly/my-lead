/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sentry DSN for browser error tracking. Unset = Sentry is never loaded. */
  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_ENVIRONMENT?: string
  readonly VITE_SENTRY_RELEASE?: string
}
