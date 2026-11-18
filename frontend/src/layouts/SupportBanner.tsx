import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Eye } from 'lucide-react'
import { staffApi } from '@/api/admin'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatDateTime } from '@/lib/utils'

/** Shown on every page while platform staff view a customer's workspace through a support session. */
export function SupportBanner() {
  const { org } = useWorkspace()
  const qc = useQueryClient()
  const navigate = useNavigate()
  if (!org?.support_access_expires_at) return null
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-warning-border bg-warning-soft px-4 py-2 text-sm text-warning-strong sm:px-8" role="status" data-testid="support-banner">
      <Eye className="size-4 shrink-0" />
      <span className="flex-1">
        <strong>Read-only support access</strong> to {org.name} until {formatDateTime(org.support_access_expires_at)}. Changes and exports are disabled, and this session is in their audit log.
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          try {
            const mine = await staffApi.sessions(true)
            const g = mine.find((s) => s.organization_id === org.id && s.active)
            if (g) await staffApi.endSession(g.id)
            await qc.invalidateQueries()
            navigate('/admin?tab=support')
          } catch (e) {
            toast.error(errorMessage(e))
          }
        }}
      >
        End session
      </Button>
    </div>
  )
}
