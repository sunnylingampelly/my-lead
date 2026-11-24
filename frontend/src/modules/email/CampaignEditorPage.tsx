import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Eye,
  FileCode2,
  LayoutTemplate,
  Loader2,
  Mail,
  Plus,
  RotateCw,
  Save,
  Send,
  Type,
  Users,
} from 'lucide-react'
import { emailApi, eqk, useCampaign, useSenders, useTemplates } from '@/api/email'
import { audienceApi } from '@/api/audience'
import { errorMessage } from '@/api/client'
import { ErrorState, FullPageSpinner } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Skeleton } from '@/components/ui/misc'
import { Checkbox } from '@/components/audience'
import { useUser } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import { TIMEZONES } from '@/lib/timezones'
import { cn } from '@/lib/utils'
import type { Campaign, CampaignAudience, EditorKind } from '@/types/email'
import { AudiencePicker, money, ReadinessList, SaveIndicator, StepNav, useCampaignAutosave, WalletLine } from './campaignKit'
import { CampaignStatusBadge, DeviceToggle, EmailFrame, HtmlEditor, VariablePicker } from './components'
import { AddSenderDialog } from './senderDialog'
import { STARTERS } from './starters'

const VisualEditor = lazy(() => import('./VisualEditor').then((m) => ({ default: m.VisualEditor })))

const STEPS = [
  { key: 'setup', label: 'Setup', icon: Mail },
  { key: 'content', label: 'Content', icon: LayoutTemplate },
  { key: 'audience', label: 'Audience', icon: Users },
  { key: 'review', label: 'Review & send', icon: Send },
] as const
type StepKey = (typeof STEPS)[number]['key']
type Draft = Partial<Campaign>

// ------------------------------------------------------------------ autosave

/** Settings and audience are saved separately from the design, so a failed design save can never drop them. */
function useAutosave(appId: string, campaign: Campaign | undefined) {
  const qc = useQueryClient()
  return useCampaignAutosave<Campaign>({
    campaign,
    save: (id, body) => emailApi(appId).updateCampaign(id, body),
    onSaved: (saved) => qc.setQueryData(eqk.campaign(appId, saved.id), saved),
    isolate: [{ name: 'the email design', keys: ['design', 'html'] }],
    rest: 'your settings and audience',
  })
}

// ------------------------------------------------------------------ steps

/** Unverified sender: resend the confirmation, or re-check after confirming (also polled automatically). */
function SenderVerifyActions({ senderId, email }: { senderId: string; email?: string }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<'resend' | 'check' | null>(null)
  return (
    <span className="mt-1.5 flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="outline"
        loading={busy === 'resend'}
        data-testid="resend-confirmation"
        onClick={async () => {
          setBusy('resend')
          try {
            await emailApi(app!.id).resendSender(senderId)
            toast.success(`Confirmation email sent again${email ? ` to ${email}` : ''}`)
          } catch (e) {
            toast.error(errorMessage(e))
          } finally {
            setBusy(null)
          }
        }}
      >
        <RotateCw /> Resend confirmation
      </Button>
      <Button
        size="sm"
        variant="ghost"
        loading={busy === 'check'}
        data-testid="check-again"
        onClick={async () => {
          setBusy('check')
          const list = await qc.fetchQuery({ queryKey: eqk.senders(app!.id), queryFn: () => emailApi(app!.id).senders(), staleTime: 0 })
          await qc.invalidateQueries({ queryKey: ['email', app!.id, 'readiness'] })
          const s = list.find((x) => x.id === senderId)
          if (s?.status === 'verified') toast.success(`${s.from_email} is verified`)
          else toast.info('Not confirmed yet. Open the email we sent and click the link; this page checks every few seconds.')
          setBusy(null)
        }}
      >
        I’ve confirmed — check again
      </Button>
    </span>
  )
}

