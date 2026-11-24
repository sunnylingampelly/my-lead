import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, ShieldCheck, UploadCloud } from 'lucide-react'
import { audienceApi, aqk, useAttributes, useImports, useLists } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, FullPageSpinner, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Checkbox } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { downloadFile } from '@/lib/download'
import { countryFlag, countryName, formatCount } from '@/lib/regions'
import { cn, formatDateTime } from '@/lib/utils'
import type { Attribute, ImportJob, ImportOptions, ImportValidation } from '@/types/audience'

const STEPS = ['Upload', 'Map columns', 'Validate', 'Configure', 'Import', 'Report']

const CORE_TARGETS: [string, string][] = [
  ['full_name', 'Full name (split into first and last)'],
  ['first_name', 'First name'],
  ['last_name', 'Last name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['company', 'Company (links to a CRM company)'],
  ['city', 'City'],
  ['state', 'State'],
  ['country', 'Country'],
  ['postal_code', 'Postal / PIN / ZIP code'],
  ['source', 'Source'],
  ['timezone', 'Timezone'],
  ['tags', 'Tags (comma separated)'],
  ['owner_email', 'Owner (team member email)'],
  ['lifecycle_stage', 'Lifecycle stage'],
]
const NEW_FIELD = '__new_field__'

const SAMPLE_CSV = [
  'first_name,last_name,email,phone,company,city,country,tags,owner_email,lifecycle_stage',
  'Asha,Rao,asha.rao@example.com,+919876543210,Acme Traders,Mumbai,IN,"vip,festive",,lead',
  'Jordan,Lee,jordan.lee@example.com,+15125550147,Globex Inc,Austin,US,webinar,,mql',
].join('\r\n')

function downloadSample() {
  const url = URL.createObjectURL(new Blob(['\ufeff' + SAMPLE_CSV + '\r\n'], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'contacts-sample.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const slug = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 60)

/** Create a custom field without leaving the import. Resolves with its key, or null. */
function NewFieldDialog({ column, onDone }: { column: string | null; onDone: (key: string | null) => void }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const [label, setLabel] = useState('')
  const [type, setType] = useState<Attribute['data_type']>('text')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (column !== null) {
      setLabel(column)
      setType('text')
    }
  }, [column])
  const key = slug(label)
  const save = async () => {
    setBusy(true)
    try {
      const a = await audienceApi(app!.id).createAttribute({ key, label: label.trim(), data_type: type, options: [] })
      await qc.invalidateQueries({ queryKey: aqk.attributes(app!.id) })
      await qc.invalidateQueries({ queryKey: aqk.fields(app!.id) })
      toast.success(`Custom field “${a.label}” created`)
      onDone(a.key)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={column !== null} onOpenChange={(o) => !o && !busy && onDone(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New custom field</DialogTitle>
          <DialogDescription>For the “{column}” column. It is added to every contact in this application.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (key) void save()
          }}
        >
          <Field label="Field name" htmlFor="nf-label" hint={key ? `Key: ${key}` : 'Start with a letter.'}>
            <Input id="nf-label" autoFocus value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Type" htmlFor="nf-type">
            <Select id="nf-type" value={type} onChange={(e) => setType(e.target.value as Attribute['data_type'])}>
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="date">Date</option>
              <option value="boolean">Yes / no</option>
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onDone(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!key}>
              Create field
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-2 text-xs font-medium">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={cn(
              'flex size-6 items-center justify-center rounded-full border',
              i < step ? 'border-primary bg-primary text-primary-foreground' : i === step ? 'border-primary text-primary' : 'text-muted-foreground',
            )}
          >
            {i < step ? '✓' : i + 1}
          </span>
          <span className={i === step ? 'text-foreground' : 'text-muted-foreground'}>{s}</span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
        </li>
      ))}
    </ol>
  )
}

