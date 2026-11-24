import axios, { AxiosError, type AxiosRequestConfig } from 'axios'
import { toast } from 'sonner'
import type { AuthResponse } from '@/types/api'

/**
 * HTTP client. The access token lives only in memory; the refresh token is an httpOnly
 * cookie scoped to /api/v1/auth. Expired access tokens are refreshed once, transparently.
 */
export class ApiError extends Error {
  status: number
  code: string
  details: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }

  /** Field-level messages from a 422 validation response, keyed by field name. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {}
    if (Array.isArray(this.details)) {
      for (const d of this.details as { loc?: string[]; msg?: string }[]) {
        const field = d.loc?.[d.loc.length - 1]
        if (field && d.msg) out[field] = d.msg.replace(/^Value error, /, '')
      }
    }
    return out
  }
}

let accessToken: string | null = null
let onSessionExpired: (() => void) | null = null
let refreshPromise: Promise<AuthResponse | null> | null = null

/**
 * Non-secret hint that this browser holds a refresh cookie. Lets an anonymous visitor skip the
 * refresh probe (an expected 401 that browsers log as a console error). '1' = signed in,
 * '0' = signed out, missing = unknown (probe once).
 */
const SESSION_HINT = 'sc-session-hint'
function setSessionHint(on: boolean) {
  try {
    localStorage.setItem(SESSION_HINT, on ? '1' : '0')
  } catch {
    /* storage unavailable: always probe */
  }
}
function sessionHintSaysSignedOut(): boolean {
  try {
    return localStorage.getItem(SESSION_HINT) === '0'
  } catch {
    return false
  }
}

export const tokenStore = {
  get: () => accessToken,
  set: (t: string | null) => {
    accessToken = t
    setSessionHint(!!t)
  },
  onExpired: (cb: () => void) => {
    onSessionExpired = cb
  },
}

export const http = axios.create({ baseURL: '/api/v1', withCredentials: true, timeout: 30000 })

http.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`
  return config
})

/** Single-flight refresh so parallel 401s trigger only one rotation. */
export function refreshSession(): Promise<AuthResponse | null> {
  if (!refreshPromise && !accessToken && sessionHintSaysSignedOut()) return Promise.resolve(null)
  if (!refreshPromise) {
    refreshPromise = axios
      .post<AuthResponse>('/api/v1/auth/refresh', null, { withCredentials: true })
      .then((r) => {
        accessToken = r.data.access_token
        setSessionHint(true)
        return r.data
      })
      .catch(() => {
        accessToken = null
        setSessionHint(false)
        return null
      })
      .finally(() => {
        refreshPromise = null
      })
  }
  return refreshPromise
}

const NO_RETRY = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout']

http.interceptors.response.use(
  (r) => r,
  async (error: AxiosError<{ error?: { code: string; message: string; details?: unknown } }>) => {
    const cfg = error.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined
    const status = error.response?.status ?? 0
    const code = error.response?.data?.error?.code
    if (
      status === 401 &&
      cfg &&
      !cfg._retried &&
      !NO_RETRY.some((p) => cfg.url?.endsWith(p)) &&
      (code === 'TOKEN_EXPIRED' || code === 'UNAUTHORIZED' || code === 'INVALID_TOKEN')
    ) {
      cfg._retried = true
      const refreshed = await refreshSession()
      if (refreshed) return http(cfg)
      onSessionExpired?.()
    } else if (status === 401 && code === 'SESSION_REVOKED') {
      accessToken = null
      onSessionExpired?.()
    }
    const body = error.response?.data?.error
    if (body?.code === 'INSUFFICIENT_BALANCE') showInsufficientBalance(body.message)
    if (body?.code === 'PLAN_LIMIT') showPlanLimit(body.message)
    if (body) throw new ApiError(status, body.code, body.message, body.details)
    if (!error.response) throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the server. Check your connection.')
    throw new ApiError(status, 'HTTP_ERROR', error.message)
  },
)

// ------------------------------------------------------------------ out of credit

/** Set by the app shell: where "Add credit" goes (the current organization's billing page). */
let addCreditHandler: (() => void) | null = null
export function setAddCreditHandler(fn: (() => void) | null) {
  addCreditHandler = fn
}

const BALANCE_TOAST_ID = 'insufficient-balance'
let balanceMessage: string | null = null
const baseToastError = toast.error

/**
 * Out-of-credit errors get an "Add credit" action wherever they surface. Pages usually call
 * toast.error(errorMessage(e)) themselves; toasts with the same message reuse one toast id, so the
 * user sees a single toast that carries the action.
 */
function balanceToastOptions() {
  return {
    id: BALANCE_TOAST_ID,
    duration: 10_000,
    action: addCreditHandler ? { label: 'Add credit', onClick: () => addCreditHandler?.() } : undefined,
  }
}
toast.error = ((message: Parameters<typeof toast.error>[0], data?: Parameters<typeof toast.error>[1]) =>
  balanceMessage !== null && message === balanceMessage
    ? baseToastError(message, { ...data, ...balanceToastOptions() })
    : planMessage !== null && message === planMessage
      ? baseToastError(message, { ...data, ...planToastOptions() })
      : baseToastError(message, data)) as typeof toast.error

function showInsufficientBalance(message: string) {
  balanceMessage = message
  toast.error(message)
}

// ------------------------------------------------------------------ plan limits

/** Set by the app shell: where "Upgrade" goes (the current organization's billing page, plan section). */
let upgradeHandler: (() => void) | null = null
export function setUpgradeHandler(fn: (() => void) | null) {
  upgradeHandler = fn
}

const PLAN_TOAST_ID = 'plan-limit'
let planMessage: string | null = null

/** Plan-limit errors (PLAN_LIMIT) get an "Upgrade" action, the same way out-of-credit errors get "Add credit". */
function planToastOptions() {
  return {
    id: PLAN_TOAST_ID,
    duration: 10_000,
    action: upgradeHandler ? { label: 'Upgrade', onClick: () => upgradeHandler?.() } : undefined,
  }
}

function showPlanLimit(message: string) {
  planMessage = message
  toast.error(message)
}

export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}