function SetupStep({ draft, update }: { draft: Draft; update: (p: Draft) => void }) {
  const { app, can } = useWorkspace()
  const senders = useSenders(app!.id, true)
  const [adding, setAdding] = useState(false)
  // A draft without a sender gets the first verified one as soon as one exists.
  useEffect(() => {
    if (!draft.sender_id && senders.data?.length) {
      const pick = senders.data.find((s) => s.status === 'verified' && s.is_default) ?? senders.data.find((s) => s.status === 'verified')
      if (pick) update({ sender_id: pick.id, from_name: pick.from_name, from_email: pick.from_email })
    }
  }, [draft.sender_id, senders.data, update])
  const subjectRef = useRef<HTMLInputElement>(null)
  const insertSubject = (token: string) => {
    const el = subjectRef.current
    const v = draft.subject ?? ''
    const s = el?.selectionStart ?? v.length
    update({ subject: v.slice(0, s) + token + v.slice(el?.selectionEnd ?? s) })
  }
  const sender = senders.data?.find((s) => s.id === draft.sender_id)
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Campaign</CardTitle>
            <CardDescription>Internal details. Recipients never see these.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Campaign name" htmlFor="c-name">
              <Input id="c-name" value={draft.name ?? ''} onChange={(e) => update({ name: e.target.value })} />
            </Field>
            <Field label="Type" htmlFor="c-type">
              <Select id="c-type" value={draft.campaign_type ?? 'regular'} onChange={(e) => update({ campaign_type: e.target.value })}>
                <option value="regular">Regular</option>
                <option value="newsletter">Newsletter</option>
                <option value="promotional">Promotional</option>
                <option value="announcement">Announcement</option>
              </Select>
            </Field>
            <Field label="Internal description" htmlFor="c-desc" className="sm:col-span-2">
              <Textarea id="c-desc" rows={2} value={draft.description ?? ''} onChange={(e) => update({ description: e.target.value })} placeholder="Optional notes for your team" />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sender and subject</CardTitle>
            <CardDescription>What people see in their inbox.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="From"
                htmlFor="c-sender"
                hint={
                  sender && sender.status !== 'verified' ? (
                    <span className="block text-warning-strong" data-testid="sender-pending">
                      Not verified yet: open the email we sent to {sender.from_email} and click the link. This updates by itself.
                      {can('settings.write') && <SenderVerifyActions senderId={sender.id} email={sender.from_email} />}
                    </span>
                  ) : senders.data?.length === 0 ? (
                    can('settings.write') ? 'Add a sender address to send from.' : 'Ask an admin to add a sender address.'
                  ) : undefined
                }
                action={
                  can('settings.write') && (
                    <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" data-testid="add-sender-inline">
                      <Plus className="size-3" /> Add sender
                    </button>
                  )
                }
              >
                <Select id="c-sender" value={draft.sender_id ?? ''} onChange={(e) => {
                  const s = senders.data?.find((x) => x.id === e.target.value)
                  update({ sender_id: e.target.value || null, ...(s ? { from_name: s.from_name, from_email: s.from_email } : {}) })
                }}>
                  <option value="">Choose a sender…</option>
                  {senders.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.from_name} &lt;{s.from_email}&gt;{s.status !== 'verified' ? ' (unverified)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reply-to" htmlFor="c-reply" hint="Where replies go. Defaults to the sender's reply-to.">
                <Input id="c-reply" type="email" value={draft.reply_to ?? ''} onChange={(e) => update({ reply_to: e.target.value || null })} placeholder={sender?.reply_to ?? sender?.from_email ?? ''} />
              </Field>
            </div>
            <Field
              label="Subject line"
              htmlFor="c-subject"
              hint={`${(draft.subject ?? '').length} characters. Aim for under 60 so it fits on phones.`}
              action={<VariablePicker appId={app!.id} onInsert={insertSubject} label="Insert field" />}
            >
              <Input id="c-subject" ref={subjectRef} value={draft.subject ?? ''} onChange={(e) => update({ subject: e.target.value })} placeholder="e.g. {{first_name}}, your festive offer is here" />
            </Field>
            <Field label="Preview text" htmlFor="c-pre" hint="Shown after the subject in most inboxes.">
              <Input id="c-pre" value={draft.preheader ?? ''} onChange={(e) => update({ preheader: e.target.value })} placeholder="A short summary that encourages the open" />
            </Field>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Inbox preview</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border bg-background p-3">
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                  {(sender?.from_name ?? '?').slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 text-sm">
                  <div className="truncate font-semibold">{sender?.from_name ?? 'Sender name'}</div>
                  <div className="truncate font-medium">{(draft.subject || 'Your subject line').replace(/\{\{\s*first_name[^}]*\}\}/g, 'Asha')}</div>
                  <div className="truncate text-muted-foreground">{draft.preheader || 'Preview text appears here…'}</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Tracking</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <label className="flex items-start gap-2">
              <Checkbox className="mt-0.5" checked={draft.track_opens ?? true} onChange={(e) => update({ track_opens: e.target.checked })} />
              <span>
                Track opens
                <span className="block text-xs text-muted-foreground">Approximate: privacy features such as Apple Mail Privacy Protection pre-load images.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <Checkbox className="mt-0.5" checked={draft.track_clicks ?? true} onChange={(e) => update({ track_clicks: e.target.checked })} />
              <span>
                Track link clicks
                <span className="block text-xs text-muted-foreground">Links go through a secure redirect to measure clicks.</span>
              </span>
            </label>
          </CardContent>
        </Card>
      </div>
      <AddSenderDialog open={adding} onOpenChange={setAdding} onCreated={(s) => update({ sender_id: s.id, from_name: s.from_name, from_email: s.from_email })} />
    </div>
  )
}

