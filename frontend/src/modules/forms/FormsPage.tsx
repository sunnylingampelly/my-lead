/** Lead forms list and the "New form" template picker. */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CalendarDays,
  ClipboardList,
  Copy,
  FileDown,
  FilePlus2,
  Mail,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  PhoneCall,
  Plus,
  Presentation,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { formsApi, fqk, useFormsMeta, useForms, useFormTemplates } from '@/api/forms'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import { cn, timeAgo } from '@/lib/utils'
import type { FormListItem, FormStatus } from '@/types/forms'
import { STATUS_META } from './meta'

const TEMPLATE_ICON: Record<string, LucideIcon> = {
  newsletter: Mail,
  contact: MessageSquareText,
  demo: Presentation,
  event: CalendarDays,
  guide: FileDown,
  callback: PhoneCall,
  blank: FilePlus2,
}

export function FormStatusBadges({ status, changes }: { status: FormStatus; changes?: boolean }) {
  const m = STATUS_META[status] ?? STATUS_META.draft
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant={m.variant} data-testid="form-status">
        {m.label}
      </Badge>
      {changes && status !== 'draft' && <Badge variant="outline">Unpublished changes</Badge>}
    </span>
  )
}

export function FormsPage() {
  const { app, org, can } = useWorkspace()
  const appId = app!.id
  const navigate = useNavigate()
  const qc = useQueryClient()
  const q = useForms(appId)
  const meta = useFormsMeta(appId)
  const [creating, setCreating] = useState(false)
  const [del, setDel] = useState<FormListItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const write = can('forms.write')
  const base = `/apps/${appId}/forms`
  const f = (n: number) => formatCount(n, app!.default_country)
  const usage = meta.data?.usage
  const atLimit = !!usage && usage.limit !== null && usage.used >= usage.limit

  const duplicate = async (row: FormListItem) => {
    try {
      const d = await formsApi(appId).duplicate(row.id)
      await qc.invalidateQueries({ queryKey: fqk.all(appId) })
      toast.success('Form duplicated')
      navigate(`${base}/${d.id}`)
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'PLAN_LIMIT')) toast.error(errorMessage(e))
    }
  }

  const newButton = (variant: 'default' | 'outline' = 'default') =>
    write && (
      <Button variant={variant} onClick={() => setCreating(true)} data-testid="new-form">
        <Plus /> New form
      </Button>
    )

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${appId}` }, { label: 'Lead forms' }]}
        title="Lead forms"
        description="Capture leads on your website. Every submission lands in Contacts, the CRM and your automations."
        actions={
          <>
            {usage && usage.limit !== null && (
              <span className={cn('hidden text-xs sm:inline', atLimit ? 'font-medium text-warning-strong' : 'text-muted-foreground')} data-testid="forms-usage">
                {usage.used} of {usage.limit} forms
              </span>
            )}
            {newButton()}
          </>
        }
      />
      {usage && usage.limit !== null && (
        <p className={cn('-mt-3 mb-4 text-xs sm:hidden', atLimit ? 'font-medium text-warning-strong' : 'text-muted-foreground')}>
          {usage.used} of {usage.limit} forms on your plan
        </p>
      )}
      <Card className="min-w-0">
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.length ? (
          <EmptyState
            icon={ClipboardList}
            title="No lead forms yet"
            description="Start from a template, publish, and paste one line of code on your website. Leads appear here and in Contacts."
            action={newButton()}
          />
        ) : (
          <>
            {/* Phones: cards. */}
            <ul className="divide-y md:hidden">
              {q.data.map((row) => (
                <li key={row.id} className="flex items-start gap-3 p-4">
                  <button className="min-w-0 flex-1 text-left" onClick={() => navigate(`${base}/${row.id}`)}>
                    <div className="truncate font-medium">{row.name}</div>
                    <div className="mt-1">
                      <FormStatusBadges status={row.status} changes={row.has_unpublished_changes} />
                    </div>
                    <div className="mt-1.5 text-xs text-muted-foreground">
                      {f(row.views_30d)} views · {f(row.submissions_30d)} submissions · {row.conversion_30d.toFixed(1)}%
                    </div>
                  </button>
                  <RowMenu row={row} write={write} onOpen={() => navigate(`${base}/${row.id}`)} onDuplicate={() => duplicate(row)} onDelete={() => setDel(row)} />
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
              <Table>
                <THead>
                  <TR>
                    <TH>Form</TH>
                    <TH>Status</TH>
                    <TH className="text-right">Views</TH>
                    <TH className="text-right">Submissions</TH>
                    <TH className="text-right">Conversion</TH>
                    <TH>Last submission</TH>
                    <TH className="w-10" />
                  </TR>
                </THead>
                <TBody>
                  {q.data.map((row) => (
                    <TR key={row.id} className="cursor-pointer" onClick={() => navigate(`${base}/${row.id}`)} data-testid="form-row">
                      <TD>
                        <div className="font-medium">{row.name}</div>
                        <div className="text-xs text-muted-foreground">Edited {timeAgo(row.updated_at)}</div>
                      </TD>
                      <TD>
                        <FormStatusBadges status={row.status} changes={row.has_unpublished_changes} />
                      </TD>
                      <TD className="text-right tabular-nums">{f(row.views_30d)}</TD>
                      <TD className="text-right tabular-nums">{f(row.submissions_30d)}</TD>
                      <TD className="text-right tabular-nums">{row.views_30d ? `${row.conversion_30d.toFixed(1)}%` : '—'}</TD>
                      <TD className="whitespace-nowrap text-muted-foreground">{row.last_submission_at ? timeAgo(row.last_submission_at) : 'None yet'}</TD>
                      <TD onClick={(e) => e.stopPropagation()}>
                        <RowMenu row={row} write={write} onOpen={() => navigate(`${base}/${row.id}`)} onDuplicate={() => duplicate(row)} onDelete={() => setDel(row)} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <p className="border-t px-4 py-2 text-xs text-muted-foreground">Views, submissions and conversion cover the last 30 days.</p>
            </div>
          </>
        )}
      </Card>

      <NewFormDialog open={creating} onOpenChange={setCreating} atLimit={atLimit} limit={usage?.limit ?? null} />

      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete “${del?.name}”?`}
        description="The form stops working on every website it is embedded on, and its submission history is removed. Contacts it created stay in your audience."
        confirmLabel="Delete form"
        destructive
        loading={deleting}
        onConfirm={async () => {
          setDeleting(true)
          try {
            await formsApi(appId).remove(del!.id)
            await qc.invalidateQueries({ queryKey: fqk.all(appId) })
            toast.success('Form deleted')
            setDel(null)
          } catch (e) {
            toast.error(errorMessage(e))
          } finally {
            setDeleting(false)
          }
        }}
      />
    </>
  )
}

