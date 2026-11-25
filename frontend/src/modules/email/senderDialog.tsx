import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { emailApi, eqk } from '@/api/email'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/form-controls'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { Sender } from '@/types/email'

/** Add a sender address; reused inline by the campaign editor. */
export function AddSenderDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (s: Sender) => void }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const [form, setForm] = useState({ from_name: '', from_email: '', reply_to: '' })
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a sender</DialogTitle>
          <DialogDescription>We will email a confirmation link to this address. It can be used once confirmed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="From name" htmlFor="s-name" hint="Usually your brand, e.g. “Acme Deals”.">
            <Input id="s-name" value={form.from_name} onChange={(e) => setForm({ ...form, from_name: e.target.value })} />
          </Field>
          <Field label="From email" htmlFor="s-email" hint="Use an address on your own domain for the best deliverability.">
            <Input id="s-email" type="email" value={form.from_email} onChange={(e) => setForm({ ...form, from_email: e.target.value })} />
          </Field>
          <Field label="Reply-to (optional)" htmlFor="s-reply">
            <Input id="s-reply" type="email" value={form.reply_to} onChange={(e) => setForm({ ...form, reply_to: e.target.value })} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!form.from_name.trim() || !form.from_email.includes('@')}
            onClick={async () => {
              setBusy(true)
              try {
                const s = await emailApi(app!.id).createSender({ from_name: form.from_name, from_email: form.from_email, reply_to: form.reply_to || null })
                await qc.invalidateQueries({ queryKey: eqk.senders(app!.id) })
                toast.success(`Confirmation email sent to ${form.from_email}`)
                setForm({ from_name: '', from_email: '', reply_to: '' })
                onCreated?.(s)
                onOpenChange(false)
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Add and send confirmation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