function StarterPicker({ onPick }: { onPick: (p: { html: string; subject?: string; preheader?: string; design?: Record<string, unknown> | null; editor?: EditorKind }) => void }) {
  const { app } = useWorkspace()
  const templates = useTemplates(app!.id)
  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-3 text-sm font-semibold">Start from a layout</h3>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {STARTERS.map((s) => (
            <button
              key={s.key}
              onClick={() => onPick({ html: s.html, subject: s.subject || undefined, preheader: s.preheader || undefined, editor: 'visual', design: null })}
              className="group overflow-hidden rounded-lg border bg-card text-left shadow-card transition hover:-translate-y-0.5 hover:border-primary/50"
              data-testid={`starter-${s.key}`}
            >
              <div className="pointer-events-none h-44 overflow-hidden bg-muted">
                <iframe title={s.name} srcDoc={s.html} sandbox="" className="h-[600px] w-[600px] origin-top-left scale-[0.42] border-0 bg-white" tabIndex={-1} />
              </div>
              <div className="border-t p-3">
                <div className="text-sm font-medium group-hover:text-primary">{s.name}</div>
                <div className="text-xs text-muted-foreground">{s.description}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
      {!!templates.data?.length && (
        <div>
          <h3 className="mb-3 text-sm font-semibold">Your saved templates</h3>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {templates.data.map((t) => (
              <button
                key={t.id}
                onClick={() => onPick({ html: t.html ?? '', subject: t.subject ?? undefined, preheader: t.preheader ?? undefined, design: t.design, editor: t.editor })}
                className="rounded-lg border bg-card p-3 text-left text-sm shadow-card transition hover:border-primary/50"
              >
                <div className="font-medium">{t.name}</div>
                <div className="truncate text-xs text-muted-foreground">{t.subject ?? 'No subject'}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => onPick({ html: '<!doctype html><html><body>\n  <p>Hello {{first_name | default: "there"}},</p>\n</body></html>', editor: 'html', design: null })}>
          <FileCode2 /> Write HTML
        </Button>
        <Button variant="outline" onClick={() => onPick({ html: '', editor: 'text', design: null })}>
          <Type /> Plain text only
        </Button>
      </div>
    </div>
  )
}

function PreviewDialog({ open, onOpenChange, draft }: { open: boolean; onOpenChange: (o: boolean) => void; draft: Draft }) {
  const { app } = useWorkspace()
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [contactId, setContactId] = useState<string>('')
  const [search, setSearch] = useState('')
  const contacts = useQuery({
    queryKey: ['preview-contacts', app!.id, search],
    queryFn: () => audienceApi(app!.id).contacts({ search: search || undefined, page: 1, page_size: 8 }),
    enabled: open,
  })
  const preview = useQuery({
    queryKey: ['preview', draft.id, contactId, draft.subject, draft.preheader, draft.html, draft.text],
    queryFn: () =>
      emailApi(app!.id).preview(draft.id!, { contact_id: contactId || null, subject: draft.subject, preheader: draft.preheader, html: draft.html, text: draft.text }),
    enabled: open && !!draft.id,
  })
  const [tab, setTab] = useState<'html' | 'text'>('html')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Preview</DialogTitle>
          <DialogDescription>Rendered exactly as it will be sent, including the compliance footer, for a real contact.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Input placeholder="Search a contact to preview as…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-64" aria-label="Search contact" />
          <Select value={contactId} onChange={(e) => setContactId(e.target.value)} className="w-64" aria-label="Preview as contact">
            <option value="">Sample contact (Asha Rao)</option>
            {contacts.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name || c.email} {c.email ? `· ${c.email}` : ''}
              </option>
            ))}
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <div className="inline-flex rounded-md border p-0.5 text-xs">
              {(['html', 'text'] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={cn('rounded px-2 py-1', tab === t ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')}>
                  {t === 'html' ? 'HTML' : 'Plain text'}
                </button>
              ))}
            </div>
            <DeviceToggle value={device} onChange={setDevice} />
          </div>
        </div>
        {preview.data && (
          <div className="space-y-2">
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Subject: </span>
              <span className="font-medium" data-testid="preview-subject">
                {preview.data.subject}
              </span>
            </div>
            {(preview.data.issues.unknown.length > 0 || preview.data.issues.malformed.length > 0) && (
              <p className="flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong">
                <AlertTriangle className="size-4" />
                {preview.data.issues.unknown.length > 0 && `Unknown fields: ${preview.data.issues.unknown.join(', ')}. `}
                {preview.data.issues.malformed.length > 0 && `Unsupported syntax: ${preview.data.issues.malformed.join(', ')}`}
              </p>
            )}
            {tab === 'html' ? (
              <EmailFrame html={preview.data.html} device={device} className="h-[60vh]" />
            ) : (
              <pre className="h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border bg-card p-4 font-mono text-xs">{preview.data.text}</pre>
            )}
          </div>
        )}
        {preview.isLoading && <Skeleton className="h-[60vh] w-full" />}
      </DialogContent>
    </Dialog>
  )
}

