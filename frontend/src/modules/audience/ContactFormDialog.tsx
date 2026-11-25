import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ShieldCheck } from 'lucide-react'
import { audienceApi, aqk, useAttributes, useLists, useTags } from '@/api/audience'
import { ApiError, errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Checkbox, PhoneInput } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { ALL_COUNTRIES, EMIRATES, INDIAN_STATES, US_STATES } from '@/lib/regions'
import type { Attribute, ContactDetail, ContactInput } from '@/types/audience'
import type { Ref } from '@/types/crm'
import { CompanyPicker, OwnerSelect } from '../crm/components'
import { LIFECYCLE_LABEL, LIFECYCLES } from '../crm/format'

interface Values {
  first_name: string
  last_name: string
  email: string
  phone: string
  company: string
  country: string
  state: string
  city: string
  postal_code: string
  attributes: Record<string, string>
}

function attrInput(a: Attribute, register: ReturnType<typeof useForm<Values>>['register']) {
  const name = `attributes.${a.key}` as const
  if (a.data_type === 'boolean')
    return (
      <Select id={`attr-${a.key}`} {...register(name)}>
        <option value="">—</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    )
  if (a.data_type === 'select')
    return (
      <Select id={`attr-${a.key}`} {...register(name)}>
        <option value="">—</option>
        {a.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </Select>
    )
  return <Input id={`attr-${a.key}`} type={a.data_type === 'date' ? 'date' : a.data_type === 'number' ? 'number' : 'text'} step="any" {...register(name)} />
}

/** Create or edit a contact. Consent is captured only on create and must be explicit. */
export function ContactFormDialog({
  open,
  onOpenChange,
  contact,
  onSaved,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  contact?: ContactDetail
  onSaved?: (c: ContactDetail) => void
}) {
  const { app, can } = useWorkspace()
  const crmRead = can('crm.read')
  const crmWrite = can('crm.write')
  const appId = app!.id
  const api = audienceApi(appId)
  const qc = useQueryClient()
  const attrs = useAttributes(appId)
  const tags = useTags(appId)
  const lists = useLists(appId)
  const defaultCountry = app!.default_country ?? 'IN'
  const [phoneCountry, setPhoneCountry] = useState(defaultCountry)
  const [tagIds, setTagIds] = useState<string[]>([])
  const [listIds, setListIds] = useState<string[]>([])
  const [consent, setConsent] = useState({ email: false, sms: false, voice: false, source: '', evidence: '', consent_reference: '' })
  const [error, setError] = useState<string | null>(null)
  const [company, setCompany] = useState<Ref | null>(null)
  const [companyTouched, setCompanyTouched] = useState(false)
  const [owner, setOwner] = useState('')
  const [lifecycle, setLifecycle] = useState('lead')
  const { register, handleSubmit, reset, watch, formState } = useForm<Values>()
  const country = watch('country')

  useEffect(() => {
    if (!open) return
    setError(null)
    setTagIds([])
    setListIds([])
    setConsent({ email: false, sms: false, voice: false, source: '', evidence: '', consent_reference: '' })
    setPhoneCountry(contact?.phone_country ?? defaultCountry)
    setCompany(contact?.company_id && contact.company ? { id: contact.company_id, name: contact.company } : null)
    setCompanyTouched(false)
    setOwner(contact?.owner_id ?? '')
    setLifecycle(contact?.lifecycle_stage ?? 'lead')
    reset({
      first_name: contact?.first_name ?? '',
      last_name: contact?.last_name ?? '',
      email: contact?.email ?? '',
      phone: contact?.phone_display ?? '',
      company: contact?.company ?? '',
      country: contact?.country ?? defaultCountry,
      state: contact?.state ?? '',
      city: contact?.city ?? '',
      postal_code: contact?.postal_code ?? '',
      attributes: Object.fromEntries(Object.entries(contact?.attributes ?? {}).map(([k, v]) => [k, String(v)])),
    })
  }, [open, contact, reset, defaultCountry])

  const anyConsent = consent.email || consent.sms || consent.voice
  const usNumber = phoneCountry === 'US'
  const needsEvidence = (consent.sms || consent.voice) && usNumber

  const submit = handleSubmit(async (v) => {
    setError(null)
    const attributes: Record<string, unknown> = {}
    for (const a of attrs.data ?? []) {
      const raw = v.attributes?.[a.key]
      if (raw === undefined) continue
      if (raw === '') {
        if (contact && a.key in (contact.attributes ?? {})) attributes[a.key] = null
        continue
      }
      attributes[a.key] = a.data_type === 'boolean' ? raw === 'true' : a.data_type === 'number' ? Number(raw) : raw
    }
    const body: ContactInput = {
      first_name: v.first_name || null,
      last_name: v.last_name || null,
      email: v.email || null,
      phone: v.phone || null,
      phone_country: phoneCountry,
      country: v.country || null,
      state: v.state || null,
      city: v.city || null,
      postal_code: v.postal_code || null,
      attributes,
    }
    if (crmRead) {
      // The company comes from the CRM picker: a chosen company links the contact to it.
      if (!contact || companyTouched) {
        body.company = company?.name ?? null
        body.company_id = company?.id ?? null
      }
    } else {
      body.company = v.company || null
    }
    if (crmWrite) {
      if (!contact) {
        if (owner) body.owner_id = owner
        body.lifecycle_stage = lifecycle
      } else {
        if (owner !== (contact.owner_id ?? '')) {
          if (owner) body.owner_id = owner
          else body.clear_owner = true
        }
        if (lifecycle !== (contact.lifecycle_stage ?? 'lead')) body.lifecycle_stage = lifecycle
      }
    }
    try {
      let saved: ContactDetail
      if (contact) {
        saved = await api.updateContact(contact.id, body)
      } else {
        saved = await api.createContact({
          ...body,
          tag_ids: tagIds,
          list_ids: listIds,
          consent: anyConsent ? { ...consent } : { email: false, sms: false, voice: false },
        })
      }
      await qc.invalidateQueries({ queryKey: aqk.all(appId) })
      toast.success(contact ? 'Contact updated' : 'Contact created')
      onOpenChange(false)
      onSaved?.(saved)
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'DUPLICATE_CONTACT' ? 'A contact with this email or phone already exists.' : errorMessage(e))
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{contact ? 'Edit contact' : 'Add contact'}</DialogTitle>
          <DialogDescription>Phone numbers are stored in international format and validated for the selected country.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5" noValidate>
          {error && (
            <div role="alert" className="rounded-md border border-danger-border bg-danger-soft p-3 text-sm text-danger-strong">
              {error}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" htmlFor="c-first">
              <Input id="c-first" autoFocus {...register('first_name')} />
            </Field>
            <Field label="Last name" htmlFor="c-last">
              <Input id="c-last" {...register('last_name')} />
            </Field>
            <Field label="Email" htmlFor="c-email">
              <Input id="c-email" type="email" {...register('email')} />
            </Field>
            <Field label="Phone" htmlFor="c-phone">
              <PhoneInput id="c-phone" country={phoneCountry} onCountry={setPhoneCountry} {...register('phone')} />
            </Field>
            {crmRead ? (
              <Field
                label="Company"
                htmlFor="c-company"
                hint={contact?.company && !contact.company_id && !companyTouched ? `Currently “${contact.company}” (not linked to a CRM company)` : 'Pick a company or type a new name to create it.'}
              >
                <CompanyPicker
                  appId={appId}
                  id="c-company"
                  value={company}
                  onChange={(v) => {
                    setCompany(v)
                    setCompanyTouched(true)
                  }}
                />
              </Field>
            ) : (
              <Field label="Company" htmlFor="c-company">
                <Input id="c-company" {...register('company')} />
              </Field>
            )}
            <Field label="Country" htmlFor="c-country">
              <Select id="c-country" {...register('country')}>
                <option value="">—</option>
                {ALL_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.flag} {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={country === 'US' ? 'State' : country === 'AE' ? 'Emirate' : 'State / UT'} htmlFor="c-state">
              {country === 'US' || country === 'IN' || country === 'AE' ? (
                <Select id="c-state" {...register('state')}>
                  <option value="">—</option>
                  {country === 'US'
                    ? US_STATES.map(([code, name]) => (
                        <option key={code} value={code}>
                          {name}
                        </option>
                      ))
                    : (country === 'AE' ? EMIRATES : INDIAN_STATES).map((s) => <option key={s}>{s}</option>)}
                </Select>
              ) : (
                <Input id="c-state" {...register('state')} />
              )}
            </Field>
            <Field label="City" htmlFor="c-city">
              <Input id="c-city" {...register('city')} />
            </Field>
            <Field label={country === 'US' ? 'ZIP code' : country === 'IN' ? 'PIN code' : 'Postal code'} htmlFor="c-postal">
              <Input id="c-postal" {...register('postal_code')} />
            </Field>
            {crmWrite && (
              <>
                <Field label="Owner" htmlFor="c-owner" hint={contact ? undefined : 'Leave unassigned to let assignment rules pick an owner.'}>
                  <OwnerSelect appId={appId} id="c-owner" value={owner} onChange={setOwner} />
                </Field>
                <Field label="Lifecycle stage" htmlFor="c-lifecycle">
                  <Select id="c-lifecycle" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}>
                    {LIFECYCLES.map((l) => (
                      <option key={l} value={l}>
                        {LIFECYCLE_LABEL[l]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
          </div>

          {!!attrs.data?.length && (
            <div>
              <h4 className="mb-2 text-sm font-semibold">Custom fields</h4>
              <div className="grid gap-4 sm:grid-cols-2">
                {attrs.data.map((a) => (
                  <Field key={a.id} label={a.label} htmlFor={`attr-${a.key}`}>
                    {attrInput(a, register)}
                  </Field>
                ))}
              </div>
            </div>
          )}

          {!contact && (!!tags.data?.length || !!lists.data?.length) && (
            <div className="grid gap-4 sm:grid-cols-2">
              {!!tags.data?.length && (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">Tags</span>
                  <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto rounded-md border p-2">
                    {tags.data.map((t) => (
                      <label key={t.id} className="flex items-center gap-1.5 text-sm">
                        <Checkbox checked={tagIds.includes(t.id)} onChange={(e) => setTagIds((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))} />
                        {t.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {!!lists.data?.length && (
                <div className="space-y-1.5">
                  <span className="text-sm font-medium">Lists</span>
                  <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto rounded-md border p-2">
                    {lists.data.map((l) => (
                      <label key={l.id} className="flex items-center gap-1.5 text-sm">
                        <Checkbox checked={listIds.includes(l.id)} onChange={(e) => setListIds((s) => (e.target.checked ? [...s, l.id] : s.filter((x) => x !== l.id)))} />
                        {l.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {!contact && (
            <div className="rounded-lg border bg-muted/30 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="size-4 text-primary" /> Marketing consent
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Only tick a channel if this person agreed to receive marketing on it. Nothing is assumed.
              </p>
              <div className="mt-3 flex flex-wrap gap-4">
                {(['email', 'sms', 'voice'] as const).map((ch) => (
                  <label key={ch} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={consent[ch]} onChange={(e) => setConsent((c) => ({ ...c, [ch]: e.target.checked }))} />
                    {ch === 'email' ? 'Email marketing consent' : ch === 'sms' ? 'SMS marketing consent' : 'Voice marketing consent'}
                  </label>
                ))}
              </div>
              {anyConsent && (
                <div className="mt-3 grid gap-3">
                  <Field label="Where was consent collected?" htmlFor="c-src">
                    <Input id="c-src" placeholder="e.g. Website sign-up form, in-store kiosk" value={consent.source} onChange={(e) => setConsent((c) => ({ ...c, source: e.target.value }))} />
                  </Field>
                  {(consent.sms || consent.voice) && (
                    <Field
                      label={needsEvidence ? 'Written consent evidence (required for US numbers)' : 'Evidence'}
                      htmlFor="c-ev"
                      hint={needsEvidence ? 'TCPA requires prior express written consent for marketing texts and calls.' : 'Recommended. Describe the record you keep.'}
                    >
                      <Textarea id="c-ev" rows={2} value={consent.evidence} onChange={(e) => setConsent((c) => ({ ...c, evidence: e.target.value }))} />
                    </Field>
                  )}
                  {consent.sms && phoneCountry === 'IN' && (
                    <Field label="DLT consent reference (optional)" htmlFor="c-ref" hint="Consent template or reference ID registered on your DLT platform.">
                      <Input id="c-ref" value={consent.consent_reference} onChange={(e) => setConsent((c) => ({ ...c, consent_reference: e.target.value }))} />
                    </Field>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={formState.isSubmitting}>
              {contact ? 'Save changes' : 'Add contact'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