function RowMenu({ row, write, onOpen, onDuplicate, onDelete }: { row: FormListItem; write: boolean; onOpen: () => void; onDuplicate: () => void; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${row.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onOpen}>
          <Pencil /> Open
        </DropdownMenuItem>
        {write && (
          <>
            <DropdownMenuItem onSelect={onDuplicate}>
              <Copy /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={onDelete}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function NewFormDialog({ open, onOpenChange, atLimit, limit }: { open: boolean; onOpenChange: (o: boolean) => void; atLimit: boolean; limit: number | null }) {
  const { app, org } = useWorkspace()
  const appId = app!.id
  const navigate = useNavigate()
  const qc = useQueryClient()
  const templates = useFormTemplates(appId, open)
  const [template, setTemplate] = useState('contact')
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [limitMsg, setLimitMsg] = useState<string | null>(null)
  const picked = templates.data?.find((t) => t.key === template)
  const finalName = touched ? name : (picked?.name ?? name)

  const create = async () => {
    if (!finalName.trim()) return
    setBusy(true)
    setLimitMsg(null)
    try {
      const form = await formsApi(appId).create({ name: finalName.trim(), template })
      await qc.invalidateQueries({ queryKey: fqk.all(appId) })
      onOpenChange(false)
      navigate(`/apps/${appId}/forms/${form.id}`)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PLAN_LIMIT') setLimitMsg(e.message)
      else toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New lead form</DialogTitle>
          <DialogDescription>Pick a starting point. You can change every field, the design and what happens after submit.</DialogDescription>
        </DialogHeader>
        {(atLimit || limitMsg) && (
          <div className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-strong" role="alert">
            {limitMsg ?? `Your plan includes ${limit} lead forms.`}{' '}
            {org && (
              <a className="font-medium underline" href={`/orgs/${org.id}/billing`}>
                Upgrade to Pro
              </a>
            )}{' '}
            for unlimited forms, or delete a form you no longer use.
          </div>
        )}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Template">
          {templates.isLoading
            ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[72px]" />)
            : templates.data?.map((t) => {
                const Icon = TEMPLATE_ICON[t.key] ?? FilePlus2
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="radio"
                    aria-checked={template === t.key}
                    onClick={() => setTemplate(t.key)}
                    className={cn(
                      'flex items-start gap-3 rounded-lg border p-3 text-left transition hover:border-primary/50',
                      template === t.key && 'border-primary bg-accent/50 ring-1 ring-primary',
                    )}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-primary">
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{t.name}</span>
                      <span className="block text-xs text-muted-foreground">{t.description}</span>
                    </span>
                  </button>
                )
              })}
        </div>
        <Field label="Form name" htmlFor="nf-name" hint="Only your team sees this name.">
          <Input
            id="nf-name"
            value={finalName}
            maxLength={120}
            onChange={(e) => {
              setTouched(true)
              setName(e.target.value)
            }}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={create} loading={busy} disabled={!finalName.trim()} data-testid="create-form">
            Create form
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
