/** Segments list, lists, list detail, tags, custom fields and suppression pages. */
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Ban, Filter, ListChecks, ListMinus, Pencil, Plus, SlidersHorizontal, Tag as TagIcon, Trash2, Users } from 'lucide-react'
import { audienceApi, aqk, useAttributes, useLists, useSegments, useTags } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, FullPageSpinner, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Pagination, TAG_COLORS, TagChip } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import { cn, formatDate, timeAgo } from '@/lib/utils'
import type { Attribute, Channel, ContactListInfo } from '@/types/audience'
import { ContactsTable } from './ContactsTable'

function useCrumbs(label: string, parent?: { label: string; to: string }) {
  const { app, org } = useWorkspace()
  const base = `/apps/${app!.id}/audience`
  return [
    { label: org?.name ?? '' },
    { label: app!.name, to: `/apps/${app!.id}` },
    { label: 'Audience', to: base },
    ...(parent ? [parent] : []),
    { label },
  ]
}

/** Shared delete-with-confirmation that surfaces "in use" conflicts from the API. */
function useDeleter() {
  const [target, setTarget] = useState<{ title: string; run: () => Promise<unknown> } | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = (
    <ConfirmDialog
      open={!!target}
      onOpenChange={(o) => !o && setTarget(null)}
      title={target?.title ?? ''}
      description="This cannot be undone. Contacts themselves are not deleted."
      confirmLabel="Delete"
      destructive
      loading={busy}
      onConfirm={async () => {
        if (!target) return
        setBusy(true)
        try {
          await target.run()
          setTarget(null)
        } catch (e) {
          toast.error(errorMessage(e))
        } finally {
          setBusy(false)
        }
      }}
    />
  )
  return { ask: setTarget, dialog }
}

// ------------------------------------------------------------------ segments

