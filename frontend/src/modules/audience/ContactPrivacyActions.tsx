import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Download, ShieldAlert, Trash2 } from 'lucide-react'
import { aqk } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { privacyApi } from '@/api/services'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input } from '@/components/ui/form-controls'
import { downloadFile } from '@/lib/download'

/** Data-subject rights on a contact profile (owners/admins): download all data, erase everywhere. */
export function ContactPrivacyActions({ appId, contactId, name }: { appId: string; contactId: string; name: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  const download = async () => {
    try {
      await downloadFile(privacyApi.exportUrl(appId, contactId), `contact-data-${contactId.slice(0, 8)}.zip`)
      toast.success('Download started. The export is recorded in Data requests.')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const erase = async () => {
    setBusy(true)
    try {
      await privacyApi.eraseContact(appId, contactId, typed.trim())
      await qc.invalidateQueries({ queryKey: aqk.all(appId) })
      toast.success('Contact erased. They stay suppressed so they are never messaged or imported again.')
      navigate(`/apps/${appId}/audience/contacts`, { replace: true })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" data-testid="privacy-menu">
            <ShieldAlert /> Privacy
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={download}>
            <Download className="size-4" /> Download all data
          </DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onSelect={() => { setTyped(''); setOpen(true) }}>
            <Trash2 className="size-4" /> Erase this contact
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Erase ${name}?`}
        description={
          <>
            This permanently deletes the contact and removes their personal data everywhere: messages, call
            recordings' transcripts, chats, form submissions, CRM notes and import rows. Campaign totals are kept
            without their details, and their hashed address stays suppressed. This cannot be undone.
          </>
        }
        confirmLabel="Erase permanently"
        destructive
        loading={busy}
        confirmDisabled={typed.trim() !== 'ERASE'}
        onConfirm={erase}
      >
        <Field label='Type "ERASE" to confirm' htmlFor="erase-confirm">
          <Input id="erase-confirm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </>
  )
}
