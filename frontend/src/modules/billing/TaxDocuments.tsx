/**
 * GST documents on the Billing page: billing details (who invoices are made out to), tax invoices issued for
 * top-ups, monthly usage statements, and the "₹1,000 + ₹180 GST = ₹1,180" breakdown shown before paying.
 */
import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Download, FileText, Receipt, Save } from 'lucide-react'
import { billingApi, bqk, type BillingProfileInput, useBillingProfile } from '@/api/billing'
import { errorMessage } from '@/api/client'
import { EmptyState, LoadingRows } from '@/components/page'
import { Pagination } from '@/components/audience'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { downloadFile } from '@/lib/download'
import { EMIRATES } from '@/lib/regions'
import { formatMoney } from '../sms/format'

const GSTIN_RE = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Same rule as the server: format plus the mod-36 check character. */
function gstinValid(v: string) {
  if (!GSTIN_RE.test(v)) return false
  let total = 0
  for (let i = 0; i < 14; i++) {
    const p = GSTIN_CHARS.indexOf(v[i]!) * (i % 2 ? 2 : 1)
    total += Math.floor(p / 36) + (p % 36)
  }
  return GSTIN_CHARS[(36 - (total % 36)) % 36] === v[14]
}

/** UAE Tax Registration Number: 15 digits starting with 100 (spaces and dashes ignored), as on the server. */
const trnValid =(v: string) => /^100\d{12}$/.test(v.replace(/[\s-]/g, ''))

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const TREATMENT: Record<string, string> = { intra_state: 'CGST + SGST', inter_state: 'IGST', export_lut: 'Export (zero-rated)' }

// ------------------------------------------------------------------ billing details

type Errors = Partial<Record<keyof BillingProfileInput, string>>

