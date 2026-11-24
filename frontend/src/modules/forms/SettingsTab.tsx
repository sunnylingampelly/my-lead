/** Settings tab: after submit, contacts, consent, CRM, notifications, security and display behaviour. */
import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { useWorkspace } from '@/hooks/useWorkspace'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Checkbox } from '@/components/audience'
import type { Channel, FormDisplay, FormSettings, FormSuccess } from '@/types/forms'
import { CHANNEL_LABEL, type TabProps } from './meta'
import { RichText } from './RichText'
import { CheckList, ChipsInput, RequiredText, Section, Segmented, Switch, UrlInput } from './ui'

const clamp = (v: string, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && v.trim() !== '' ? Math.max(min, Math.min(max, n)) : fallback
}

export function SettingsTab({ appId, form, def, patch, meta, write }: TabProps) {
  const { can } = useWorkspace()
  const s = def.settings
  const ok = def.success
  const dp = def.display
  const set = (p: Partial<FormSettings>) => patch({ settings: { ...s, ...p } })
  const setOk = (p: Partial<FormSuccess>) => patch({ success: { ...ok, ...p } })
  const setDp = (p: Partial<FormDisplay>) => patch({ display: { ...dp, ...p } })
  const pipeline = meta?.pipelines.find((p) => p.id === s.deal_pipeline_id)
  const dealTitleRef = useRef<HTMLInputElement>(null)
  const insertToken = (t: string) => {
    const el = dealTitleRef.current
    const v = s.deal_title
    const at = el?.selectionStart ?? v.length
    set({ deal_title: (v.slice(0, at) + t + v.slice(el?.selectionEnd ?? at)).slice(0, 200) })
  }
  const toggle = (arr: Channel[], c: Channel, on: boolean) => (on ? [...new Set([...arr, c])] : arr.filter((x) => x !== c))
  const noSender = !!meta && meta.senders.length === 0

  return (
    <fieldset disabled={!write} className="min-w-0">
      <legend className="sr-only">Form settings</legend>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Section title="After submit" description="What visitors see once they send the form.">
          <Segmented
            label="After submit"
            value={ok.mode}
            onChange={(mode) => setOk({ mode })}
            options={[
              ['message', 'Show a message'],
              ['redirect', 'Redirect'],
              ['both', 'Message, then redirect'],
            ]}
          />
          {ok.mode !== 'redirect' && (
            <div className="space-y-1.5">
              <span className="block text-sm font-medium" id="s-msg-label">
                Thank-you message
              </span>
              <RichText id="s-msg" label="Thank-you message" value={ok.message_html} onChange={(message_html) => setOk({ message_html })} disabled={!write} />
            </div>
          )}
          {ok.mode !== 'message' && (
            <>
              <Field label="Redirect to" htmlFor="s-redirect" hint="A full address, e.g. https://example.com/thank-you">
                <UrlInput id="s-redirect" value={ok.redirect_url} onChange={(redirect_url) => setOk({ redirect_url })} placeholder="https://example.com/thank-you" />
              </Field>
              {ok.mode === 'both' && (
                <Field label="Redirect after (seconds)" htmlFor="s-delay">
                  <Input id="s-delay" type="number" min={0} max={15} className="w-28" value={ok.redirect_delay} onChange={(e) => setOk({ redirect_delay: clamp(e.target.value, 0, 15, 3) })} />
                </Field>
              )}
              <Switch id="s-pass" label="Pass answers to the redirect page" hint="Adds the values as URL parameters (?email=…), useful for pre-filling a booking page. Avoid for sensitive answers." checked={ok.pass_values} onChange={(pass_values) => setOk({ pass_values })} />
              {!ok.redirect_url && (
                <p className="flex items-center gap-1.5 text-xs text-warning-strong">
                  <AlertTriangle className="size-3.5" /> Add the redirect address, or visitors will see the message instead.
                </p>
              )}
            </>
          )}
        </Section>

        <Section title="Contacts" description="Every submission creates or updates a contact in your audience.">
          <Field label="Add to lists" htmlFor="s-lists">
            <CheckList idPrefix="s-list" items={(meta?.lists ?? []).map((l) => ({ id: l.id, label: l.name }))} value={s.list_ids} onChange={(list_ids) => set({ list_ids: list_ids.slice(0, 20) })} empty={<a className="text-primary hover:underline" href={`/apps/${appId}/audience/lists`} target="_blank" rel="noreferrer">No lists yet. Create one in Audience.</a>} />
          </Field>
          <Field label="Add tags" htmlFor="s-tags">
            <CheckList idPrefix="s-tag" items={(meta?.tags ?? []).map((t) => ({ id: t.id, label: t.name }))} value={s.tag_ids} onChange={(tag_ids) => set({ tag_ids: tag_ids.slice(0, 20) })} empty={<a className="text-primary hover:underline" href={`/apps/${appId}/audience/tags`} target="_blank" rel="noreferrer">No tags yet. Create one in Audience.</a>} />
          </Field>
          <Field label="Lead source" htmlFor="s-source" hint="Saved as the contact’s source. Empty uses the form name.">
            <Input id="s-source" value={s.source} maxLength={60} onChange={(e) => set({ source: e.target.value })} placeholder="Website – contact form" />
          </Field>
          <div className="space-y-2">
            <span className="block text-sm font-medium">When the email or phone already exists</span>
            {(
              [
                ['update', 'Update the existing contact', 'Matched by email or phone. Answers overwrite the contact’s details (blank answers never erase anything); an existing email address is never replaced.'],
                ['create', 'Never update existing contacts', 'Never changes an existing contact. If the email or phone already belongs to a contact (your duplicate rule), the submission is linked to that contact.'],
              ] as const
            ).map(([k, l, h]) => (
              <label key={k} className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent/40">
                <input type="radio" name="s-dup" className="mt-0.5 accent-[hsl(var(--primary))]" checked={s.duplicate === k} onChange={() => set({ duplicate: k })} />
                <span>
                  <span className="block font-medium">{l}</span>
                  <span className="block text-xs text-muted-foreground">{h}</span>
                </span>
              </label>
            ))}
          </div>
        </Section>

        <Section title="Consent" description="Record marketing consent the right way. A consent checkbox field grants consent only when ticked.">
          <div className="space-y-1.5">
            <span className="block text-sm font-medium">Submitting the form subscribes to</span>
            <div className="flex flex-wrap gap-4">
              {(['email', 'sms', 'voice'] as Channel[]).map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={s.subscribe_on_submit.includes(c)} onChange={(e) => set({ subscribe_on_submit: toggle(s.subscribe_on_submit, c, e.target.checked) })} />
                  {CHANNEL_LABEL[c]}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Leave all unticked if you only want consent from a checkbox field.</p>
          </div>
          {s.subscribe_on_submit.length > 0 && (
            <Field label="Consent wording" htmlFor="s-consent" hint="Shown under the fields so visitors know what they agree to.">
              <Textarea id="s-consent" value={s.consent_text} maxLength={1000} rows={3} onChange={(e) => set({ consent_text: e.target.value })} placeholder="By submitting, you agree to receive emails from us. You can unsubscribe at any time." />
            </Field>
          )}
          <Switch id="s-doi" label="Double opt-in" hint="New subscribers confirm by email before they count as subscribed." checked={s.double_opt_in} onChange={(double_opt_in) => set({ double_opt_in })} />
          {s.double_opt_in && (
            <>
              {noSender && (
                <p className="flex items-start gap-1.5 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong" role="alert">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    No verified sender yet, so confirmation emails can’t be sent.{' '}
                    <a className="font-medium underline" href={`/apps/${appId}/email/senders`} target="_blank" rel="noreferrer">
                      Add a sender
                    </a>
                  </span>
                </p>
              )}
              <Field label="Send confirmations from" htmlFor="s-sender">
                <Select id="s-sender" value={s.confirm_sender_id ?? ''} onChange={(e) => set({ confirm_sender_id: e.target.value || null })}>
                  <option value="">Default verified sender</option>
                  {meta?.senders.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.from_name} &lt;{x.from_email}&gt;
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Confirmation email subject" htmlFor="s-subject">
                <Input id="s-subject" value={s.confirm_subject} maxLength={200} onChange={(e) => set({ confirm_subject: e.target.value })} />
              </Field>
            </>
          )}
        </Section>

        <Section title="CRM" description="Turn submissions into sales work.">
          <Switch id="s-owner" label="Assign an owner" hint="Runs your CRM assignment rules for new leads." checked={s.assign_owner} onChange={(assign_owner) => set({ assign_owner })} />
          <Switch id="s-lead" label="Set lifecycle stage to Lead" hint="Only moves contacts forward; customers stay customers." checked={s.set_lifecycle_lead} onChange={(set_lifecycle_lead) => set({ set_lifecycle_lead })} />
          <Switch id="s-deal" label="Create a deal" checked={s.create_deal} onChange={(create_deal) => set({ create_deal, ...(create_deal && !s.deal_pipeline_id && meta?.pipelines[0] && { deal_pipeline_id: meta.pipelines[0].id, deal_stage_id: meta.pipelines[0].stages[0]?.id ?? null }) })} />
          {s.create_deal && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Pipeline" htmlFor="s-pipe">
                  <Select id="s-pipe" value={s.deal_pipeline_id ?? ''} onChange={(e) => set({ deal_pipeline_id: e.target.value || null, deal_stage_id: meta?.pipelines.find((p) => p.id === e.target.value)?.stages[0]?.id ?? null })}>
                    <option value="">Default pipeline</option>
                    {meta?.pipelines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Stage" htmlFor="s-stage">
                  <Select id="s-stage" value={s.deal_stage_id ?? ''} disabled={!pipeline || !write} onChange={(e) => set({ deal_stage_id: e.target.value || null })}>
                    <option value="">First stage</option>
                    {pipeline?.stages.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field
                label="Deal title"
                htmlFor="s-dealtitle"
                action={
                  <span className="flex gap-1">
                    {['{name}', '{form}', '{email}'].map((t) => (
                      <button key={t} type="button" className="rounded border px-1.5 font-mono text-[11px] text-muted-foreground hover:bg-muted" onClick={() => insertToken(t)}>
                        {t}
                      </button>
                    ))}
                  </span>
                }
              >
                <Input id="s-dealtitle" ref={dealTitleRef} value={s.deal_title} maxLength={200} onChange={(e) => set({ deal_title: e.target.value })} />
              </Field>
            </div>
          )}
        </Section>

        <Section title="Notifications" description="Tell your team when a lead comes in.">
          <Field label="Notify" htmlFor="s-notify">
            <CheckList
              idPrefix="s-notify"
              items={(meta?.team ?? []).map((u) => ({ id: u.id, label: <>{u.full_name} <span className="text-muted-foreground">{u.email}</span></> }))}
              value={s.notify_user_ids}
              onChange={(notify_user_ids) => set({ notify_user_ids: notify_user_ids.slice(0, 25) })}
              empty="No teammates in this application yet."
            />
          </Field>
          <Switch id="s-nemail" label="Email" checked={s.notify_email} onChange={(notify_email) => set({ notify_email })} />
          <Switch id="s-ninapp" label="In-app notification" checked={s.notify_in_app} onChange={(notify_in_app) => set({ notify_in_app })} />
          {can('automation.write') && (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              Want a welcome email, an SMS or a task?{' '}
              <Link className="font-medium text-primary hover:underline" to={`/apps/${appId}/automation/new?trigger=form_submitted&form_id=${form.id}&name=${encodeURIComponent(`${form.name} follow-up`)}`}>
                Create an automation for this form
              </Link>
            </p>
          )}
        </Section>

        <Section title="Security & spam" description="Submissions are rate-limited and checked with a hidden honeypot automatically.">
          <Field label="Allowed websites" htmlFor="s-domains" hint="Empty = any website can show this form. Add domains like example.com (subdomains included); press Enter after each.">
            <ChipsInput id="s-domains" value={s.allowed_domains} onChange={(allowed_domains) => set({ allowed_domains: allowed_domains.slice(0, 50) })} placeholder="example.com" disabled={!write} normalize={(v) => v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')} />
          </Field>
          <Switch
            id="s-turnstile"
            label="Cloudflare Turnstile"
            hint={meta && !meta.turnstile_available ? 'Not configured on this server. Ask your administrator to add Turnstile keys.' : 'An invisible bot check before submit.'}
            checked={s.turnstile}
            disabled={!write || (!!meta && !meta.turnstile_available)}
            onChange={(turnstile) => set({ turnstile })}
          />
        </Section>

        <Section title="Display behaviour" description="How pop-up, slide-in and floating embeds appear. Inline embeds always show." className="xl:col-span-2">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Default style" htmlFor="s-mode" hint="Used by the hosted link preview; each snippet on the Share tab sets its own style.">
              <Select id="s-mode" value={dp.mode} onChange={(e) => setDp({ mode: e.target.value as FormDisplay['mode'] })}>
                <option value="inline">Inline (in the page)</option>
                <option value="popup">Pop-up</option>
                <option value="slide_in">Slide-in</option>
                <option value="floating">Floating button</option>
              </Select>
            </Field>
            <Field label="Open when" htmlFor="s-trigger">
              <Select id="s-trigger" value={dp.trigger} onChange={(e) => setDp({ trigger: e.target.value as FormDisplay['trigger'] })}>
                <option value="load">After a delay</option>
                <option value="scroll">After scrolling</option>
                <option value="exit">On exit intent (desktop)</option>
                <option value="click">Only when clicked</option>
              </Select>
            </Field>
            {dp.trigger === 'load' && (
              <Field label="Delay (seconds)" htmlFor="s-delay-s">
                <Input id="s-delay-s" type="number" min={0} max={300} value={dp.delay_seconds} onChange={(e) => setDp({ delay_seconds: clamp(e.target.value, 0, 300, 5) })} />
              </Field>
            )}
            {dp.trigger === 'scroll' && (
              <Field label="Scroll depth (%)" htmlFor="s-scroll">
                <Input id="s-scroll" type="number" min={1} max={100} value={dp.scroll_percent} onChange={(e) => setDp({ scroll_percent: clamp(e.target.value, 1, 100, 50) })} />
              </Field>
            )}
            {dp.trigger === 'exit' && <p className="self-end text-xs text-muted-foreground">Exit intent needs a mouse; on phones the form opens after the delay instead.</p>}
            <Field label="Show it" htmlFor="s-freq">
              <div className="flex gap-2">
                <Select id="s-freq" value={dp.frequency} onChange={(e) => setDp({ frequency: e.target.value as FormDisplay['frequency'] })}>
                  <option value="once">Once per visitor</option>
                  <option value="days">Again after some days</option>
                  <option value="always">On every visit</option>
                </Select>
                {dp.frequency === 'days' && (
                  <Input aria-label="Days between shows" type="number" min={1} max={365} className="w-24 shrink-0" value={dp.frequency_days} onChange={(e) => setDp({ frequency_days: clamp(e.target.value, 1, 365, 7) })} />
                )}
              </div>
            </Field>
            <Field label="Devices" htmlFor="s-devices">
              <Select id="s-devices" value={dp.devices} onChange={(e) => setDp({ devices: e.target.value as FormDisplay['devices'] })}>
                <option value="all">Desktop and mobile</option>
                <option value="desktop">Desktop only</option>
                <option value="mobile">Mobile only</option>
              </Select>
            </Field>
            <Field label="Position (slide-in and floating)" htmlFor="s-pos">
              <Select id="s-pos" value={dp.position} onChange={(e) => setDp({ position: e.target.value as FormDisplay['position'] })}>
                <option value="bottom_right">Bottom right</option>
                <option value="bottom_left">Bottom left</option>
              </Select>
            </Field>
            <Field label="Floating button label" htmlFor="s-btnlabel">
              <RequiredText id="s-btnlabel" value={dp.button_label} maxLength={40} onChange={(button_label) => setDp({ button_label })} disabled={!write} />
            </Field>
          </div>
          <Switch id="s-hide" label="Stop showing after the visitor submits" checked={dp.hide_after_submit} onChange={(hide_after_submit) => setDp({ hide_after_submit })} />
        </Section>
      </div>
    </fieldset>
  )
}
