import axios, { AxiosError, type AxiosRequestConfig } from 'axios'
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

export const tokenStore = {
  get: () => accessToken,
  set: (t: string | null) => {
    accessToken = t
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
  if (!refreshPromise) {
    refreshPromise = axios
      .post<AuthResponse>('/api/v1/auth/refresh', null, { withCredentials: true })
      .then((r) => {
        accessToken = r.data.access_token
        return r.data
      })
      .catch(() => {
        accessToken = null
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
    if (body) throw new ApiError(status, body.code, body.message, body.details)
    if (!error.response) throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the server. Check your connection.')
    throw new ApiError(status, 'HTTP_ERROR', error.message)
  },
)

export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}
