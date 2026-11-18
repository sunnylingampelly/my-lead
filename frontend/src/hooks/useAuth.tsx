import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { refreshSession, tokenStore } from '@/api/client'
import { authApi } from '@/api/services'
import type { AuthResponse, User } from '@/types/api'

type Status = 'loading' | 'authenticated' | 'anonymous'

interface AuthContextValue {
  status: Status
  user: User | null
  setUser: (u: User) => void
  acceptAuth: (r: AuthResponse) => void
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [user, setUserState] = useState<User | null>(null)
  const qc = useQueryClient()

  const clear = useCallback(() => {
    tokenStore.set(null)
    setUserState(null)
    setStatus('anonymous')
    qc.clear()
  }, [qc])

  useEffect(() => {
    tokenStore.onExpired(clear)
    // Restore the session from the httpOnly refresh cookie.
    refreshSession().then((r) => {
      if (r) {
        setUserState(r.user)
        setStatus('authenticated')
      } else {
        setStatus('anonymous')
      }
    })
  }, [clear])

  const acceptAuth = useCallback((r: AuthResponse) => {
    tokenStore.set(r.access_token)
    setUserState(r.user)
    setStatus('authenticated')
  }, [])

  const logout = useCallback(async () => {
    try {
      await authApi.logout()
    } finally {
      clear()
    }
  }, [clear])

  const value = useMemo(
    () => ({ status, user, setUser: setUserState, acceptAuth, logout }),
    [status, user, acceptAuth, logout],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

/** The signed-in user. Only use under a route guarded by RequireAuth. */
// eslint-disable-next-line react-refresh/only-export-components
export function useUser(): User {
  const { user } = useAuth()
  if (!user) throw new Error('No signed-in user')
  return user
}