export function BillingDetailsCard({ orgId, onSaved }: { orgId: string; onSaved?: () => void }) {
  const qc = useQueryClient()
  const q = useBillingProfile(orgId)
  const [form, setForm] = useState<BillingProfileInput>({ legal_name: '', gstin: '', address: '', city: '', state_code: '', pin_code: '', email: '', country: '', trn: '', emirate: '' })
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const p = q.data?.profile
  useEffect(() => {
    if (p) setForm({ legal_name: p.legal_name, gstin: p.gstin ?? '', address: p.address, city: p.city ?? '', state_code: p.state_code ?? '', pin_code: p.pin_code ?? '', email: p.email, country: p.country, trn: p.trn ?? '', emirate: p.emirate ?? '' })
  }, [p])
  if (q.isLoading) return <Skeleton className="h-80 w-full" />
  if (!q.data) return null
  const india = q.data.currency === 'INR'
  // UAE (AED wallets): VAT-registered businesses only. TRN and emirate are required; invoices are reverse charge.
  const uae = q.data.currency === 'AED'
  const emirates = q.data.emirates?.length ? q.data.emirates : EMIRATES
  const canEdit = q.data.can_manage
  const set = (k: keyof BillingProfileInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const v = k === 'gstin' ? e.target.value.toUpperCase().replace(/\s/g, '') : e.target.value
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((x) => ({ ...x, [k]: undefined }))
  }
  const validate = (): Errors => {
    const e: Errors = {}
    if (!form.legal_name.trim()) e.legal_name = 'Enter the legal name'
    if (!form.address.trim()) e.address = 'Enter the billing address'
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) e.email = 'Enter a valid email'
    if (uae) {
      if (!trnValid(form.trn ?? '')) e.trn = 'Enter your 15-digit TRN. It starts with 100, like 100123456700003.'
      if (!form.emirate) e.emirate = 'Choose the emirate'
    } else if (india) {
      if (!form.state_code) e.state_code = 'Choose the state'
      if (!/^[1-9][0-9]{5}$/.test(form.pin_code ?? '')) e.pin_code = 'Enter a 6-digit PIN code'
      const g = form.gstin ?? ''
      if (g && !gstinValid(g)) e.gstin = 'This GSTIN is not valid. It has 15 characters, like 27AAPFU0939F1ZV.'
      else if (g && form.state_code && g.slice(0, 2) !== form.state_code) e.gstin = `This GSTIN is registered in state ${g.slice(0, 2)}. Choose that state.`
    } else if (!/^[A-Za-z]{2}$/.test(form.country ?? '')) e.country = 'Enter the 2-letter country code, e.g. US'
    return e
  }
  const save = async () => {
    const e = validate()
    setErrors(e)
    if (Object.keys(e).length) return
    setBusy(true)
    try {
      await billingApi.saveProfile(orgId, {
        ...form,
        gstin: india ? form.gstin || null : null,
        city: form.city || null,
        state_code: india ? form.state_code : null,
        pin_code: form.pin_code || null,
        country: india ? 'IN' : uae ? 'AE' : (form.country ?? '').toUpperCase(),
        trn: uae ? (form.trn ?? '').replace(/[\s-]/g, '') : null,
        emirate: uae ? form.emirate || null : null,
      })
      await qc.invalidateQueries({ queryKey: bqk.profile(orgId) })
      toast.success('Billing details saved')
      onSaved?.()
    } catch (err) {
      const field = (err as { response?: { data?: { error?: { details?: { field?: string } } } } }).response?.data?.error?.details?.field
      if (field) setErrors({ [field]: errorMessage(err) } as Errors)
      else toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card id="billing-details" className="scroll-mt-20" data-testid="billing-details">
      <CardHeader>
        <CardTitle>Billing details</CardTitle>
        <CardDescription>
          {india
            ? 'Tax invoices for top-ups are made out to these details. GST is added to top-ups; leave GSTIN empty if you are not registered.'
            : uae
              ? 'Signalcraft currently sells to VAT-registered UAE businesses. Invoices show your TRN and charge no UAE VAT: you account for it under the reverse charge.'
              : 'Invoices for top-ups are made out to these details. Services to customers outside India are zero-rated (no GST).'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {uae && !p?.trn && (
          <p className="mb-4 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-strong" data-testid="trn-required">
            A UAE Tax Registration Number (TRN) is required before you can add credit.
          </p>
        )}
        <fieldset disabled={!canEdit || busy} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Legal name" htmlFor="bd-legal-name" error={errors.legal_name} className="sm:col-span-2" hint={uae ? 'As on your VAT registration certificate.' : undefined}>
            <Input id="bd-legal-name" value={form.legal_name} onChange={set('legal_name')} maxLength={200} autoComplete="organization" />
          </Field>
          {uae && (
            <Field label="TRN (Tax Registration Number)" htmlFor="bd-trn" error={errors.trn} hint="15 digits, starting with 100. Shown on your invoices for the reverse charge.">
              <Input id="bd-trn" inputMode="numeric" value={form.trn ?? ''} onChange={set('trn')} maxLength={19} className="font-mono" placeholder="100123456700003" />
            </Field>
          )}
          {india && (
            <Field label="GSTIN (optional)" htmlFor="bd-gstin" error={errors.gstin} hint="15 characters. Leave empty for an unregistered business or individual.">
              <Input id="bd-gstin" value={form.gstin ?? ''} onChange={set('gstin')} maxLength={15} className="font-mono uppercase" placeholder="27AAPFU0939F1ZV" />
            </Field>
          )}
          <Field label="Email for invoices" htmlFor="bd-email" error={errors.email}>
            <Input id="bd-email" type="email" value={form.email} onChange={set('email')} maxLength={320} autoComplete="email" />
          </Field>
          <Field label="Billing address" htmlFor="bd-address" error={errors.address} className="sm:col-span-2">
            <Textarea id="bd-address" value={form.address} onChange={set('address')} maxLength={500} rows={3} autoComplete="street-address" />
          </Field>
          <Field label="City" htmlFor="bd-city">
            <Input id="bd-city" value={form.city ?? ''} onChange={set('city')} maxLength={100} autoComplete="address-level2" />
          </Field>
          {india ? (
            <>
              <Field label="State (place of supply)" htmlFor="bd-state" error={errors.state_code}>
                <Select id="bd-state" value={form.state_code ?? ''} onChange={set('state_code')}>
                  <option value="">Choose a state</option>
                  {q.data.states.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="PIN code" htmlFor="bd-pin" error={errors.pin_code}>
                <Input id="bd-pin" inputMode="numeric" value={form.pin_code ?? ''} onChange={set('pin_code')} maxLength={6} autoComplete="postal-code" />
              </Field>
            </>
          ) : uae ? (
            <>
              <Field label="Emirate" htmlFor="bd-emirate" error={errors.emirate}>
                <Select id="bd-emirate" value={form.emirate ?? ''} onChange={set('emirate')}>
                  <option value="">Choose an emirate</option>
                  {emirates.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="P.O. Box (optional)" htmlFor="bd-pin">
                <Input id="bd-pin" value={form.pin_code ?? ''} onChange={set('pin_code')} maxLength={10} />
              </Field>
            </>
          ) : (
            <>
              <Field label="Postal code" htmlFor="bd-pin">
                <Input id="bd-pin" value={form.pin_code ?? ''} onChange={set('pin_code')} maxLength={10} autoComplete="postal-code" />
              </Field>
              <Field label="Country code" htmlFor="bd-country" error={errors.country}>
                <Input id="bd-country" value={form.country ?? ''} onChange={set('country')} maxLength={2} placeholder="US" className="uppercase" />
              </Field>
            </>
          )}
        </fieldset>
        {canEdit ? (
          <div className="mt-4 flex justify-end">
            <Button onClick={save} loading={busy} className="w-full sm:w-auto" data-testid="bd-save">
              <Save /> Save billing details
            </Button>
          </div>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">Only owners and admins can change billing details.</p>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ breakdown before paying

/** "₹1,000 + ₹180 GST = ₹1,180", or a prompt to add billing details first. */
export function GstBreakdown({ orgId, amount, onNeedDetails }: { orgId: string; amount: number; onNeedDetails: () => void }) {
  const valid = amount > 0
  const q = useQuery({ queryKey: ['billing', 'quote', orgId, amount], queryFn: () => billingApi.quote(orgId, amount), enabled: valid, placeholderData: keepPreviousData, staleTime: 30_000 })
  const d = q.data
  if (!valid || !d) return null
  if (!d.profile_ready)
    return (
      <div className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-strong" data-testid={d.trn_required ? 'trn-required-prompt' : 'needs-billing-details'}>
        <p>
          {d.trn_required
            ? d.trn_message ?? 'Signalcraft currently sells to VAT-registered UAE businesses. Add your TRN in the billing details to top up.'
            : 'Add your billing details first. We need them to issue a GST invoice for this payment.'}
        </p>
        <Button size="sm" variant="outline" className="mt-2" onClick={onNeedDetails} data-testid="add-billing-details">
          {d.trn_required ? 'Add your TRN' : 'Add billing details'}
        </Button>
      </div>
    )
  const cur = d.currency
  if (d.reverse_charge)
    return (
      <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm" data-testid="reverse-charge-breakdown">
        <div className="font-medium tabular-nums">{formatMoney(d.total, cur)}</div>
        <div className="text-xs text-muted-foreground">
          Reverse charge: no UAE VAT is charged. You account for UAE VAT on this purchase. {formatMoney(d.credit, cur)} is added to your wallet; the invoice shows your TRN.
        </div>
      </div>
    )
  return (
    <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm" data-testid="gst-breakdown">
      <div className="font-medium tabular-nums">
        {d.tax > 0 ? `${formatMoney(d.credit, cur)} + ${formatMoney(d.tax, cur)} GST = ${formatMoney(d.total, cur)}` : `${formatMoney(d.total, cur)} (no GST: export of services)`}
      </div>
      {d.tax > 0 && (
        <div className="text-xs text-muted-foreground">
          {d.treatment === 'intra_state' ? `CGST ${formatMoney(d.cgst, cur)} + ${d.sgst_label} ${formatMoney(d.sgst, cur)}` : `IGST ${d.rate}% ${formatMoney(d.igst, cur)}`} · place of supply {d.place_of_supply}.{' '}
          {formatMoney(d.credit, cur)} is added to your wallet; you get a tax invoice by email.
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ invoices

export function InvoicesCard({ orgId }: { orgId: string }) {
  const [page, setPage] = useState(1)
  const q = useQuery({ queryKey: bqk.invoices(orgId, page), queryFn: () => billingApi.invoices(orgId, { page, page_size: 20 }), placeholderData: keepPreviousData })
  const download = (id: string, number: string) =>
    downloadFile(billingApi.invoicePdfUrl(orgId, id), `invoice-${number.replace(/\//g, '-')}.pdf`).catch((e) => toast.error(errorMessage(e)))
  return (
    <Card data-testid="invoices">
      <CardHeader>
        <CardTitle>Invoices</CardTitle>
        <CardDescription>A tax invoice is issued for every top-up when the payment is confirmed, and emailed to your billing email. Test credit has no invoice.</CardDescription>
      </CardHeader>
      {q.isLoading ? (
        <LoadingRows />
      ) : !q.data?.items.length ? (
        <EmptyState icon={Receipt} title="No invoices yet" description="Invoices appear here after you add credit with an online payment." />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>Invoice</TH>
                <TH className="hidden sm:table-cell">Tax</TH>
                <TH className="text-right">Total</TH>
                <TH className="w-0" />
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((i) => (
                <TR key={i.id} data-testid="invoice-row">
                  <TD>
                    <div className="font-mono text-sm">{i.number}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatDate(i.issued_at)}
                      {i.doc_type === 'credit_note' && ' · Credit note'}
                    </div>
                  </TD>
                  <TD className="hidden sm:table-cell">
                    <Badge variant="secondary">{TREATMENT[i.tax_treatment] ?? i.tax_treatment}</Badge>
                    <div className="mt-1 text-xs tabular-nums text-muted-foreground">{formatMoney(i.tax, i.currency)}</div>
                  </TD>
                  <TD className="text-right tabular-nums">{formatMoney(i.total, i.currency)}</TD>
                  <TD>
                    <Button size="sm" variant="outline" onClick={() => download(i.id, i.number)} aria-label={`Download invoice ${i.number}`} data-testid="invoice-download">
                      <Download /> <span className="hidden sm:inline">PDF</span>
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} pageSize={20} total={q.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  )
}

// ------------------------------------------------------------------ monthly statements

export function StatementsCard({ orgId }: { orgId: string }) {
  const months = useMemo(() => {
    const out: { value: string; label: string }[] = []
    const d = new Date()
    d.setDate(1)
    for (let i = 0; i < 13; i++) {
      out.push({ value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) })
      d.setMonth(d.getMonth() - 1)
    }
    return out
  }, [])
  const [month, setMonth] = useState(months[0]!.value)
  const get = (format: 'csv' | 'pdf') =>
    downloadFile(billingApi.statementUrl(orgId, month, format), `usage-statement-${month}.${format}`).catch((e) => toast.error(errorMessage(e)))
  return (
    <Card data-testid="statements">
      <CardHeader>
        <CardTitle>Monthly usage statement</CardTitle>
        <CardDescription>Every debit from the wallet in a month: plan fees, usage per channel, AI calling and chatbot replies. This is a statement, not a tax invoice: GST is invoiced on top-ups.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Month" htmlFor="st-month" className="sm:w-64">
          <Select id="st-month" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 sm:flex-none" onClick={() => get('csv')} data-testid="statement-csv">
            <Download /> CSV
          </Button>
          <Button variant="outline" className="flex-1 sm:flex-none" onClick={() => get('pdf')} data-testid="statement-pdf">
            <FileText /> PDF
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