export function SegmentsPage() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const q = useSegments(appId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const del = useDeleter()
  const base = `/apps/${appId}/audience`
  const action = can('audience.write') && (
    <Button onClick={() => navigate(`${base}/segments/new`)}>
      <Plus /> New segment
    </Button>
  )
  return (
    <>
      <PageHeader breadcrumbs={useCrumbs('Segments')} title="Segments" description="Dynamic audiences built from rules. Counts are live." actions={action} />
      <Card>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data?.length === 0 ? (
          <EmptyState icon={Filter} title="No segments yet" description="For example: everyone in Hyderabad with an email address who is active." action={action} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Contacts</TH>
                <TH>Conditions</TH>
                <TH>Updated</TH>
                <TH className="w-28" />
              </TR>
            </THead>
            <TBody>
              {q.data?.map((s) => (
                <TR key={s.id}>
                  <TD>
                    <Link to={`${base}/segments/${s.id}/contacts`} className="font-medium hover:text-primary">
                      {s.name}
                    </Link>
                    {s.description && <div className="text-xs text-muted-foreground">{s.description}</div>}
                  </TD>
                  <TD className="tabular-nums">
                    {s.last_count === null ? <Badge variant="warning">Needs fixing</Badge> : formatCount(s.last_count, app!.default_country)}
                  </TD>
                  <TD className="text-muted-foreground">
                    {s.rules.conditions.length} · {s.rules.match === 'all' ? 'AND' : 'OR'}
                  </TD>
                  <TD className="text-muted-foreground">{timeAgo(s.updated_at)}</TD>
                  <TD>
                    {can('audience.write') && (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" asChild aria-label={`Edit ${s.name}`}>
                          <Link to={`${base}/segments/${s.id}`}>
                            <Pencil />
                          </Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${s.name}`}
                          onClick={() =>
                            del.ask({
                              title: `Delete segment “${s.name}”?`,
                              run: async () => {
                                await audienceApi(appId).deleteSegment(s.id)
                                await qc.invalidateQueries({ queryKey: aqk.all(appId) })
                                toast.success('Segment deleted')
                              },
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {del.dialog}
    </>
  )
}

export function SegmentContactsPage() {
  const { segmentId } = useParams()
  const { app, can } = useWorkspace()
  const appId = app!.id
  const base = `/apps/${appId}/audience`
  const seg = useQuery({ queryKey: [...aqk.segments(appId), segmentId], queryFn: () => audienceApi(appId).segment(segmentId!) })
  const crumbs = useCrumbs(seg.data?.name ?? 'Segment', { label: 'Segments', to: `${base}/segments` })
  if (seg.isLoading) return <FullPageSpinner />
  if (seg.isError) return <ErrorState error={seg.error} onRetry={() => seg.refetch()} />
  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={seg.data!.name}
        description={`${formatCount(seg.data!.last_count ?? 0, app!.default_country)} contacts currently match this segment.`}
        actions={
          can('audience.write') && (
            <Button variant="outline" asChild>
              <Link to={`${base}/segments/${segmentId}`}>
                <SlidersHorizontal /> Edit rules
              </Link>
            </Button>
          )
        }
      />
      <ContactsTable scope={{ segment_id: segmentId }} />
    </>
  )
}

// ------------------------------------------------------------------ lists

function ListDialog({ list, open, onOpenChange }: { list?: ContactListInfo; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const [name, setName] = useState(list?.name ?? '')
  const [description, setDescription] = useState(list?.description ?? '')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (o) {
          setName(list?.name ?? '')
          setDescription(list?.description ?? '')
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{list ? 'Edit list' : 'New list'}</DialogTitle>
          <DialogDescription>Lists are static: contacts stay in a list until removed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Name" htmlFor="l-name">
            <Input id="l-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description" htmlFor="l-desc">
            <Textarea id="l-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!name.trim()}
            onClick={async () => {
              setBusy(true)
              try {
                const api = audienceApi(app!.id)
                if (list) await api.updateList(list.id, { name, description: description || null })
                else await api.createList({ name, description: description || null })
                await qc.invalidateQueries({ queryKey: aqk.all(app!.id) })
                toast.success(list ? 'List updated' : 'List created')
                onOpenChange(false)
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ListsPage() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const q = useLists(appId)
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ContactListInfo | undefined>()
  const del = useDeleter()
  const base = `/apps/${appId}/audience`
  const action = can('audience.write') && (
    <Button
      onClick={() => {
        setEditing(undefined)
        setOpen(true)
      }}
    >
      <Plus /> New list
    </Button>
  )
  return (
    <>
      <PageHeader breadcrumbs={useCrumbs('Lists')} title="Lists" description="Static groups of contacts, for example event attendees or a campaign seed list." actions={action} />
      <Card>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data?.length === 0 ? (
          <EmptyState icon={ListChecks} title="No lists yet" description="Create a list, or add one while importing contacts." action={action} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Contacts</TH>
                <TH>Created</TH>
                <TH className="w-28" />
              </TR>
            </THead>
            <TBody>
              {q.data?.map((l) => (
                <TR key={l.id}>
                  <TD>
                    <Link to={`${base}/lists/${l.id}`} className="font-medium hover:text-primary">
                      {l.name}
                    </Link>
                    {l.description && <div className="text-xs text-muted-foreground">{l.description}</div>}
                  </TD>
                  <TD className="tabular-nums">{formatCount(l.contact_count, app!.default_country)}</TD>
                  <TD className="text-muted-foreground">{formatDate(l.created_at)}</TD>
                  <TD>
                    {can('audience.write') && (
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${l.name}`}
                          onClick={() => {
                            setEditing(l)
                            setOpen(true)
                          }}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${l.name}`}
                          onClick={() =>
                            del.ask({
                              title: `Delete list “${l.name}”?`,
                              run: async () => {
                                await audienceApi(appId).deleteList(l.id)
                                await qc.invalidateQueries({ queryKey: aqk.all(appId) })
                                toast.success('List deleted')
                              },
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <ListDialog key={editing?.id ?? 'new'} list={editing} open={open} onOpenChange={setOpen} />
      {del.dialog}
    </>
  )
}

export function ListDetailPage() {
  const { listId } = useParams()
  const { app, can } = useWorkspace()
  const appId = app!.id
  const qc = useQueryClient()
  const base = `/apps/${appId}/audience`
  const q = useQuery({ queryKey: [...aqk.lists(appId), listId], queryFn: () => audienceApi(appId).list(listId!) })
  const crumbs = useCrumbs(q.data?.name ?? 'List', { label: 'Lists', to: `${base}/lists` })
  if (q.isLoading) return <FullPageSpinner />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  return (
    <>
      <PageHeader
        breadcrumbs={crumbs}
        title={q.data!.name}
        description={q.data!.description ?? `${formatCount(q.data!.contact_count, app!.default_country)} contacts`}
      />
      <ContactsTable
        scope={{ list_id: listId }}
        emptyAction={
          <Button variant="outline" asChild>
            <Link to={`${base}/contacts`}>Add contacts from All contacts</Link>
          </Button>
        }
        extraBulk={(ids, clear) =>
          can('audience.write') &&
          ids.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  const r = await audienceApi(appId).removeFromList(listId!, ids)
                  await qc.invalidateQueries({ queryKey: aqk.all(appId) })
                  toast.success(`Removed ${r.removed} from list`)
                  clear()
                } catch (e) {
                  toast.error(errorMessage(e))
                }
              }}
            >
              <ListMinus /> Remove from list
            </Button>
          )
        }
      />
    </>
  )
}

// ------------------------------------------------------------------ tags

export function TagsPage() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const q = useTags(appId)
  const qc = useQueryClient()
  const del = useDeleter()
  const [name, setName] = useState('')
  const [color, setColor] = useState('indigo')
  const [editing, setEditing] = useState<{ id: string; name: string; color: string } | null>(null)
  const base = `/apps/${appId}/audience`
  const refresh = () => qc.invalidateQueries({ queryKey: aqk.all(appId) })
  const write = can('audience.write')
  return (
    <>
      <PageHeader breadcrumbs={useCrumbs('Tags')} title="Tags" description="Labels for organising contacts and building segments." />
      {write && (
        <Card className="mb-4 flex flex-col gap-2 p-3 sm:flex-row">
          <Input aria-label="New tag name" placeholder="New tag name" value={name} onChange={(e) => setName(e.target.value)} className="sm:max-w-xs" />
          <Select aria-label="Color" value={color} onChange={(e) => setColor(e.target.value)} className="sm:w-36">
            {Object.keys(TAG_COLORS).map((c) => (
              <option key={c} value={c} className="capitalize">
                {c}
              </option>
            ))}
          </Select>
          <Button
            disabled={!name.trim()}
            onClick={async () => {
              try {
                await audienceApi(appId).createTag({ name: name.trim(), color })
                setName('')
                await refresh()
                toast.success('Tag created')
              } catch (e) {
                toast.error(errorMessage(e))
              }
            }}
          >
            <Plus /> Create tag
          </Button>
        </Card>
      )}
      <Card>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data?.length === 0 ? (
          <EmptyState icon={TagIcon} title="No tags yet" description="Create tags here or add them during an import." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Tag</TH>
                <TH>Contacts</TH>
                <TH>Created</TH>
                <TH className="w-28" />
              </TR>
            </THead>
            <TBody>
              {q.data?.map((t) => (
                <TR key={t.id}>
                  <TD>
                    {editing?.id === t.id ? (
                      <div className="flex gap-2">
                        <Input aria-label="Tag name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="h-8 w-48" />
                        <Select aria-label="Tag color" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} className="h-8 w-28">
                          {Object.keys(TAG_COLORS).map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </Select>
                        <Button
                          size="sm"
                          onClick={async () => {
                            try {
                              await audienceApi(appId).updateTag(t.id, { name: editing.name, color: editing.color })
                              setEditing(null)
                              await refresh()
                            } catch (e) {
                              toast.error(errorMessage(e))
                            }
                          }}
                        >
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <TagChip name={t.name} color={t.color} />
                    )}
                  </TD>
                  <TD className="tabular-nums">
                    <Link className="hover:text-primary" to={`${base}/contacts`}>
                      {formatCount(t.contact_count, app!.default_country)}
                    </Link>
                  </TD>
                  <TD className="text-muted-foreground">{formatDate(t.created_at)}</TD>
                  <TD>
                    {write && editing?.id !== t.id && (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="icon" aria-label={`Rename ${t.name}`} onClick={() => setEditing({ id: t.id, name: t.name, color: t.color })}>
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${t.name}`}
                          onClick={() =>
                            del.ask({
                              title: `Delete tag “${t.name}”?`,
                              run: async () => {
                                await audienceApi(appId).deleteTag(t.id)
                                await refresh()
                                toast.success('Tag deleted')
                              },
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {del.dialog}
    </>
  )
}

// ------------------------------------------------------------------ custom fields

export function FieldsPage() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const q = useAttributes(appId)
  const qc = useQueryClient()
  const del = useDeleter()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ label: '', key: '', data_type: 'text' as Attribute['data_type'], options: '' })
  const [keyEdited, setKeyEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const write = can('audience.write')
  const toKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 60)
  const action = write && (
    <Button
      onClick={() => {
        setForm({ label: '', key: '', data_type: 'text', options: '' })
        setKeyEdited(false)
        setOpen(true)
      }}
    >
      <Plus /> New field
    </Button>
  )
  return (
    <>
      <PageHeader
        breadcrumbs={useCrumbs('Custom fields')}
        title="Custom fields"
        description="Extra contact attributes for this application, such as customer type or purchase amount. Usable in imports, segments and personalisation."
        actions={action}
      />
      <Card>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.data?.length === 0 ? (
          <EmptyState icon={SlidersHorizontal} title="No custom fields" description="Built-in fields cover name, email, phone, company and location." action={action} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Label</TH>
                <TH>Key</TH>
                <TH>Type</TH>
                <TH>Options</TH>
                <TH className="w-16" />
              </TR>
            </THead>
            <TBody>
              {q.data?.map((a) => (
                <TR key={a.id}>
                  <TD className="font-medium">{a.label}</TD>
                  <TD>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{`{{${a.key}}}`}</code>
                  </TD>
                  <TD className="capitalize">{a.data_type}</TD>
                  <TD className="max-w-xs truncate text-muted-foreground">{a.options.join(', ') || '—'}</TD>
                  <TD>
                    {write && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${a.label}`}
                        onClick={() =>
                          del.ask({
                            title: `Delete field “${a.label}”?`,
                            run: async () => {
                              await audienceApi(appId).deleteAttribute(a.id)
                              await qc.invalidateQueries({ queryKey: aqk.all(appId) })
                              toast.success('Field deleted')
                            },
                          })
                        }
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New custom field</DialogTitle>
            <DialogDescription>The key is permanent and is used in templates as {'{{key}}'}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Label" htmlFor="f-label">
              <Input
                id="f-label"
                autoFocus
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value, key: keyEdited ? f.key : toKey(e.target.value) }))}
                placeholder="Purchase amount"
              />
            </Field>
            <Field label="Key" htmlFor="f-key" hint="Lowercase letters, numbers and underscores.">
              <Input
                id="f-key"
                value={form.key}
                onChange={(e) => {
                  setKeyEdited(true)
                  setForm((f) => ({ ...f, key: toKey(e.target.value) }))
                }}
              />
            </Field>
            <Field label="Type" htmlFor="f-type">
              <Select id="f-type" value={form.data_type} onChange={(e) => setForm((f) => ({ ...f, data_type: e.target.value as Attribute['data_type'] }))}>
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="date">Date</option>
                <option value="boolean">Yes / No</option>
                <option value="select">Choice from a list</option>
              </Select>
            </Field>
            {form.data_type === 'select' && (
              <Field label="Options" htmlFor="f-opts" hint="One per line.">
                <Textarea id="f-opts" rows={3} value={form.options} onChange={(e) => setForm((f) => ({ ...f, options: e.target.value }))} placeholder={'Basic\nPremium'} />
              </Field>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!form.label.trim() || !form.key}
              onClick={async () => {
                setBusy(true)
                try {
                  await audienceApi(appId).createAttribute({
                    label: form.label.trim(),
                    key: form.key,
                    data_type: form.data_type,
                    options: form.data_type === 'select' ? form.options.split('\n').map((o) => o.trim()).filter(Boolean) : [],
                  })
                  await qc.invalidateQueries({ queryKey: aqk.all(appId) })
                  toast.success('Field created')
                  setOpen(false)
                } catch (e) {
                  toast.error(errorMessage(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Create field
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {del.dialog}
    </>
  )
}

// ------------------------------------------------------------------ suppression

export function SuppressionPage() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [channel, setChannel] = useState('')
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState('')
  const [form, setForm] = useState({ channel: 'email' as Channel, value: '', reason: 'manual', note: '' })
  const params = { page, page_size: 25, channel: channel || undefined, search: applied || undefined }
  const q = useQuery({ queryKey: aqk.suppressions(appId, params), queryFn: () => audienceApi(appId).suppressions(params) })
  const write = can('audience.write')
  const reasonVariant: Record<string, 'warning' | 'destructive' | 'secondary'> = {
    unsubscribed: 'warning',
    bounced: 'destructive',
    complaint: 'destructive',
    dnd: 'warning',
  }
  return (
    <>
      <PageHeader
        breadcrumbs={useCrumbs('Suppression list')}
        title="Suppression list"
        description="Addresses that will never receive marketing on a channel, even if they are re-imported. Values are stored masked and matched by a one-way hash."
      />
      {write && (
        <Card className="mb-4 flex flex-col gap-2 p-3 lg:flex-row">
          <Select aria-label="Channel" value={form.channel} onChange={(e) => setForm((f) => ({ ...f, channel: e.target.value as Channel }))} className="lg:w-32">
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="voice">Voice</option>
          </Select>
          <Input
            aria-label="Email or phone to suppress"
            placeholder={form.channel === 'email' ? 'name@example.com' : app!.default_country === 'US' ? '(415) 555-2671' : '98765 43210'}
            value={form.value}
            onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
            className="lg:max-w-xs"
          />
          <Select aria-label="Reason" value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} className="lg:w-44">
            <option value="manual">Manual block</option>
            <option value="dnd">Do-not-call / DND request</option>
            <option value="bounced">Hard bounce</option>
            <option value="invalid">Invalid address</option>
          </Select>
          <Input aria-label="Note" placeholder="Note (optional)" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          <Button
            disabled={form.value.trim().length < 3}
            onClick={async () => {
              try {
                await audienceApi(appId).addSuppression({ ...form, note: form.note || undefined })
                setForm((f) => ({ ...f, value: '', note: '' }))
                await qc.invalidateQueries({ queryKey: aqk.all(appId) })
                toast.success('Added to suppression list')
              } catch (e) {
                toast.error(errorMessage(e))
              }
            }}
          >
            <Ban /> Suppress
          </Button>
        </Card>
      )}
      <Card>
        <div className="flex flex-col gap-2 border-b p-3 sm:flex-row">
          <form
            className="flex flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              setPage(1)
              setApplied(search.trim())
            }}
          >
            <Input aria-label="Look up an address" placeholder="Look up an exact email or phone" value={search} onChange={(e) => setSearch(e.target.value)} className="sm:max-w-xs" />
            <Button type="submit" variant="outline">
              Look up
            </Button>
            {applied && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setSearch('')
                  setApplied('')
                }}
              >
                Clear
              </Button>
            )}
          </form>
          <Select aria-label="Filter channel" value={channel} onChange={(e) => setChannel(e.target.value)} className="sm:w-40">
            <option value="">All channels</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="voice">Voice</option>
          </Select>
        </div>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data?.items.length === 0 ? (
          <EmptyState icon={Users} title={applied ? 'Not suppressed' : 'Nothing suppressed yet'} description={applied ? 'That address is not on the suppression list.' : 'Unsubscribes, bounces and manual blocks appear here.'} />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Address</TH>
                  <TH>Channel</TH>
                  <TH>Reason</TH>
                  <TH>Source</TH>
                  <TH>Added</TH>
                  <TH className="w-16" />
                </TR>
              </THead>
              <TBody>
                {q.data?.items.map((s) => (
                  <TR key={s.id}>
                    <TD className="font-mono text-xs">{s.value_masked}</TD>
                    <TD className="uppercase">{s.channel}</TD>
                    <TD>
                      <Badge variant={reasonVariant[s.reason] ?? 'secondary'} className="capitalize">
                        {s.reason === 'dnd' ? 'DND' : s.reason}
                      </Badge>
                    </TD>
                    <TD className={cn('max-w-xs truncate text-muted-foreground')}>{[s.source, s.note].filter(Boolean).join(' · ') || '—'}</TD>
                    <TD className="text-muted-foreground">{formatDate(s.created_at)}</TD>
                    <TD>
                      {write && !['unsubscribed', 'complaint'].includes(s.reason) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Remove from suppression list"
                          onClick={async () => {
                            try {
                              await audienceApi(appId).removeSuppression(s.id)
                              await qc.invalidateQueries({ queryKey: aqk.all(appId) })
                              toast.success('Removed')
                            } catch (e) {
                              toast.error(errorMessage(e))
                            }
                          }}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={25} total={q.data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  )
}