function ContentStep({ draft, update, flush }: { draft: Draft; update: (p: Draft) => void; flush: () => Promise<boolean> }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const [preview, setPreview] = useState(false)
  const [switchTo, setSwitchTo] = useState<EditorKind | null>(null)
  const [editorKey, setEditorKey] = useState(0)
  const editor = draft.editor ?? 'visual'
  const empty = !draft.html && !draft.text && !draft.design

  if (empty)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Design your email</CardTitle>
          <CardDescription>Pick a starting point. You can change everything afterwards.</CardDescription>
        </CardHeader>
        <CardContent>
          <StarterPicker
            onPick={(p) => {
              update({
                html: p.html || null,
                design: p.design ?? null,
                editor: p.editor ?? 'visual',
                ...(p.subject && !draft.subject ? { subject: p.subject } : {}),
                ...(p.preheader && !draft.preheader ? { preheader: p.preheader } : {}),
                ...(p.editor === 'text' ? { text: 'Hello {{first_name | default: "there"}},\n\n' } : {}),
              })
              setEditorKey((k) => k + 1)
            }}
          />
        </CardContent>
      </Card>
    )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border bg-card p-1" role="tablist" aria-label="Editor">
          {([
            ['visual', 'Visual', LayoutTemplate],
            ['html', 'HTML', FileCode2],
            ['text', 'Plain text', Type],
          ] as const).map(([k, label, Icon]) => (
            <button
              key={k}
              role="tab"
              aria-selected={editor === k}
              onClick={() => k !== editor && setSwitchTo(k)}
              className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition', editor === k ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          {editor === 'visual' && <VariablePicker appId={app!.id} label="Copy field" />}
          <Button
            variant="outline"
            onClick={async () => {
              const name = window.prompt('Template name', draft.name ?? 'Untitled template')
              if (!name) return
              try {
                await emailApi(app!.id).createTemplate({ name, subject: draft.subject ?? null, preheader: draft.preheader ?? null, editor, design: draft.design ?? null, html: draft.html ?? null, text: draft.text ?? null })
                await qc.invalidateQueries({ queryKey: ['email', app!.id, 'templates'] })
                toast.success('Saved as template')
              } catch (e) {
                toast.error(errorMessage(e))
              }
            }}
          >
            <Save /> Save as template
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              await flush()
              setPreview(true)
            }}
          >
            <Eye /> Preview
          </Button>
        </div>
      </div>

      {editor === 'visual' && (
        <div className="h-[calc(100vh-15rem)] min-h-[640px]">
          <Suspense fallback={<Skeleton className="h-full w-full" />}>
            <VisualEditor key={editorKey} initialDesign={draft.design ?? null} initialHtml={draft.html ?? null} onChange={(v) => update({ design: v.design, html: v.html })} />
          </Suspense>
        </div>
      )}
      {editor === 'html' && <HtmlEditor appId={app!.id} value={draft.html ?? ''} onChange={(v) => update({ html: v })} />}
      {(editor === 'text' || editor === 'html' || editor === 'visual') && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{editor === 'text' ? 'Plain-text email' : 'Plain-text version (optional)'}</CardTitle>
            <CardDescription>
              {editor === 'text'
                ? 'Sent without HTML. Links are shown as written; the unsubscribe footer is added automatically.'
                : 'Used by mail apps that cannot show HTML. Leave empty to generate it from the design.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea
              rows={editor === 'text' ? 16 : 5}
              value={draft.text ?? ''}
              onChange={(e) => update({ text: e.target.value || null })}
              className="font-mono text-[13px]"
              aria-label="Plain text"
            />
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={!!switchTo}
        onOpenChange={(o) => !o && setSwitchTo(null)}
        title={`Switch to the ${switchTo === 'visual' ? 'visual' : switchTo === 'html' ? 'HTML' : 'plain-text'} editor?`}
        description={
          switchTo === 'text'
            ? 'The HTML design will be removed and the email will be sent as plain text.'
            : switchTo === 'visual'
              ? 'The current HTML is imported into the visual editor. Complex code may be simplified.'
              : 'You will edit the generated HTML directly. Changes made in HTML cannot be moved back into the visual layout without re-importing.'
        }
        confirmLabel="Switch editor"
        onConfirm={() => {
          if (switchTo === 'text') update({ editor: 'text', html: null, design: null, text: draft.text || 'Hello {{first_name | default: "there"}},\n\n' })
          else if (switchTo === 'visual') update({ editor: 'visual', design: null })
          else update({ editor: 'html', design: null })
          setEditorKey((k) => k + 1)
          setSwitchTo(null)
        }}
      />
      <PreviewDialog open={preview} onOpenChange={setPreview} draft={draft} />
    </div>
  )
}

const EXCLUDE_LABEL: Record<string, string> = {
  no_email: 'No email address',
  unsubscribed: 'Unsubscribed',
  bounced_or_blocked: 'Bounced or blocked',
  suppressed: 'On the suppression list',
  no_consent: 'No email marketing consent',
}

function AudienceStep({ draft, update }: { draft: Draft; update: (p: Draft) => void }) {
  const { app } = useWorkspace()
  const aud: CampaignAudience = draft.audience ?? {}
  const [debounced, setDebounced] = useState(aud)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(aud), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(aud)])
  const est = useQuery({ queryKey: ['estimate', app!.id, debounced], queryFn: () => emailApi(app!.id).estimate(debounced), placeholderData: (p) => p })
  const f = (n: number) => formatCount(n, app!.default_country)
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Who should receive this?</CardTitle>
            <CardDescription>Choose segments, lists or people. Anyone in more than one is emailed once.</CardDescription>
          </CardHeader>
          <CardContent>
            <AudiencePicker audience={aud} onChange={(a) => update({ audience: a })} allHint="Everyone in this application who can receive marketing email." />
          </CardContent>
        </Card>
      </div>
      <Card className="h-fit lg:sticky lg:top-20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">Estimated recipients {est.isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="text-4xl font-semibold tabular-nums tracking-tight" data-testid="eligible-count">
              {est.data ? f(est.data.eligible) : '—'}
            </div>
            <div className="text-xs text-muted-foreground">will receive this email{est.data ? ` · ${f(est.data.matched)} matched` : ''}</div>
          </div>
          {est.data && est.data.matched > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Excluded automatically</div>
              {Object.entries(est.data.excluded).map(([k, n]) => (
                <div key={k} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{EXCLUDE_LABEL[k] ?? k}</span>
                  <span className={cn('tabular-nums', n > 0 ? 'font-medium' : 'text-muted-foreground')}>{f(n)}</span>
                </div>
              ))}
              <p className="pt-1 text-xs text-muted-foreground">Consent and suppression are checked again for each person at the moment of sending.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ReviewStep({ draft, goTo, flush }: { draft: Draft; goTo: (s: StepKey) => void; flush: () => Promise<boolean> }) {
  const { app, can } = useWorkspace()
  const user = useUser()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const api = emailApi(app!.id)
  const ready = useQuery({
    queryKey: eqk.readiness(app!.id, draft.id!),
    queryFn: () => api.readiness(draft.id!),
    refetchOnMount: 'always',
    // While the sender awaits confirmation, re-check every few seconds.
    refetchInterval: (q) => (q.state.data?.checks.some((c) => c.key === 'sender' && !c.ok && c.meta?.status === 'pending') ? 4000 : false),
  })
  const [testTo, setTestTo] = useState(user.email)
  const [testing, setTesting] = useState(false)
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 60 * 60 * 1000)
    d.setMinutes(0, 0, 0)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
  const [tz, setTz] = useState(app!.timezone)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const eligible = ready.data?.estimate?.eligible ?? 0
  const f = (n: number) => formatCount(n, app!.default_country)

  const launch = async () => {
    setBusy(true)
    try {
      await flush()
      if (mode === 'now') {
        await api.send(draft.id!)
        toast.success('Campaign is sending')
      } else {
        await api.schedule(draft.id!, when, tz)
        toast.success('Campaign scheduled')
      }
      await qc.invalidateQueries({ queryKey: eqk.all(app!.id) })
      navigate(`/apps/${app!.id}/email/campaigns/${draft.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
      ready.refetch()
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Checklist</CardTitle>
            <CardDescription>Everything here must pass before the campaign can be sent.</CardDescription>
          </CardHeader>
          <CardContent>
            {ready.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <ReadinessList
                checks={ready.data?.checks ?? []}
                channel="email"
                onStep={(s) => goTo(s as StepKey)}
                rowExtra={(c) =>
                  c.key === 'sender' && !c.ok && c.meta?.status === 'pending' && can('settings.write') ? (
                    <SenderVerifyActions senderId={String(c.meta.sender_id)} email={String(c.meta.from_email ?? '')} />
                  ) : null
                }
              />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y text-sm">
              {[
                ['From', draft.from_name ? `${draft.from_name} <${draft.from_email}>` : '—', 'setup'],
                ['Subject', draft.subject || '—', 'setup'],
                ['Preview text', draft.preheader || '—', 'setup'],
                ['Recipients', ready.data?.estimate ? `${f(eligible)} reachable contacts` : '—', 'audience'],
                ['Estimated cost', ready.data?.cost ? `${money(ready.data.cost.total, ready.data.cost.currency)} (${money(ready.data.cost.unit_price, ready.data.cost.currency)} per email)` : '—', 'audience'],
                ['Tracking', `${draft.track_opens ? 'Opens' : 'No opens'} · ${draft.track_clicks ? 'clicks' : 'no clicks'}`, 'setup'],
              ].map(([k, v, step]) => (
                <div key={k} className="flex items-center gap-3 py-2.5 sm:gap-4">
                  <dt className="w-24 shrink-0 text-muted-foreground sm:w-28">{k}</dt>
                  <dd className="min-w-0 flex-1 truncate" data-testid={k === 'Estimated cost' ? 'cost-estimate' : undefined}>{v}</dd>
                  <button className="text-xs font-medium text-primary hover:underline" onClick={() => goTo(step as StepKey)}>
                    Edit
                  </button>
                </div>
              ))}
            </dl>
            <div className="mt-2">
              <WalletLine wallet={ready.data?.wallet} cost={ready.data?.cost} />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Send a test</CardTitle>
            <CardDescription>Up to five addresses, comma separated. Uses sample personalisation.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input className="min-w-0" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Test recipients" />
            <Button
              variant="outline"
              loading={testing}
              onClick={async () => {
                setTesting(true)
                try {
                  await flush()
                  const r = await api.test(draft.id!, testTo.split(',').map((s) => s.trim()).filter(Boolean))
                  const failed = r.results.filter((x) => !x.accepted)
                  if (failed.length) toast.error(`Not sent to ${failed.map((x) => x.email).join(', ')}`)
                  else toast.success(`Test sent${r.provider === 'simulation' ? ' to the development mailbox' : ''}`)
                } catch (e) {
                  toast.error(errorMessage(e))
                } finally {
                  setTesting(false)
                }
              }}
            >
              Send test
            </Button>
          </CardContent>
        </Card>
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle>Delivery</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(['now', 'schedule'] as const).map((m) => (
              <label key={m} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3', mode === m && 'border-primary bg-accent/40')}>
                <input type="radio" className="mt-1 accent-[hsl(var(--primary))]" checked={mode === m} onChange={() => setMode(m)} />
                <span className="text-sm font-medium">{m === 'now' ? 'Send now' : 'Schedule for later'}</span>
              </label>
            ))}
            {mode === 'schedule' && (
              <div className="grid gap-3">
                <Field label="Date and time" htmlFor="s-when">
                  <Input id="s-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                </Field>
                <Field label="Time zone" htmlFor="s-tz">
                  <Select id="s-tz" value={tz} onChange={(e) => setTz(e.target.value)}>
                    {TIMEZONES.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            <Button className="w-full" size="lg" disabled={!ready.data?.ready} onClick={() => setConfirm(true)} data-testid="launch">
              {mode === 'now' ? <Send /> : <CalendarClock />}
              {mode === 'now' ? `Send to ${f(eligible)} contacts` : 'Schedule campaign'}
            </Button>
            {!ready.data?.ready && <p className="text-center text-xs text-muted-foreground">Complete the checklist to enable sending.</p>}
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={mode === 'now' ? `Send to ${f(eligible)} contacts now?` : 'Schedule this campaign?'}
        description={
          mode === 'now'
            ? 'Sending starts immediately. You can pause or cancel while it is in progress, but emails already sent cannot be recalled.'
            : `It will be sent at ${when.replace('T', ' ')} (${tz}). You can unschedule it until then.`
        }
        confirmLabel={mode === 'now' ? 'Send now' : 'Schedule'}
        loading={busy}
        onConfirm={launch}
      />
    </div>
  )
}

// ------------------------------------------------------------------ page

export function CampaignEditorPage() {
  const { campaignId } = useParams()
  const { app, can } = useWorkspace()
  const appId = app!.id
  const q = useCampaign(appId, campaignId!)
  const { draft, update, flush, state } = useAutosave(appId, q.data)
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const step = (params.get('step') as StepKey) || 'setup'
  const idx = STEPS.findIndex((s) => s.key === step)
  const goTo = useCallback(
    async (s: StepKey) => {
      await flush()
      setParams({ step: s }, { replace: true })
      window.scrollTo({ top: 0 })
    },
    [flush, setParams],
  )
  const doneSteps = useMemo(() => {
    const d = new Set<StepKey>()
    if (draft.sender_id && draft.subject) d.add('setup')
    if (draft.html || draft.text) d.add('content')
    if (draft.audience?.all || draft.audience?.segment_ids?.length || draft.audience?.list_ids?.length || draft.audience?.contact_ids?.length) d.add('audience')
    return d
  }, [draft])

  if (q.isLoading) return <FullPageSpinner />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const c = q.data!

  if (c.status !== 'draft')
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>This campaign can't be edited</CardTitle>
          <CardDescription>It is {c.status}. {c.status === 'scheduled' ? 'Unschedule it to make changes.' : 'Duplicate it to send a new version.'}</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          {c.status === 'scheduled' && can('campaigns.launch') && (
            <Button
              onClick={async () => {
                await emailApi(appId).unschedule(c.id)
                await qc.invalidateQueries({ queryKey: eqk.all(appId) })
              }}
            >
              Unschedule and edit
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link to={`/apps/${appId}/email/campaigns/${c.id}`}>View campaign</Link>
          </Button>
        </CardContent>
      </Card>
    )

  return (
    <div className="-mt-2">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="Back to campaigns" onClick={async () => { await flush(); navigate(`/apps/${appId}/email/campaigns`) }}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{draft.name || 'Untitled campaign'}</h1>
            <CampaignStatusBadge status={c.status} />
          </div>
          <SaveIndicator state={state} onRetry={() => void flush()} />
        </div>
        <StepNav steps={STEPS} step={step} done={doneSteps} onGo={goTo} />
      </div>

      {step === 'setup' && <SetupStep draft={draft} update={update} />}
      {step === 'content' && <ContentStep draft={draft} update={update} flush={flush} />}
      {step === 'audience' && <AudienceStep draft={draft} update={update} />}
      {step === 'review' && <ReviewStep draft={draft} goTo={goTo} flush={flush} />}

      {step !== 'review' && (
        <div className="mt-6 flex justify-between">
          <Button variant="outline" disabled={idx === 0} onClick={() => goTo(STEPS[idx - 1]!.key)}>
            <ArrowLeft /> Back
          </Button>
          <Button onClick={() => goTo(STEPS[idx + 1]!.key)}>
            Next: {STEPS[idx + 1]!.label} <ArrowRight />
          </Button>
        </div>
      )}
    </div>
  )
}

/** Creates a draft and opens the editor. */
export function NewCampaignButton({ variant = 'default', label = 'New campaign' }: { variant?: 'default' | 'outline'; label?: string }) {
  const { app } = useWorkspace()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant={variant}
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const c = await emailApi(app!.id).createCampaign({ name: `Campaign ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` })
          navigate(`/apps/${app!.id}/email/campaigns/${c.id}/edit`)
        } catch (e) {
          toast.error(errorMessage(e))
        } finally {
          setBusy(false)
        }
      }}
    >
      <Plus /> {label}
    </Button>
  )
}