function UploadStep() {
  const { app } = useWorkspace()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)

  const send = async (file?: File) => {
    if (!file) return
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!['csv', 'xlsx'].includes(ext ?? '')) return toast.error('Upload a .csv or .xlsx file')
    if (file.size > 20 * 1024 * 1024) return toast.error('Files can be at most 20 MB')
    setProgress(0)
    try {
      const imp = await audienceApi(app!.id).upload(file, setProgress)
      await qc.invalidateQueries({ queryKey: aqk.imports(app!.id) })
      navigate(`/apps/${app!.id}/audience/import/${imp.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
      setProgress(null)
    }
  }

  return (
    <Card>
      <CardContent className="p-6">
        <label
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            send(e.dataTransfer.files[0])
          }}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-14 text-center transition',
            dragging ? 'border-primary bg-accent' : 'hover:border-primary/50 hover:bg-muted/40',
          )}
        >
          <input ref={input} type="file" accept=".csv,.xlsx" className="sr-only" data-testid="import-file" onChange={(e) => send(e.target.files?.[0])} />
          {progress === null ? (
            <>
              <UploadCloud className="size-10 text-primary" />
              <p className="mt-3 text-sm font-medium">Drop a CSV or Excel file here, or click to browse</p>
              <p className="mt-1 text-xs text-muted-foreground">Up to 20 MB and 100,000 rows. The first row must contain column names.</p>
            </>
          ) : (
            <>
              <Loader2 className="size-8 animate-spin text-primary" />
              <p className="mt-3 text-sm font-medium">{progress < 100 ? `Uploading… ${progress}%` : 'Reading file…'}</p>
              <div className="mt-3 h-1.5 w-64 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
              </div>
            </>
          )}
        </label>
        <div className="mt-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
          <p>
            <strong className="text-foreground">Phone numbers:</strong> 10-digit Indian mobiles and US numbers are recognised using the application's
            default country. Include +91 or +1 for mixed lists.
          </p>
          <p>
            <strong className="text-foreground">Dates:</strong> ISO dates always work. Slash dates are read DD/MM/YYYY for India apps and MM/DD/YYYY for US apps.
          </p>
          <p>
            <strong className="text-foreground">Consent:</strong> imported contacts have no marketing consent unless you confirm it in step 4.
          </p>
        </div>
        <p className="mt-4 text-sm">
          <button type="button" onClick={downloadSample} className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
            <Download className="size-4" /> Download sample CSV
          </button>
          <span className="text-muted-foreground"> with every column we recognise, including owner and lifecycle stage.</span>
        </p>
      </CardContent>
    </Card>
  )
}

function MapStep({ imp, onValidated }: { imp: ImportJob; onValidated: (m: Record<string, string>, v: ImportValidation) => void }) {
  const { app } = useWorkspace()
  const attrs = useAttributes(app!.id)
  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    Object.keys(imp.mapping ?? {}).length ? imp.mapping : imp.suggested_mapping,
  )
  const [busy, setBusy] = useState(false)
  const [newFor, setNewFor] = useState<string | null>(null)
  const used = useMemo(() => new Set(Object.values(mapping).filter(Boolean)), [mapping])

  const validate = async () => {
    setBusy(true)
    try {
      const v = await audienceApi(app!.id).validateImport(imp.id, mapping)
      onValidated(mapping, v)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Map columns to contact fields</CardTitle>
        <CardDescription>
          {imp.file_name} · {formatCount(imp.total_rows, app!.default_country)} rows. Unmapped columns are ignored. For extra columns choose
          “+ New custom field…” in the list.
        </CardDescription>
      </CardHeader>
      <Table>
        <THead>
          <TR>
            <TH>Column in file</TH>
            <TH>Sample values</TH>
            <TH className="w-72">Import as</TH>
          </TR>
        </THead>
        <TBody>
          {imp.columns.map((col) => (
            <TR key={col}>
              <TD className="font-medium">{col}</TD>
              <TD className="max-w-xs truncate text-muted-foreground">
                {imp.preview
                  .map((r) => r[col])
                  .filter(Boolean)
                  .slice(0, 3)
                  .join(' · ') || '—'}
              </TD>
              <TD>
                <Select
                  aria-label={`Map ${col}`}
                  value={mapping[col] ?? ''}
                  onChange={(e) => (e.target.value === NEW_FIELD ? setNewFor(col) : setMapping((m) => ({ ...m, [col]: e.target.value })))}
                >
                  <option value="">Do not import</option>
                  <optgroup label="Contact fields">
                    {CORE_TARGETS.map(([k, label]) => (
                      <option key={k} value={k} disabled={used.has(k) && mapping[col] !== k}>
                        {label}
                      </option>
                    ))}
                  </optgroup>
                  {!!attrs.data?.length && (
                    <optgroup label="Custom fields">
                      {attrs.data.map((a) => (
                        <option key={a.id} value={`attr:${a.key}`} disabled={used.has(`attr:${a.key}`) && mapping[col] !== `attr:${a.key}`}>
                          {a.label} ({a.data_type})
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <option value={NEW_FIELD}>+ New custom field…</option>
                </Select>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <NewFieldDialog
        column={newFor}
        onDone={(key) => {
          if (key && newFor) setMapping((m) => ({ ...m, [newFor]: `attr:${key}` }))
          setNewFor(null)
        }}
      />
      <CardFooter>
        <Button onClick={validate} loading={busy} disabled={!used.has('email') && !used.has('phone')}>
          Validate {formatCount(imp.total_rows, app!.default_country)} rows
        </Button>
      </CardFooter>
    </Card>
  )
}

function ValidateStep({ v, onBack, onNext }: { v: ImportValidation; onBack: () => void; onNext: () => void }) {
  const { app } = useWorkspace()
  const f = (n: number) => formatCount(n, app!.default_country)
  const stats: [string, number, string][] = [
    ['Rows in file', v.total_rows, ''],
    ['Valid', v.valid_rows, 'text-success-strong'],
    ['New contacts', v.new_contacts, ''],
    ['Match existing', v.existing_matches, ''],
    ['Duplicates in file', v.duplicates_in_file, 'text-warning-strong'],
    ['Invalid', v.invalid_rows, 'text-danger-strong'],
  ]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Validation results</CardTitle>
        <CardDescription>Nothing has been imported yet. Invalid rows will be skipped and listed in the report.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {stats.map(([label, n, cls]) => (
            <div key={label} className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className={cn('text-xl font-semibold tabular-nums', cls)} data-testid={`v-${label}`}>
                {f(n)}
              </div>
            </div>
          ))}
        </div>
        {Object.keys(v.countries).length > 0 && (
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="text-muted-foreground">By country:</span>
            {Object.entries(v.countries).map(([c, n]) => (
              <Badge key={c} variant="secondary">
                {countryFlag(c)} {countryName(c)} · {f(n)}
              </Badge>
            ))}
          </div>
        )}
        {v.us_numbers > 0 && (
          <p className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-soft p-3 text-xs text-warning-strong">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {f(v.us_numbers)} US numbers found. Marketing SMS and calls to them need documented prior express written consent (TCPA).
          </p>
        )}
        {v.errors.length > 0 && (
          <div>
            <h4 className="mb-2 text-sm font-semibold">First problems found</h4>
            <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-sm">
              {v.errors.map((e) => (
                <li key={e.row} className="flex gap-3 px-3 py-1.5">
                  <span className="w-16 shrink-0 text-muted-foreground">Row {e.row}</span>
                  <span>{e.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      <CardFooter className="justify-between">
        <Button variant="outline" onClick={onBack}>
          Back to mapping
        </Button>
        <Button onClick={onNext} disabled={v.valid_rows === 0}>
          Continue
        </Button>
      </CardFooter>
    </Card>
  )
}

function ConfigureStep({ imp, mapping, v, onBack }: { imp: ImportJob; mapping: Record<string, string>; v: ImportValidation; onBack: () => void }) {
  const { app } = useWorkspace()
  const lists = useLists(app!.id)
  const qc = useQueryClient()
  const [opts, setOpts] = useState<ImportOptions>({
    duplicate_handling: 'skip',
    list_id: '',
    new_list_name: '',
    tag_names: [],
    source: 'import',
    create_companies: false,
    consent: { email: false, sms: false, voice: false, source: '', evidence: '', consent_reference: '', confirmed: false },
  })
  const [listMode, setListMode] = useState<'none' | 'existing' | 'new'>('none')
  const [tagText, setTagText] = useState('')
  const [busy, setBusy] = useState(false)
  const c = opts.consent
  const anyConsent = c.email || c.sms || c.voice
  const phoneConsent = c.sms || c.voice
  const ready = !anyConsent || (c.confirmed && !!c.source?.trim() && (!phoneConsent || !!c.evidence?.trim()))

  const start = async () => {
    setBusy(true)
    try {
      await audienceApi(app!.id).startImport(imp.id, mapping, {
        ...opts,
        list_id: listMode === 'existing' ? opts.list_id || null : null,
        new_list_name: listMode === 'new' ? opts.new_list_name || null : null,
        tag_names: tagText.split(',').map((t) => t.trim()).filter(Boolean),
      })
      await qc.invalidateQueries({ queryKey: aqk.import(app!.id, imp.id) })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configure import</CardTitle>
        <CardDescription>{formatCount(v.valid_rows, app!.default_country)} valid rows will be processed in the background.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Field label="When a row matches an existing contact" htmlFor="dup">
            <Select id="dup" value={opts.duplicate_handling} onChange={(e) => setOpts((o) => ({ ...o, duplicate_handling: e.target.value as 'skip' | 'update' }))}>
              <option value="skip">Skip it and keep the existing contact unchanged</option>
              <option value="update">Update it with non-empty values from the file</option>
            </Select>
          </Field>
          <Field label="Add imported contacts to a list" htmlFor="listmode">
            <Select id="listmode" value={listMode} onChange={(e) => setListMode(e.target.value as typeof listMode)}>
              <option value="none">Don't add to a list</option>
              <option value="existing" disabled={!lists.data?.length}>
                Existing list
              </option>
              <option value="new">Create a new list</option>
            </Select>
          </Field>
          {listMode === 'existing' && (
            <Select aria-label="List" value={opts.list_id ?? ''} onChange={(e) => setOpts((o) => ({ ...o, list_id: e.target.value }))}>
              <option value="">Choose a list…</option>
              {lists.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          )}
          {listMode === 'new' && (
            <Input aria-label="New list name" placeholder="List name" value={opts.new_list_name ?? ''} onChange={(e) => setOpts((o) => ({ ...o, new_list_name: e.target.value }))} />
          )}
          <Field label="Tags to add" htmlFor="tags" hint="Comma separated. New tags are created automatically.">
            <Input id="tags" value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="festive-2026, walk-in" />
          </Field>
          <Field label="Source label" htmlFor="srcl" hint="Stored on new contacts, e.g. 'trade-show-mumbai'.">
            <Input id="srcl" value={opts.source ?? ''} onChange={(e) => setOpts((o) => ({ ...o, source: e.target.value }))} />
          </Field>
          {Object.values(mapping).includes('company') && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={!!opts.create_companies} onChange={(e) => setOpts((o) => ({ ...o, create_companies: e.target.checked }))} />
              <span>
                Create companies from company names
                <span className="block text-xs text-muted-foreground">
                  Names matching an existing CRM company (or its email domain) are always linked. Tick this to also create the missing ones.
                </span>
              </span>
            </label>
          )}
        </div>

        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-primary" /> Marketing consent
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            By default nobody in this file is treated as consented. Select a channel only if every person in the file agreed to marketing on it.
            Existing unsubscribes are never overridden.
          </p>
          <div className="mt-3 flex flex-wrap gap-4">
            {(['email', 'sms', 'voice'] as const).map((ch) => (
              <label key={ch} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={c[ch]}
                  onChange={(e) => setOpts((o) => ({ ...o, consent: { ...o.consent, [ch]: e.target.checked } }))}
                />
                {ch === 'email' ? 'Email' : ch === 'sms' ? 'SMS' : 'Voice calls'}
              </label>
            ))}
          </div>
          {anyConsent && (
            <div className="mt-4 space-y-3">
              <Field label="Where was consent collected?" htmlFor="csrc">
                <Input id="csrc" value={c.source ?? ''} onChange={(e) => setOpts((o) => ({ ...o, consent: { ...o.consent, source: e.target.value } }))} placeholder="e.g. Online checkout opt-in, March–October 2026" />
              </Field>
              {phoneConsent && (
                <Field label="Consent evidence" htmlFor="cev" hint="Required for SMS and calls: TCPA written consent for US numbers; DLT consent records for India.">
                  <Textarea id="cev" rows={2} value={c.evidence ?? ''} onChange={(e) => setOpts((o) => ({ ...o, consent: { ...o.consent, evidence: e.target.value } }))} />
                </Field>
              )}
              {c.sms && v.india_numbers > 0 && (
                <Field label="DLT consent reference (optional)" htmlFor="cref">
                  <Input id="cref" value={c.consent_reference ?? ''} onChange={(e) => setOpts((o) => ({ ...o, consent: { ...o.consent, consent_reference: e.target.value } }))} />
                </Field>
              )}
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={c.confirmed}
                  onChange={(e) => setOpts((o) => ({ ...o, consent: { ...o.consent, confirmed: e.target.checked } }))}
                />
                <span>I confirm every contact in this file gave this consent and I can provide the records on request.</span>
              </label>
            </div>
          )}
        </div>
      </CardContent>
      <CardFooter className="justify-between">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={start} loading={busy} disabled={!ready || (listMode === 'existing' && !opts.list_id) || (listMode === 'new' && !opts.new_list_name?.trim())}>
          Start import
        </Button>
      </CardFooter>
    </Card>
  )
}

function ProgressStep({ imp }: { imp: ImportJob }) {
  const { app } = useWorkspace()
  const f = (n: number) => formatCount(n, app!.default_country)
  const qc = useQueryClient()
  const finished = ['completed', 'failed', 'cancelled'].includes(imp.status)
  const stats: [string, number, string][] = [
    ['Total', imp.total_rows, ''],
    ['Processed', imp.processed_rows, ''],
    ['Created', imp.created_count, 'text-success-strong'],
    ['Updated', imp.updated_count, 'text-success-strong'],
    ['Duplicates', imp.duplicate_count, 'text-warning-strong'],
    ['Skipped', imp.skipped_count, 'text-warning-strong'],
    ['Invalid', imp.invalid_count, 'text-danger-strong'],
    ['Failed', imp.failed_count, 'text-danger-strong'],
  ]
  const notImported = imp.duplicate_count + imp.skipped_count + imp.invalid_count + imp.failed_count

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {imp.status === 'completed' ? (
            <CheckCircle2 className="size-5 text-success-strong" />
          ) : finished ? (
            <AlertTriangle className="size-5 text-destructive" />
          ) : (
            <Loader2 className="size-5 animate-spin text-primary" />
          )}
          <span data-testid="import-status">
            {imp.status === 'completed' ? 'Import complete' : imp.status === 'failed' ? 'Import failed' : imp.status === 'cancelled' ? 'Import cancelled' : 'Importing…'}
          </span>
        </CardTitle>
        <CardDescription>
          {imp.file_name}
          {imp.completed_at && ` · finished ${formatDateTime(imp.completed_at)}`}
          {!finished && ' · You can leave this page; the import continues in the background.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>{imp.progress}%</span>
            <span>
              {f(imp.processed_rows)} of {f(imp.total_rows)} rows
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={imp.progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${imp.progress}%` }} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map(([label, n, cls]) => (
            <div key={label} className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className={cn('text-xl font-semibold tabular-nums', cls)} data-testid={`s-${label}`}>
                {f(n)}
              </div>
            </div>
          ))}
        </div>
        {imp.error && <p className="text-sm text-destructive">{imp.error}</p>}
      </CardContent>
      <CardFooter className="justify-between">
        <div>
          {!finished && (
            <Button
              variant="outline"
              onClick={async () => {
                await audienceApi(app!.id).cancelImport(imp.id).catch((e) => toast.error(errorMessage(e)))
                qc.invalidateQueries({ queryKey: aqk.import(app!.id, imp.id) })
              }}
            >
              Cancel import
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          {finished && notImported > 0 && (
            <Button
              variant="outline"
              onClick={() => downloadFile(audienceApi(app!.id).reportUrl(imp.id), 'import-report.csv').catch((e) => toast.error(errorMessage(e)))}
            >
              <Download /> Download report ({f(notImported)} rows)
            </Button>
          )}
          {finished && (
            <Button asChild>
              <Link to={`/apps/${app!.id}/audience/contacts`}>View contacts</Link>
            </Button>
          )}
        </div>
      </CardFooter>
    </Card>
  )
}

