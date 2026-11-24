/** Build tab: field palette, steps, the field list (drag to reorder) and the field inspector. */
import { useState, type DragEvent } from 'react'
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input, Textarea } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import { FIELD_TYPES, type FieldType, type FormField, type FormStep } from '@/types/forms'
import { FieldInspector } from './FieldInspector'
import { FIELD_META, newField, nextId, type TabProps } from './meta'
import { PreviewPane } from './PreviewPane'

export function BuildTab({ def, patch, meta, write }: TabProps) {
  const fields = def.fields
  const steps = def.steps
  const lastStep = steps.length - 1
  const stepOf = (f: FormField) => Math.min(f.step, lastStep)
  const [selected, setSelected] = useState<string | null>(fields[0]?.id ?? null)
  const [targetStep, setTargetStep] = useState(0)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const addTo = Math.min(targetStep, lastStep)
  const current = fields.find((f) => f.id === selected) ?? null

  const setFields = (fs: FormField[]) => patch({ fields: fs })
  const updateField = (id: string, p: Partial<FormField>) => setFields(fields.map((f) => (f.id === id ? { ...f, ...p } : f)))

  const add = (type: FieldType) => {
    const f = newField(type, fields.map((x) => x.id), addTo)
    // Insert after the last field of that step so the list stays grouped.
    const lastIdx = fields.map(stepOf).lastIndexOf(addTo)
    const next = [...fields]
    next.splice(lastIdx === -1 ? next.length : lastIdx + 1, 0, f)
    setFields(next)
    setSelected(f.id)
  }

  const remove = (id: string) => {
    setFields(fields.filter((f) => f.id !== id).map((f) => (f.condition?.field === id ? { ...f, condition: null } : f)))
    if (selected === id) setSelected(null)
  }

  const duplicate = (f: FormField) => {
    const copy = { ...f, id: nextId(f.type, fields.map((x) => x.id)), label: f.label ? `${f.label} (copy)`.slice(0, 300) : f.label, options: f.options.map((o) => ({ ...o })) }
    const i = fields.findIndex((x) => x.id === f.id)
    const next = [...fields]
    next.splice(i + 1, 0, copy)
    setFields(next)
    setSelected(copy.id)
  }

  /** Move within its step; at the edge, hop to the neighbouring step. */
  const move = (id: string, dir: -1 | 1) => {
    const i = fields.findIndex((f) => f.id === id)
    const f = fields[i]!
    const s = stepOf(f)
    const sameStep = fields.map((x, idx) => [x, idx] as const).filter(([x]) => stepOf(x) === s)
    const pos = sameStep.findIndex(([x]) => x.id === id)
    const neighbour = sameStep[pos + dir]
    const next = [...fields]
    if (neighbour) {
      next[i] = neighbour[0]
      next[neighbour[1]] = f
    } else if (s + dir >= 0 && s + dir <= lastStep) {
      next[i] = { ...f, step: s + dir }
    } else return
    setFields(next)
  }

  /** Drop `id` before `beforeId` (or at the end of `step`). */
  const dropAt = (id: string, step: number, beforeId: string | null) => {
    if (id === beforeId) return
    const f = fields.find((x) => x.id === id)
    if (!f) return
    const rest = fields.filter((x) => x.id !== id)
    const moved = { ...f, step }
    let idx = beforeId ? rest.findIndex((x) => x.id === beforeId) : -1
    if (idx === -1) {
      const lastIdx = rest.map(stepOf).lastIndexOf(step)
      idx = lastIdx === -1 ? rest.filter((x) => stepOf(x) < step).length : lastIdx + 1
    }
    rest.splice(idx, 0, moved)
    setFields(rest)
  }

  const onDrop = (e: DragEvent, step: number, beforeId: string | null) => {
    e.preventDefault()
    e.stopPropagation()
    const id = e.dataTransfer.getData('text/plain') || dragId
    if (id) dropAt(id, step, beforeId)
    setDragId(null)
    setOverId(null)
  }

  const setSteps = (s: FormStep[]) => patch({ steps: s })
  const addStep = () => {
    if (steps.length >= 10) return
    setSteps([...steps, { id: nextId(`step_${steps.length + 1}`, steps.map((s) => s.id)), title: '' }])
    setTargetStep(steps.length)
  }
  const removeStep = (i: number) => {
    if (steps.length <= 1) return
    patch({
      steps: steps.filter((_, j) => j !== i),
      fields: fields.map((f) => {
        const s = stepOf(f)
        return s > i || (s === i && i > 0) ? { ...f, step: s - 1 } : f
      }),
    })
    setTargetStep(0)
  }

  const groups: { step: FormStep; index: number; items: FormField[] }[] = steps.map((s, i) => ({ step: s, index: i, items: fields.filter((f) => stepOf(f) === i) }))
  const palette = (['Contact', 'Input', 'Choice', 'Other'] as const).map((g) => [g, FIELD_TYPES.filter((t) => FIELD_META[t].group === g)] as const)

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
      <fieldset disabled={!write} className="min-w-0 space-y-4">
        <legend className="sr-only">Form fields</legend>
        <Card>
          <CardContent className="grid grid-cols-1 gap-4 pt-5 sm:grid-cols-2">
            <Field label="Title" htmlFor="b-title" hint="Shown above the fields. Leave empty to hide it.">
              <Input id="b-title" value={def.title} maxLength={200} onChange={(e) => patch({ title: e.target.value })} placeholder="Get in touch" />
            </Field>
            <Field label="Description" htmlFor="b-desc">
              <Textarea id="b-desc" value={def.description} maxLength={1000} onChange={(e) => patch({ description: e.target.value })} className="min-h-[38px]" rows={2} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle>Add a field</CardTitle>
            {steps.length > 1 && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Add to
                <select className="h-8 rounded-md border bg-card px-2 text-xs" value={addTo} onChange={(e) => setTargetStep(Number(e.target.value))} aria-label="Add new fields to step">
                  {steps.map((s, i) => (
                    <option key={s.id} value={i}>
                      {s.title || `Step ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            {palette.map(([group, types]) => (
              <div key={group}>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group}</p>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {types.map((t) => {
                    const M = FIELD_META[t]
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => add(t)}
                        disabled={fields.length >= 60}
                        className="flex min-w-0 items-center gap-2 rounded-md border bg-card px-2.5 py-2 text-left text-xs font-medium transition hover:border-primary/50 hover:bg-accent/40 disabled:opacity-50"
                        data-testid={`add-${t}`}
                      >
                        <M.icon className="size-3.5 shrink-0 text-primary" />
                        <span className="truncate">{M.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card className="min-w-0">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Fields</CardTitle>
              <Button size="sm" variant="outline" onClick={addStep} disabled={steps.length >= 10} data-testid="add-step">
                <Plus /> Add step
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {steps.length === 1 && <p className="text-xs text-muted-foreground">Add a step to split a long form into pages with a progress bar.</p>}
              {groups.map(({ step, index, items }) => (
                <div
                  key={step.id}
                  className={cn('rounded-lg', steps.length > 1 && 'border p-2', dragId && 'min-h-[48px]')}
                  onDragOver={(e) => {
                    if (dragId) e.preventDefault()
                  }}
                  onDrop={(e) => onDrop(e, index, null)}
                  data-testid={`step-${index}`}
                >
                  {steps.length > 1 && (
                    <div className="mb-2 flex items-center gap-2">
                      <Badge variant="secondary" className="shrink-0">
                        Step {index + 1}
                      </Badge>
                      <Input
                        aria-label={`Step ${index + 1} title`}
                        className="h-8 min-w-0"
                        placeholder="Step title (optional)"
                        value={step.title}
                        maxLength={120}
                        onChange={(e) => setSteps(steps.map((s, j) => (j === index ? { ...s, title: e.target.value } : s)))}
                      />
                      <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`Remove step ${index + 1}`} onClick={() => removeStep(index)}>
                        <X />
                      </Button>
                    </div>
                  )}
                  {items.length === 0 ? (
                    <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{dragId ? 'Drop here' : 'No fields here yet. Add one above.'}</p>
                  ) : (
                    <ul className="space-y-1.5" aria-label={steps.length > 1 ? `Step ${index + 1} fields` : 'Fields'}>
                      {items.map((f) => {
                        const M = FIELD_META[f.type]
                        const first = fields.indexOf(f) === 0
                        const lastF = fields.indexOf(f) === fields.length - 1
                        return (
                          <li
                            key={f.id}
                            draggable={write}
                            onDragStart={(e) => {
                              e.dataTransfer.setData('text/plain', f.id)
                              e.dataTransfer.effectAllowed = 'move'
                              setDragId(f.id)
                            }}
                            onDragEnd={() => {
                              setDragId(null)
                              setOverId(null)
                            }}
                            onDragOver={(e) => {
                              if (!dragId) return
                              e.preventDefault()
                              e.stopPropagation()
                              setOverId(f.id)
                            }}
                            onDrop={(e) => onDrop(e, index, f.id)}
                            className={cn(
                              'group flex min-w-0 items-center gap-1.5 rounded-md border bg-card px-1.5 py-1.5 text-sm transition',
                              selected === f.id ? 'border-primary ring-1 ring-primary' : 'hover:border-primary/40',
                              dragId === f.id && 'opacity-50',
                              overId === f.id && dragId !== f.id && 'border-t-2 border-t-primary',
                            )}
                            data-testid="field-row"
                          >
                            <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
                            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setSelected(f.id)} aria-pressed={selected === f.id}>
                              <M.icon className="size-3.5 shrink-0 text-primary" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">
                                  {f.label || M.label}
                                  {f.required && <span className="text-destructive"> *</span>}
                                </span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  {M.label}
                                  {f.width === 'half' && ' · half width'}
                                  {f.condition && ' · conditional'}
                                </span>
                              </span>
                            </button>
                            <span className="flex shrink-0 items-center">
                              <Button variant="ghost" size="icon" className="size-7" aria-label={`Move ${f.label || M.label} up`} disabled={first} onClick={() => move(f.id, -1)}>
                                <ArrowUp />
                              </Button>
                              <Button variant="ghost" size="icon" className="size-7" aria-label={`Move ${f.label || M.label} down`} disabled={lastF} onClick={() => move(f.id, 1)}>
                                <ArrowDown />
                              </Button>
                              <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" aria-label={`Remove ${f.label || M.label}`} onClick={() => remove(f.id)}>
                                <Trash2 />
                              </Button>
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              ))}
              {!fields.some((f) => f.type === 'email' || f.type === 'phone') && fields.length > 0 && (
                <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong">Add an Email or Phone field so each submission can be matched to a contact.</p>
              )}
            </CardContent>
          </Card>

          <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
            {current ? (
              <FieldInspector key={current.id} field={current} fields={fields} steps={steps} meta={meta} onChange={(p) => updateField(current.id, p)} onDuplicate={() => duplicate(current)} onRemove={() => remove(current.id)} />
            ) : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">Select a field to edit its label, validation, mapping and logic.</CardContent>
              </Card>
            )}
          </div>
        </div>
      </fieldset>
      <PreviewPane def={def} meta={meta} selectedId={selected} onSelect={setSelected} />
    </div>
  )
}
