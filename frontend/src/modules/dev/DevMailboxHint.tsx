import { Link } from 'react-router-dom'
import { FlaskConical } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { devApi } from '@/api/services'

/** In simulation mode emails are written to a local mailbox instead of being sent.
 * Renders only when the backend exposes the development mailbox. */
export function DevMailboxHint({ email }: { email: string }) {
  const available = useQuery({ queryKey: ['dev', 'available'], queryFn: () => devApi.mailbox('__probe__'), retry: false })
  if (!available.isSuccess) return null
  return (
    <div className="mt-8 flex items-start gap-3 rounded-lg border border-dashed border-warning-border bg-warning-soft p-3 text-xs text-warning-strong">
      <FlaskConical className="mt-0.5 size-4 shrink-0" />
      <div>
        Simulation mode: no real email was sent.{' '}
        <Link to={`/dev/mailbox?to=${encodeURIComponent(email)}`} className="font-semibold underline" target="_blank">
          Open the development mailbox
        </Link>{' '}
        to read it.
      </div>
    </div>
  )
}