function ImportWizard({ importId }: { importId: string }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: aqk.import(app!.id, importId),
    queryFn: () => audienceApi(app!.id).import(importId),
    refetchInterval: (query) => (['queued', 'processing'].includes(query.state.data?.status ?? '') ? 1000 : false),
  })
  const [stage, setStage] = useState<'map' | 'validate' | 'configure'>('map')
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [validation, setValidation] = useState<ImportValidation | null>(null)

  useEffect(() => {
    if (q.data?.status === 'completed') qc.invalidateQueries({ queryKey: aqk.all(app!.id) })
  }, [q.data?.status, qc, app])

  if (q.isLoading) return <FullPageSpinner />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const imp = q.data!
  if (imp.status !== 'uploaded') {
    const finished = ['completed', 'failed', 'cancelled'].includes(imp.status)
    return (
      <>
        <Stepper step={finished ? 5 : 4} />
        <ProgressStep imp={imp} />
      </>
    )
  }
  const step = stage === 'map' ? 1 : stage === 'validate' ? 2 : 3
  return (
    <>
      <Stepper step={step} />
      {stage === 'map' && (
        <MapStep
          imp={imp}
          onValidated={(m, v) => {
            setMapping(m)
            setValidation(v)
            setStage('validate')
          }}
        />
      )}
      {stage === 'validate' && validation && <ValidateStep v={validation} onBack={() => setStage('map')} onNext={() => setStage('configure')} />}
      {stage === 'configure' && validation && <ConfigureStep imp={imp} mapping={mapping} v={validation} onBack={() => setStage('validate')} />}
    </>
  )
}

