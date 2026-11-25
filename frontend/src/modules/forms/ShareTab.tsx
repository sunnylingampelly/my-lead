/** Share tab: embed snippets, hosted link, send-to-developer and platform notes. */
import { useState } from 'react'
import { toast } from 'sonner'
import { ExternalLink, Rocket, Send } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { formsApi } from '@/api/forms'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/form-controls'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { emailSchema } from '@/lib/forms'
import type { TabProps } from './meta'
import { CodeBlock, CopyButton } from './ui'

const PLATFORMS: [string, string][] = [
  ['WordPress', 'Edit the page, add a “Custom HTML” block and paste the code.'],
  ['Shopify', 'Online Store → Themes → Customize: add a “Custom Liquid” section, or paste before </body> in theme.liquid for pop-ups.'],
  ['Wix', 'Add → Embed code → Embed HTML (inline), or Settings → Custom code for pop-ups on every page.'],
  ['Webflow', 'Drag an “Embed” element onto the page and paste the code.'],
  ['Squarespace', 'Add a “Code” block (inline), or Settings → Advanced → Code injection for pop-ups.'],
]

export function ShareTab({ appId, form, write, onPublish, publishing }: TabProps & { onPublish: () => void; publishing: boolean }) {
  const e = form.embed
  const live = form.status === 'published'
  const [dev, setDev] = useState(false)
  const snippets = [
    ['inline', 'Inline', 'Shows the form inside your page, where you paste the code.', e.inline],
    ['popup', 'Pop-up', 'A centred pop-up, opened by the display rules in Settings (delay, scroll, exit intent).', e.popup],
    ['slide_in', 'Slide-in', 'Slides in from the corner without covering the page.', e.slide_in],
    ['floating', 'Floating button', 'A button that stays in the corner and opens the form.', e.floating],
    ['button', 'Click trigger', 'Opens the form when any element with this attribute is clicked, e.g. your own “Contact us” button. Paste the script once per page.', e.button],
  ] as const

  return (
    <div className="space-y-4">
      {!live && (
        <div className="flex flex-col gap-3 rounded-lg border border-warning-border bg-warning-soft p-4 text-sm text-warning-strong sm:flex-row sm:items-center sm:justify-between" role="status" data-testid="publish-banner">
          <span>{form.status === 'paused' ? 'This form is paused: embeds show nothing and submissions are refused.' : 'Publish the form to make it live. Snippets work as soon as it is published.'}</span>
          {write && (
            <Button size="sm" onClick={onPublish} loading={publishing}>
              <Rocket /> {form.status === 'paused' ? 'Resume' : 'Publish'}
            </Button>
          )}
        </div>
      )}
      {live && form.has_unpublished_changes && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">Your website shows the published version. Publish changes to update it; the code stays the same.</p>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="min-w-0">
          <CardHeader className="flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Add it to your website</CardTitle>
              <CardDescription>Copy one snippet and paste it into your site’s HTML. Design changes you publish later appear automatically.</CardDescription>
            </div>
            {write && (
              <Button variant="outline" size="sm" onClick={() => setDev(true)} className="shrink-0">
                <Send /> Send to my developer
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="inline">
              <div className="overflow-x-auto">
                <TabsList className="w-max min-w-full">
                  {snippets.map(([k, l]) => (
                    <TabsTrigger key={k} value={k}>
                      {l}
                    </TabsTrigger>
                  ))}
                  <TabsTrigger value="hosted">Hosted link</TabsTrigger>
                </TabsList>
              </div>
              {snippets.map(([k, , help, code]) => (
                <TabsContent key={k} value={k} className="space-y-3 pt-4">
                  <p className="text-sm text-muted-foreground">{help}</p>
                  <CodeBlock code={code} testId={`snippet-${k}`} />
                </TabsContent>
              ))}
              <TabsContent value="hosted" className="space-y-3 pt-4">
                <p className="text-sm text-muted-foreground">A page we host for you. Share it in emails, social posts, QR codes or your link-in-bio.</p>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                  <Input readOnly value={e.hosted_url} aria-label="Hosted link" className="min-w-0 font-mono text-xs" data-testid="hosted-url" onFocus={(ev) => ev.currentTarget.select()} />
                  <div className="flex shrink-0 gap-2">
                    <CopyButton text={e.hosted_url} label="Copy link" testId="copy-hosted" />
                    <Button size="sm" variant="outline" asChild>
                      <a href={e.hosted_url} target="_blank" rel="noreferrer">
                        <ExternalLink /> Open
                      </a>
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Prefer an iframe? <code className="break-all font-mono">{`<iframe src="${e.iframe_url}" style="width:100%;border:0;min-height:600px"></iframe>`}</code>
                </p>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Where to paste it</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              {PLATFORMS.map(([p, how]) => (
                <div key={p}>
                  <dt className="font-medium">{p}</dt>
                  <dd className="text-muted-foreground">{how}</dd>
                </div>
              ))}
              <div>
                <dt className="font-medium">Any other site</dt>
                <dd className="text-muted-foreground">Paste inline code where the form should appear; pop-up code anywhere before &lt;/body&gt;.</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>
      <DeveloperDialog open={dev} onOpenChange={setDev} appId={appId} formId={form.id} />
    </div>
  )
}

function DeveloperDialog({ open, onOpenChange, appId, formId }: { open: boolean; onOpenChange: (o: boolean) => void; appId: string; formId: string }) {
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const send = async () => {
    const parsed = emailSchema.safeParse(email)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid email address')
      return
    }
    setBusy(true)
    try {
      await formsApi(appId).sendToDeveloper(formId, { email: parsed.data, note: note.slice(0, 1000) })
      toast.success(`Instructions sent to ${parsed.data}`)
      onOpenChange(false)
      setEmail('')
      setNote('')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send to my developer</DialogTitle>
          <DialogDescription>We’ll email the embed code and step-by-step instructions.</DialogDescription>
        </DialogHeader>
        <Field label="Developer’s email" htmlFor="dev-email" error={error ?? undefined}>
          <Input
            id="dev-email"
            type="email"
            value={email}
            aria-invalid={!!error}
            onChange={(e) => {
              setEmail(e.target.value)
              setError(null)
            }}
          />
        </Field>
        <Field label="Note (optional)" htmlFor="dev-note">
          <Textarea id="dev-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Please add this to the contact page." />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={send} loading={busy}>
            <Send /> Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
