import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FolderPlus, Loader2, Plus, Trash2, Users } from 'lucide-react'
import { audienceApi, aqk, useFieldCatalog } from '@/api/audience'
import { ApiError, errorMessage } from '@/api/client'
import { ErrorState, FullPageSpinner, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { CHANNEL_META, StatusBadge } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import { cn } from '@/lib/utils'
import type { Channel, FieldCatalog, FieldDef, SegmentCondition, SegmentGroup } from '@/types/audience'
import type { Lifecycle } from '@/types/crm'
import { LIFECYCLE_LABEL } from '../crm/format'

/** How a select option is shown: channel names, owner / stage names from option_labels, lifecycle labels. */
function optionLabel(field: FieldDef, o: string) {
  if (field.type === 'channel') return CHANNEL_META[o as Channel].label
  if (field.option_labels?.[o]) return field.option_labels[o]
  if (field.key === 'lifecycle_stage') return LIFECYCLE_LABEL[o as Lifecycle] ?? o
  return o
}

const OP_LABELS: Record<string, string> = {
  is: 'is',
  is_not: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  ends_with: 'ends with',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  gt: 'greater than',
  lt: 'less than',
  before: 'before',
  after: 'after',
  in_last_days: 'in the last X days',
  has_tag: 'has tag',
  not_has_tag: 'does not have tag',
  in_list: 'is in list',
  not_in_list: 'is not in list',
}
const NO_VALUE = new Set(['is_empty', 'is_not_empty'])

const newCondition = (): SegmentCondition => ({ type: 'condition', field: 'city', operator: 'is', value: '' })
const emptyRules = (): SegmentGroup => ({ type: 'group', match: 'all', conditions: [newCondition()] })

function ValueInput({ field, op, value, onChange, catalog }: { field?: FieldDef; op: string; value: unknown; onChange: (v: unknown) => void; catalog: FieldCatalog }) {
  if (!field || NO_VALUE.has(op)) return null
  const common = { 'aria-label': 'Value', className: 'sm:w-56' }
  if (field.type === 'tag' || field.type === 'list') {
    const items = field.type === 'tag' ? catalog.tags : catalog.lists
    return (
      <Select {...common} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a {field.type}…</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </Select>
    )
  }
  if (field.type === 'boolean')
    return (
      <Select {...common} value={value === false ? 'false' : 'true'} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    )
  if (field.type === 'select' || field.type === 'channel')
    return (
      <Select {...common} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.options?.length ? 'Choose…' : field.key === 'deal_stage' ? 'No pipeline stages yet' : 'No options'}</option>
        {field.options?.map((o) => (
          <option key={o} value={o}>
            {optionLabel(field, o)}
          </option>
        ))}
      </Select>
    )
  if (op === 'in_last_days')
    return <Input {...common} type="number" min={1} max={3650} placeholder="Days" value={String(value ?? '')} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
  if (field.type === 'date') return <Input {...common} type="date" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
  if (field.type === 'number')
    return <Input {...common} type="number" step="any" value={String(value ?? '')} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
  return <Input {...common} placeholder="Value" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
}

function ConditionRow({ cond, catalog, onChange, onRemove }: { cond: SegmentCondition; catalog: FieldCatalog; onChange: (c: SegmentCondition) => void; onRemove: () => void }) {
  const field = catalog.fields.find((f) => f.key === cond.field)
  const groups = useMemo(() => [...new Set(catalog.fields.map((f) => f.group))], [catalog])
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card p-2 sm:flex-row sm:items-center" data-testid="condition">
      <Select
        aria-label="Field"
        className="sm:w-56"
        value={cond.field}
        onChange={(e) => {
          const f = catalog.fields.find((x) => x.key === e.target.value)!
          onChange({ type: 'condition', field: f.key, operator: f.operators[0]!, value: f.type === 'boolean' ? true : '' })
        }}
      >
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {catalog.fields
              .filter((f) => f.group === g)
              .map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
          </optgroup>
        ))}
      </Select>
      <Select aria-label="Operator" className="sm:w-48" value={cond.operator} onChange={(e) => onChange({ ...cond, operator: e.target.value })}>
        {field?.operators.map((o) => (
          <option key={o} value={o}>
            {OP_LABELS[o] ?? o}
          </option>
        ))}
      </Select>
      <ValueInput field={field} op={cond.operator} value={cond.value} catalog={catalog} onChange={(v) => onChange({ ...cond, value: v })} />
      <Button variant="ghost" size="icon" className="sm:ml-auto" onClick={onRemove} aria-label="Remove condition">
        <Trash2 />
      </Button>
    </div>
  )
}

