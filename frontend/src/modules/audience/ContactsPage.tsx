import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Target, Upload, UserPlus } from 'lucide-react'
import { PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/hooks/useWorkspace'
import { ContactFormDialog } from './ContactFormDialog'
import { ContactsTable } from './ContactsTable'

export function ContactsPage() {
  const { app, org, can } = useWorkspace()
  const [open, setOpen] = useState(false)
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    if (params.get('new') === '1') {
      setOpen(true)
      const next = new URLSearchParams(params)
      next.delete('new')
      setParams(next, { replace: true })
    }
  }, [params, setParams])
  const navigate = useNavigate()
  const base = `/apps/${app!.id}/audience`
  const actions = (
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      {can('crm.read') && (
        <Button variant="ghost" asChild>
          <Link to={`/apps/${app!.id}/crm/leads`} title="Leads are contacts in an open lifecycle stage">
            <Target /> View as leads
          </Link>
        </Button>
      )}
      {can('audience.write') && (
        <>
      <Button variant="outline" asChild>
        <Link to={`${base}/import`}>
          <Upload /> Import
        </Link>
      </Button>
      <Button onClick={() => setOpen(true)}>
        <UserPlus /> Add contact
      </Button>
        </>
      )}
    </div>
  )
  const writeActions = can('audience.write') && (
    <>
      <Button variant="outline" asChild>
        <Link to={`${base}/import`}>
          <Upload /> Import
        </Link>
      </Button>
      <Button onClick={() => setOpen(true)}>
        <UserPlus /> Add contact
      </Button>
    </>
  )
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${app!.id}` }, { label: 'Audience', to: base }, { label: 'Contacts' }]}
        title="All contacts"
        description="Everyone in this application's audience. Click a row to open the profile."
        actions={actions}
      />
      <ContactsTable emptyAction={writeActions} syncUrl />
      <ContactFormDialog open={open} onOpenChange={setOpen} onSaved={(c) => navigate(`${base}/contacts/${c.id}`)} />
    </>
  )
}