function History() {
  const { app } = useWorkspace()
  const q = useImports(app!.id)
  if (!q.data?.items.length) return null
  const variant = { completed: 'success', failed: 'destructive', cancelled: 'secondary', processing: 'default', queued: 'default', uploaded: 'outline' } as const
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Recent imports</CardTitle>
      </CardHeader>
      <Table>
        <THead>
          <TR>
            <TH>File</TH>
            <TH>Status</TH>
            <TH>Rows</TH>
            <TH>Created</TH>
            <TH>Updated</TH>
            <TH>Not imported</TH>
            <TH>Started</TH>
          </TR>
        </THead>
        <TBody>
          {q.data.items.map((i) => (
            <TR key={i.id}>
              <TD>
                <Link to={`/apps/${app!.id}/audience/import/${i.id}`} className="flex items-center gap-2 font-medium hover:text-primary">
                  <FileSpreadsheet className="size-4 text-muted-foreground" /> {i.file_name}
                </Link>
              </TD>
              <TD>
                <Badge variant={variant[i.status]} className="capitalize">
                  {i.status === 'uploaded' ? 'Not started' : i.status}
                </Badge>
              </TD>
              <TD className="tabular-nums">{i.total_rows.toLocaleString()}</TD>
              <TD className="tabular-nums">{i.created_count.toLocaleString()}</TD>
              <TD className="tabular-nums">{i.updated_count.toLocaleString()}</TD>
              <TD className="tabular-nums">{(i.duplicate_count + i.skipped_count + i.invalid_count + i.failed_count).toLocaleString()}</TD>
              <TD className="text-muted-foreground">{formatDateTime(i.created_at)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  )
}

export function ImportPage() {
  const { importId } = useParams()
  const { app, org, can } = useWorkspace()
  const base = `/apps/${app!.id}/audience`
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${app!.id}` }, { label: 'Audience', to: base }, { label: 'Import' }]}
        title="Import contacts"
        description="Bring contacts in from a CSV or Excel file. Large files are processed in the background."
        actions={
          importId && (
            <Button variant="outline" asChild>
              <Link to={`${base}/import`}>New import</Link>
            </Button>
          )
        }
      />
      {!can('audience.write') ? (
        <EmptyState title="You can't import contacts" description="Your role in this application is read-only." />
      ) : importId ? (
        <ImportWizard key={importId} importId={importId} />
      ) : (
        <>
          <Stepper step={0} />
          <UploadStep />
          <History />
        </>
      )}
    </>
  )
}
