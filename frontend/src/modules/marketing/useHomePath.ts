import { useAuth } from '@/hooks/useAuth'

/** "/" is the workspace for signed-in people, so links to home-page sections use /welcome for them. */
export function useHomePath() {
  const { status } = useAuth()
  return status === 'authenticated' ? '/welcome' : '/'
}