export function GroupEditor({ group, catalog, onChange, onRemove, depth }: { group: SegmentGroup; catalog: FieldCatalog; onChange: (g: SegmentGroup) => void; onRemove?: () => void; depth: number }) {
  const set = (i: number, c: SegmentCondition | SegmentGroup) => onChange({ ...group, conditions: group.conditions.map((x, j) => (j === i ? c : x)) })
  const remove = (i: number) => onChange({ ...group, conditions: group.conditions.filter((_, j) => j !== i) })
  return (
    <div className={cn('space-y-2 rounded-lg border p-3', depth === 0 ? 'bg-muted/30' : 'border-dashed bg-background')}>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Match</span>
        <div className="inline-flex rounded-md border bg-card p-0.5" role="radiogroup" aria-label="Match">
          {(['all', 'any'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={group.match === m}
              onClick={() => onChange({ ...group, match: m })}
              className={cn('rounded px-2.5 py-1 text-xs font-semibold uppercase', group.match === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}
            >
              {m === 'all' ? 'AND' : 'OR'}
            </button>
          ))}
        </div>
        <span className="text-muted-foreground">{group.match === 'all' ? 'all of these conditions' : 'any of these conditions'}</span>
        {onRemove && (
          <Button variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={onRemove}>
            <Trash2 /> Remove group
          </Button>
        )}
      </div>
      {group.conditions.map((c, i) => (
        <div key={i} className="relative">
          {i > 0 && <div className="mb-1 pl-2 text-[11px] font-semibold uppercase text-primary">{group.match === 'all' ? 'and' : 'or'}</div>}
          {c.type === 'group' ? (
            <GroupEditor group={c} catalog={catalog} depth={depth + 1} onChange={(g) => set(i, g)} onRemove={() => remove(i)} />
          ) : (
            <ConditionRow cond={c} catalog={catalog} onChange={(x) => set(i, x)} onRemove={() => remove(i)} />
          )}
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={() => onChange({ ...group, conditions: [...group.conditions, newCondition()] })}>
          <Plus /> Add condition
        </Button>
        {depth < 3 && (
          <Button variant="ghost" size="sm" onClick={() => onChange({ ...group, conditions: [...group.conditions, { type: 'group', match: 'any', conditions: [newCondition()] }] })}>
            <FolderPlus /> Add condition group
          </Button>
        )}
      </div>
    </div>
  )
}

export function SegmentBuilderPage() {
  const { segmentId } = useParams()
  const { app, org, can } = useWorkspace()
  const appId = app!.id
  const api = audienceApi(appId)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const catalog = useFieldCatalog(appId)
  const existing = useQuery({ queryKey: [...aqk.segments(appId), segmentId], queryFn: () => api.segment(segmentId!), enabled: !!segmentId })
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [rules, setRules] = useState<SegmentGroup>(emptyRules)
  const [debounced, setDebounced] = useState(rules)
  const [saving, setSaving] = useState(false)
  const base = `/apps/${appId}/audience`

  useEffect(() => {
    if (existing.data) {
      setName(existing.data.name)
      setDescription(existing.data.description ?? '')
      setRules(existing.data.rules)
    }
  }, [existing.data])
  useEffect(() => {
    const t = setTimeout(() => setDebounced(rules), 400)
    return () => clearTimeout(t)
  }, [rules])

  const preview = useQuery({
    queryKey: [...aqk.all(appId), 'preview', debounced],
    queryFn: () => api.previewSegment(debounced),
    retry: false,
    placeholderData: (p) => p,
  })
  const previewError = preview.error instanceof ApiError ? preview.error : null

  if ((segmentId && existing.isLoading) || catalog.isLoading) return <FullPageSpinner />
  if (catalog.isError) return <ErrorState error={catalog.error} onRetry={() => catalog.refetch()} />

  const save = async () => {
    if (!name.trim()) return toast.error('Give the segment a name')
    setSaving(true)
    try {
      const body = { name: name.trim(), description: description || null, rules }
      const s = segmentId ? await api.updateSegment(segmentId, body) : await api.createSegment(body)
      await qc.invalidateQueries({ queryKey: aqk.segments(appId) })
      toast.success(`Segment saved · ${s.last_count?.toLocaleString()} contacts`)
      navigate(`${base}/segments`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${appId}` }, { label: 'Segments', to: `${base}/segments` }, { label: segmentId ? name || 'Segment' : 'New segment' }]}
        title={segmentId ? `Edit ${existing.data?.name ?? 'segment'}` : 'New segment'}
        description="Segments are dynamic: membership is recalculated every time the segment is used."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to={`${base}/segments`}>Cancel</Link>
            </Button>
            {can('audience.write') && (
              <Button onClick={save} loading={saving} disabled={!!previewError}>
                Save segment
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Card>
            <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
              <Field label="Segment name" htmlFor="seg-name">
                <Input id="seg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Hyderabad Customers" />
              </Field>
              <Field label="Description" htmlFor="seg-desc">
                <Textarea id="seg-desc" rows={1} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
              </Field>
            </CardContent>
          </Card>
          <GroupEditor group={rules} catalog={catalog.data!} depth={0} onChange={setRules} />
        </div>

        <Card className="h-fit xl:sticky xl:top-20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Preview {preview.isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {previewError ? (
              <p className="rounded-md border border-warning-border bg-warning-soft p-3 text-sm text-warning-strong">{previewError.message}</p>
            ) : preview.data ? (
              <>
                <div>
                  <div className="text-3xl font-semibold tabular-nums" data-testid="segment-count">
                    {formatCount(preview.data.count, app!.default_country)}
                  </div>
                  <div className="text-xs text-muted-foreground">matching contacts</div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(['email', 'sms', 'voice'] as Channel[]).map((ch) => {
                    const Icon = CHANNEL_META[ch].icon
                    return (
                      <div key={ch} className="rounded-md border p-2 text-center">
                        <Icon className="mx-auto size-4 text-muted-foreground" />
                        <div className="mt-1 text-sm font-semibold tabular-nums">{preview.data.eligible[ch].toLocaleString()}</div>
                        <div className="text-[10px] text-muted-foreground">reachable</div>
                      </div>
                    )
                  })}
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Sample</div>
                  {preview.data.sample.length === 0 ? (
                    <p className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                      <Users className="size-4" /> No contacts match yet
                    </p>
                  ) : (
                    <ul className="divide-y text-sm">
                      {preview.data.sample.map((c) => (
                        <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
                          <span className="truncate">{c.full_name || c.email || c.phone_display}</span>
                          <StatusBadge status={c.status} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Calculating…</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
