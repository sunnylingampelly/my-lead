/** Website chatbots: list, templates, the editor (behaviour, training, lead capture, widget, install) and the
 *  Test & train chat with "Improve answer". */
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Bot,
  Check,
  Copy,
  ExternalLink,
  FileUp,
  Globe,
  HelpCircle,
  MessageSquareText,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react'
import { chatApi, cqk, useBots, useChatStatus } from '@/api/chat'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, FullPageSpinner, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, Input, Select, Textarea } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn, timeAgo } from '@/lib/utils'
import type { Appearance, BotTemplate, BusinessHours, ChatBot, KnowledgeSource, LeadCapture, Proactive, TestReply } from '@/types/chat'

const DAYS: [string, string][] = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']]
const LANGS: [string, string][] = [['auto', "Visitor's language (automatic)"], ['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['ar', 'Arabic'], ['ta', 'Tamil'], ['te', 'Telugu'], ['mr', 'Marathi'], ['bn', 'Bengali']]
const LEAD_FIELDS: [string, string][] = [['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['company', 'Company']]

function useCrumbs(label?: string) {
  const { app, org } = useWorkspace()
  return [
    { label: org?.name ?? '' },
    { label: app!.name, to: `/apps/${app!.id}` },
    { label: 'Chat', to: `/apps/${app!.id}/chat` },
    ...(label ? [{ label: 'Chatbots', to: `/apps/${app!.id}/chat/bots` }, { label }] : [{ label: 'Chatbots' }]),
  ]
}

function fmtChars(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n)
}

// ------------------------------------------------------------------ list

function NewBotDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { app } = useWorkspace()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const templates = useQuery({ queryKey: ['chat', app!.id, 'templates'], queryFn: () => chatApi(app!.id).templates(), enabled: open, staleTime: 600_000 })
  const [template, setTemplate] = useState('website_assistant')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setName('')
  }, [open])
  async function create() {
    setBusy(true)
    try {
      const b = await chatApi(app!.id).createBot({ name: name.trim() || 'Website assistant', template })
      qc.invalidateQueries({ queryKey: cqk.bots(app!.id) })
      onOpenChange(false)
      navigate(`/apps/${app!.id}/chat/bots/${b.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New chatbot</DialogTitle>
          <DialogDescription>Pick a template. It comes with instructions, a welcome message and suggested replies you can change.</DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 gap-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Template">
            {(templates.data ?? []).map((t: BotTemplate) => (
              <button
                key={t.key}
                type="button"
                role="radio"
                aria-checked={template === t.key}
                onClick={() => setTemplate(t.key)}
                className={cn('min-w-0 rounded-lg border p-3 text-left transition', template === t.key ? 'border-primary bg-accent/40' : 'hover:bg-muted')}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  {template === t.key ? <Check className="size-4 text-primary" /> : <Bot className="size-4 text-muted-foreground" />}
                  {t.name}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
              </button>
            ))}
            {templates.isLoading && <LoadingRows rows={2} />}
          </div>
          <Field label="Name" htmlFor="bot-name" hint="Visitors see it in the chat header.">
            <Input id="bot-name" value={name} maxLength={120} placeholder="Website assistant" onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={busy} onClick={create} data-testid="create-bot">
            Create chatbot
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ChatBotsPage() {
  const { app, can } = useWorkspace()
  const bots = useBots(app!.id)
  const status = useChatStatus(app!.id)
  const [open, setOpen] = useState(false)
  const crumbs = useCrumbs()
  return (
    <div>
      <PageHeader
        title="Chatbots"
        description="AI assistants for your website. Train them on your business, then add one line of code to your site."
        breadcrumbs={crumbs}
        actions={can('chat.write') && (
          <Button onClick={() => setOpen(true)} data-testid="new-bot">
            <Plus /> New chatbot
          </Button>
        )}
      />
      {status.data && !status.data.configured && (
        <p className="mb-4 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-strong">
          AI isn't configured on this server, so chatbot replies are <strong>simulated</strong> (simple FAQ matching) and free.
        </p>
      )}
      <Card>
        {bots.isLoading ? (
          <LoadingRows />
        ) : bots.isError ? (
          <ErrorState error={bots.error} onRetry={() => bots.refetch()} />
        ) : !bots.data?.length ? (
          <EmptyState
            icon={MessageSquareText}
            title="No chatbots yet"
            description="Create a chatbot that answers visitors from your website, FAQs and documents, captures leads and hands over to your team."
            action={can('chat.write') && <Button onClick={() => setOpen(true)}><Plus /> New chatbot</Button>}
          />
        ) : (
          <ul className="divide-y">
            {bots.data.map((b) => (
              <li key={b.id}>
                <Link to={`/apps/${app!.id}/chat/bots/${b.id}`} className="flex flex-wrap items-center gap-3 px-5 py-4 hover:bg-muted/40">
                  <span className="flex size-9 items-center justify-center rounded-full text-white" style={{ background: b.appearance.color }}>
                    <Bot className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{b.name}</span>
                      <Badge variant={b.status === 'live' ? 'success' : 'secondary'}>{b.status === 'live' ? 'Live' : 'Draft'}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {b.source_count ?? 0} training sources · {fmtChars(b.knowledge_chars)} characters · {b.conversation_count ?? 0} conversations
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">Updated {timeAgo(b.updated_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <NewBotDialog open={open} onOpenChange={setOpen} />
    </div>
  )
}

// ------------------------------------------------------------------ editor

export function ChatBotEditorPage() {
  const { botId } = useParams()
  const { app, can } = useWorkspace()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery({ queryKey: cqk.bot(app!.id, botId!), queryFn: () => chatApi(app!.id).bot(botId!) })
  const crumbs = useCrumbs(q.data?.name ?? 'Chatbot')
  const [del, setDel] = useState(false)
  const [busy, setBusy] = useState(false)
  if (q.isLoading) return <FullPageSpinner />
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const bot = q.data
  const editable = can('chat.write')
  const set = (b: ChatBot) => {
    qc.setQueryData(cqk.bot(app!.id, b.id), b)
    qc.invalidateQueries({ queryKey: cqk.bots(app!.id) })
  }
  async function save(body: Partial<ChatBot>, what = 'Saved') {
    try {
      set(await chatApi(app!.id).updateBot(bot.id, body))
      toast.success(what)
      return true
    } catch (e) {
      toast.error(errorMessage(e))
      return false
    }
  }
  async function togglePublish() {
    setBusy(true)
    try {
      set(bot.status === 'live' ? await chatApi(app!.id).unpublish(bot.id) : await chatApi(app!.id).publish(bot.id))
      toast.success(bot.status === 'live' ? 'Chatbot is now a draft' : 'Chatbot is live')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <PageHeader
        title={bot.name}
        breadcrumbs={crumbs}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Badge variant={bot.status === 'live' ? 'success' : 'secondary'} data-testid="bot-status">{bot.status === 'live' ? 'Live' : 'Draft'}</Badge>
            {bot.status === 'live' ? 'Visible on websites with the install code.' : 'Only you can try it (test chat and preview page).'}
          </span>
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to={`/apps/${app!.id}/chat/bots`}>
                <ArrowLeft /> All chatbots
              </Link>
            </Button>
            {editable && (
              <Button loading={busy} variant={bot.status === 'live' ? 'outline' : 'default'} onClick={togglePublish} data-testid="publish-bot">
                {bot.status === 'live' ? 'Unpublish' : 'Publish'}
              </Button>
            )}
            {editable && (
              <Button variant="ghost" size="icon" aria-label="Delete chatbot" onClick={() => setDel(true)}>
                <Trash2 />
              </Button>
            )}
          </>
        }
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Tabs defaultValue="training" className="min-w-0">
          <TabsList className="overflow-x-auto">
            <TabsTrigger value="training">Training</TabsTrigger>
            <TabsTrigger value="behaviour">Behaviour</TabsTrigger>
            <TabsTrigger value="leads">Lead capture</TabsTrigger>
            <TabsTrigger value="widget">Widget</TabsTrigger>
            <TabsTrigger value="install">Install</TabsTrigger>
          </TabsList>
          <TabsContent value="training">
            <TrainingTab bot={bot} editable={editable} />
          </TabsContent>
          <TabsContent value="behaviour">
            <BehaviourTab bot={bot} editable={editable} save={save} />
          </TabsContent>
          <TabsContent value="leads">
            <LeadTab bot={bot} editable={editable} save={save} />
          </TabsContent>
          <TabsContent value="widget">
            <WidgetTab bot={bot} editable={editable} save={save} />
          </TabsContent>
          <TabsContent value="install">
            <InstallTab bot={bot} />
          </TabsContent>
        </Tabs>
        <TestChat bot={bot} editable={editable} />
      </div>
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title="Delete this chatbot?"
        description="Its training, conversations and the install code stop working. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          try {
            await chatApi(app!.id).deleteBot(bot.id)
            qc.invalidateQueries({ queryKey: cqk.bots(app!.id) })
            navigate(`/apps/${app!.id}/chat/bots`)
          } catch (e) {
            toast.error(errorMessage(e))
          }
        }}
      />
    </div>
  )
}

type SaveFn = (body: Partial<ChatBot>, what?: string) => Promise<boolean>

// ------------------------------------------------------------------ training

function TrainingTab({ bot, editable }: { bot: ChatBot; editable: boolean }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const status = useChatStatus(app!.id)
  const sources = useQuery({
    queryKey: cqk.sources(app!.id, bot.id),
    queryFn: () => chatApi(app!.id).sources(bot.id),
    refetchInterval: (query) => ((query.state.data as KnowledgeSource[] | undefined)?.some((s) => s.status === 'processing') ? 2000 : false),
  })
  const [kind, setKind] = useState<'faq' | 'text' | 'url' | 'file'>('faq')
  const [edit, setEdit] = useState<KnowledgeSource | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: cqk.sources(app!.id, bot.id) })
    qc.invalidateQueries({ queryKey: cqk.bot(app!.id, bot.id) })
  }
  const limit = status.data?.inline_limit ?? 150_000
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Train your chatbot</CardTitle>
          <CardDescription>
            The bot answers only from what you add here and its instructions. When it doesn't know, it says so and offers a person or takes the visitor's details.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{fmtChars(bot.knowledge_chars)} characters</span>
            <Badge variant="outline">{bot.knowledge_mode === 'inline' ? 'All knowledge in every answer' : 'Best passages per question'}</Badge>
            <span className="text-xs text-muted-foreground">
              {bot.knowledge_mode === 'inline'
                ? `Up to ${fmtChars(limit)} characters are read in full for every answer.`
                : `Over ${fmtChars(limit)} characters: FAQs are always used, other sources are searched for each question.`}
            </span>
          </div>
          {editable && (
            <>
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Add a source">
                {([['faq', 'FAQ', HelpCircle], ['text', 'Text', MessageSquareText], ['url', 'Website', Globe], ['file', 'File', FileUp]] as const).map(([k, label, Icon]) => (
                  <Button key={k} size="sm" variant={kind === k ? 'default' : 'outline'} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
                    <Icon /> {label}
                  </Button>
                ))}
              </div>
              <AddSource bot={bot} kind={kind} onAdded={refresh} />
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sources</CardTitle>
        </CardHeader>
        {sources.isLoading ? (
          <LoadingRows />
        ) : !sources.data?.length ? (
          <EmptyState title="Nothing yet" description="Add FAQs, paste text about your business, fetch pages from your website or upload documents." />
        ) : (
          <ul className="divide-y" data-testid="sources">
            {sources.data.map((s) => (
              <SourceRow key={s.id} bot={bot} s={s} editable={editable} onEdit={() => setEdit(s)} onChange={refresh} />
            ))}
          </ul>
        )}
      </Card>
      {edit && <EditSourceDialog bot={bot} source={edit} onClose={() => setEdit(null)} onSaved={refresh} />}
    </div>
  )
}

function AddSource({ bot, kind, onAdded }: { bot: ChatBot; kind: 'faq' | 'text' | 'url' | 'file'; onAdded: () => void }) {
  const { app } = useWorkspace()
  const [q, setQ] = useState('')
  const [a, setA] = useState('')
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [crawl, setCrawl] = useState(false)
  const [pages, setPages] = useState(10)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true)
    try {
      await fn()
      toast.success(ok)
      setQ('')
      setA('')
      setTitle('')
      setUrl('')
      onAdded()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const api = chatApi(app!.id)
  if (kind === 'faq')
    return (
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(() => api.addSource(bot.id, { kind: 'faq', question: q, content: a }), 'FAQ added') }}>
        <Field label="Question" htmlFor="faq-q">
          <Input id="faq-q" value={q} maxLength={2000} onChange={(e) => setQ(e.target.value)} placeholder="Do you offer free delivery?" />
        </Field>
        <Field label="Answer" htmlFor="faq-a">
          <Textarea id="faq-a" value={a} maxLength={10000} rows={3} onChange={(e) => setA(e.target.value)} placeholder="Yes, on orders over ₹999 within India." />
        </Field>
        <div><Button type="submit" loading={busy} disabled={!q.trim() || !a.trim()} data-testid="add-faq">Add FAQ</Button></div>
      </form>
    )
  if (kind === 'text')
    return (
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(() => api.addSource(bot.id, { kind: 'text', title, content: a }), 'Text added') }}>
        <Field label="Title" htmlFor="txt-t">
          <Input id="txt-t" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} placeholder="About us, pricing, policies…" />
        </Field>
        <Field label="Text" htmlFor="txt-c" hint="Paste anything visitors may ask about: services, prices, policies, hours.">
          <Textarea id="txt-c" value={a} rows={6} onChange={(e) => setA(e.target.value)} />
        </Field>
        <div><Button type="submit" loading={busy} disabled={!a.trim()}>Add text</Button></div>
      </form>
    )
  if (kind === 'url')
    return (
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(() => api.addSource(bot.id, { kind: 'url', url, crawl, max_pages: pages }), crawl ? 'Reading your site…' : 'Reading the page…') }}>
        <Field label="Web address" htmlFor="src-url" hint="We read the page's main text (menus, scripts and footers are skipped) and respect robots.txt when crawling.">
          <Input id="src-url" value={url} maxLength={2000} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.example.com/faq" inputMode="url" />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={crawl} onChange={(e) => setCrawl(e.target.checked)} className="size-4 accent-[hsl(var(--primary))]" />
          Also read other pages on this site (from its sitemap)
        </label>
        {crawl && (
          <Field label="Up to how many pages" htmlFor="src-pages">
            <Input id="src-pages" type="number" min={1} max={50} value={pages} onChange={(e) => setPages(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} className="w-28" />
          </Field>
        )}
        <div><Button type="submit" loading={busy} disabled={!url.trim()}>Fetch</Button></div>
      </form>
    )
  return (
    <div className="grid gap-2">
      <input
        ref={fileRef}
        type="file"
        className="sr-only"
        accept=".txt,.md,.markdown,.csv,.pdf,.docx,.html,.htm"
        aria-label="Upload a document"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) run(() => api.uploadSource(bot.id, f), `${f.name} added`)
        }}
      />
      <div>
        <Button variant="outline" loading={busy} onClick={() => fileRef.current?.click()}>
          <FileUp /> Upload a document
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">PDF, Word (.docx), text, Markdown, CSV or HTML, up to 10 MB. Scanned PDFs without selectable text can't be read.</p>
    </div>
  )
}

function SourceRow({ bot, s, editable, onEdit, onChange }: { bot: ChatBot; s: KnowledgeSource; editable: boolean; onEdit: () => void; onChange: () => void }) {
  const { app } = useWorkspace()
  const api = chatApi(app!.id)
  const icon = { faq: HelpCircle, text: MessageSquareText, url: Globe, file: FileUp }[s.kind]
  const Icon = icon
  return (
    <li className="flex flex-wrap items-start gap-3 px-5 py-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words text-sm font-medium">{s.title || s.url}</span>
          {s.status !== 'ready' && <Badge variant={s.status === 'failed' ? 'destructive' : 'warning'}>{s.status === 'failed' ? 'Failed' : 'Reading…'}</Badge>}
        </div>
        {s.kind === 'faq' ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{s.content}</p>
        ) : s.url ? (
          <p className="truncate text-xs text-muted-foreground">{s.url}{s.meta.pages && s.meta.pages.length > 1 ? ` · ${s.meta.pages.length} pages` : ''}</p>
        ) : null}
        {s.error && <p className="text-xs text-destructive">{s.error}</p>}
        <p className="text-xs text-muted-foreground">
          {fmtChars(s.char_count)} characters{s.last_synced_at ? ` · synced ${timeAgo(s.last_synced_at)}` : ''}
        </p>
      </div>
      {editable && (
        <div className="flex gap-1">
          {(s.kind === 'faq' || s.kind === 'text') && (
            <Button size="sm" variant="ghost" onClick={onEdit}>Edit</Button>
          )}
          {s.kind === 'url' && (
            <Button size="icon" variant="ghost" aria-label="Re-sync" onClick={async () => { try { await api.resync(bot.id, s.id); onChange() } catch (e) { toast.error(errorMessage(e)) } }}>
              <RefreshCw />
            </Button>
          )}
          <Button size="icon" variant="ghost" aria-label="Delete source" onClick={async () => { try { await api.deleteSource(bot.id, s.id); onChange() } catch (e) { toast.error(errorMessage(e)) } }}>
            <Trash2 />
          </Button>
        </div>
      )}
    </li>
  )
}

function EditSourceDialog({ bot, source, onClose, onSaved }: { bot: ChatBot; source: KnowledgeSource; onClose: () => void; onSaved: () => void }) {
  const { app } = useWorkspace()
  const full = useQuery({ queryKey: ['chat', app!.id, 'source', source.id], queryFn: () => chatApi(app!.id).source(bot.id, source.id) })
  const [q, setQ] = useState(source.question ?? '')
  const [title, setTitle] = useState(source.title)
  const [content, setContent] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const value = content ?? full.data?.content ?? ''
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{source.kind === 'faq' ? 'Edit FAQ' : 'Edit text'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          {source.kind === 'faq' ? (
            <Field label="Question" htmlFor="e-q"><Input id="e-q" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          ) : (
            <Field label="Title" htmlFor="e-t"><Input id="e-t" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          )}
          <Field label={source.kind === 'faq' ? 'Answer' : 'Text'} htmlFor="e-c">
            <Textarea id="e-c" rows={8} value={value} onChange={(e) => setContent(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await chatApi(app!.id).updateSource(bot.id, source.id, source.kind === 'faq' ? { question: q, content: value } : { title, content: value })
                onSaved()
                onClose()
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

// ------------------------------------------------------------------ behaviour

function BehaviourTab({ bot, editable, save }: { bot: ChatBot; editable: boolean; save: SaveFn }) {
  const [f, setF] = useState(() => ({
    name: bot.name, avatar_url: bot.avatar_url ?? '', welcome_message: bot.welcome_message, chips: bot.quick_replies.join('\n'),
    instructions: bot.instructions, language: bot.language, fallback: bot.fallback, routing: bot.routing,
  }))
  const [hours, setHours] = useState<BusinessHours>(bot.business_hours)
  const [busy, setBusy] = useState(false)
  const up = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))
  return (
    <Card>
      <CardContent className="grid gap-4 pt-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="b-name"><Input id="b-name" value={f.name} maxLength={120} disabled={!editable} onChange={(e) => up({ name: e.target.value })} /></Field>
          <Field label="Avatar image (https URL)" htmlFor="b-avatar" hint="Optional. Square images look best.">
            <Input id="b-avatar" value={f.avatar_url} maxLength={500} disabled={!editable} placeholder="https://…/logo.png" onChange={(e) => up({ avatar_url: e.target.value })} />
          </Field>
        </div>
        <Field label="Welcome message" htmlFor="b-welcome">
          <Textarea id="b-welcome" rows={2} maxLength={1000} value={f.welcome_message} disabled={!editable} onChange={(e) => up({ welcome_message: e.target.value })} />
        </Field>
        <Field label="Suggested replies" htmlFor="b-chips" hint="One per line, up to 6. Shown as buttons before the visitor types.">
          <Textarea id="b-chips" rows={3} value={f.chips} disabled={!editable} onChange={(e) => up({ chips: e.target.value })} />
        </Field>
        <Field label="Instructions" htmlFor="b-instr" hint="Persona, tone, goal, do's and don'ts. Facts belong in Training.">
          <Textarea id="b-instr" rows={10} maxLength={20000} value={f.instructions} disabled={!editable} onChange={(e) => up({ instructions: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Language" htmlFor="b-lang">
            <Select id="b-lang" value={f.language} disabled={!editable} onChange={(e) => up({ language: e.target.value })}>
              {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="When it can't answer" htmlFor="b-fallback">
            <Select id="b-fallback" value={f.fallback} disabled={!editable} onChange={(e) => up({ fallback: e.target.value as ChatBot['fallback'] })}>
              <option value="human">Offer a person</option>
              <option value="collect">Collect contact details</option>
            </Select>
          </Field>
          <Field label="Hand-offs go to" htmlFor="b-routing">
            <Select id="b-routing" value={f.routing} disabled={!editable} onChange={(e) => up({ routing: e.target.value as ChatBot['routing'] })}>
              <option value="broadcast">Every online agent</option>
              <option value="round_robin">The next agent (round robin)</option>
            </Select>
          </Field>
        </div>
        <fieldset className="grid gap-3 rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">Live-chat hours</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={hours.enabled} disabled={!editable} onChange={(e) => setHours({ ...hours, enabled: e.target.checked })} />
            Only offer live chat during these hours (outside them visitors leave a message)
          </label>
          {hours.enabled && (
            <>
              <Field label="Time zone" htmlFor="b-tz"><Input id="b-tz" value={hours.timezone} disabled={!editable} onChange={(e) => setHours({ ...hours, timezone: e.target.value })} /></Field>
              <div className="grid gap-2">
                {DAYS.map(([k, label]) => {
                  const span = hours.days[k]
                  return (
                    <div key={k} className="flex flex-wrap items-center gap-2 text-sm">
                      <label className="flex w-20 items-center gap-2">
                        <input type="checkbox" className="size-4" checked={!!span} disabled={!editable}
                          onChange={(e) => setHours({ ...hours, days: { ...hours.days, [k]: e.target.checked ? ['09:00', '18:00'] : null } })} />
                        {label}
                      </label>
                      {span && (
                        <>
                          <Input aria-label={`${label} opens`} type="time" className="w-28" value={span[0]} disabled={!editable}
                            onChange={(e) => setHours({ ...hours, days: { ...hours.days, [k]: [e.target.value, span[1]] } })} />
                          <span>to</span>
                          <Input aria-label={`${label} closes`} type="time" className="w-28" value={span[1]} disabled={!editable}
                            onChange={(e) => setHours({ ...hours, days: { ...hours.days, [k]: [span[0], e.target.value] } })} />
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </fieldset>
        {editable && (
          <div>
            <Button
              loading={busy}
              onClick={async () => {
                setBusy(true)
                await save({
                  name: f.name, avatar_url: f.avatar_url.trim() || null, welcome_message: f.welcome_message,
                  quick_replies: f.chips.split('\n').map((c) => c.trim()).filter(Boolean).slice(0, 6),
                  instructions: f.instructions, language: f.language, fallback: f.fallback, routing: f.routing, business_hours: hours,
                })
                setBusy(false)
              }}
            >
              Save behaviour
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ lead capture

function LeadTab({ bot, editable, save }: { bot: ChatBot; editable: boolean; save: SaveFn }) {
  const [lc, setLc] = useState<LeadCapture>(bot.lead_capture)
  const [busy, setBusy] = useState(false)
  const field = (k: string) => lc.fields.find((x) => x.key === k)
  function toggle(k: string, label: string, on: boolean) {
    setLc({ ...lc, fields: on ? [...lc.fields, { key: k, label, required: k === 'email' }] : lc.fields.filter((x) => x.key !== k) })
  }
  return (
    <Card>
      <CardContent className="grid gap-4 pt-5">
        <Field label="When to ask for contact details" htmlFor="l-mode">
          <Select id="l-mode" value={lc.mode} disabled={!editable} onChange={(e) => setLc({ ...lc, mode: e.target.value as LeadCapture['mode'] })}>
            <option value="when_needed">Only when needed (the bot decides: quotes, bookings, follow-ups)</option>
            <option value="after">After a few messages</option>
            <option value="before">Before the chat starts</option>
            <option value="off">Never ask (visitors can still leave details when they want a person)</option>
          </Select>
        </Field>
        {lc.mode === 'after' && (
          <Field label="After this many visitor messages" htmlFor="l-after">
            <Input id="l-after" type="number" min={1} max={20} className="w-28" value={lc.after_messages} disabled={!editable}
              onChange={(e) => setLc({ ...lc, after_messages: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} />
          </Field>
        )}
        <Field label="Form message" htmlFor="l-prompt">
          <Input id="l-prompt" value={lc.prompt} maxLength={300} disabled={!editable} onChange={(e) => setLc({ ...lc, prompt: e.target.value })} />
        </Field>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Fields (saved to the contact)</legend>
          {LEAD_FIELDS.map(([k, label]) => {
            const fld = field(k)
            return (
              <div key={k} className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex w-32 items-center gap-2">
                  <input type="checkbox" className="size-4" checked={!!fld} disabled={!editable} onChange={(e) => toggle(k, label, e.target.checked)} />
                  {label}
                </label>
                {fld && (
                  <label className="flex items-center gap-2 text-muted-foreground">
                    <input type="checkbox" className="size-4" checked={fld.required} disabled={!editable}
                      onChange={(e) => setLc({ ...lc, fields: lc.fields.map((x) => (x.key === k ? { ...x, required: e.target.checked } : x)) })} />
                    Required
                  </label>
                )}
              </div>
            )
          })}
        </fieldset>
        <fieldset className="grid gap-2 rounded-lg border p-4">
          <legend className="px-1 text-sm font-medium">Marketing consent</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={lc.consent.enabled} disabled={!editable} onChange={(e) => setLc({ ...lc, consent: { ...lc.consent, enabled: e.target.checked } })} />
            Show an opt-in checkbox (unticked by default). Ticking it records consent with evidence.
          </label>
          {lc.consent.enabled && (
            <>
              <Field label="Checkbox text" htmlFor="l-consent"><Input id="l-consent" maxLength={300} value={lc.consent.text} disabled={!editable} onChange={(e) => setLc({ ...lc, consent: { ...lc.consent, text: e.target.value } })} /></Field>
              <div className="flex gap-4 text-sm">
                {(['email', 'sms'] as const).map((ch) => (
                  <label key={ch} className="flex items-center gap-2">
                    <input type="checkbox" className="size-4" disabled={!editable} checked={lc.consent.channels.includes(ch)}
                      onChange={(e) => setLc({ ...lc, consent: { ...lc.consent, channels: e.target.checked ? [...lc.consent.channels, ch] : lc.consent.channels.filter((c) => c !== ch) } })} />
                    {ch === 'email' ? 'Email' : 'SMS'}
                  </label>
                ))}
              </div>
            </>
          )}
        </fieldset>
        {editable && <div><Button loading={busy} onClick={async () => { setBusy(true); await save({ lead_capture: lc }); setBusy(false) }}>Save lead capture</Button></div>}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ widget look

function WidgetTab({ bot, editable, save }: { bot: ChatBot; editable: boolean; save: SaveFn }) {
  const [a, setA] = useState<Appearance>(bot.appearance)
  const [p, setP] = useState<Proactive>(bot.proactive)
  const [domains, setDomains] = useState(bot.allowed_domains.join('\n'))
  const [busy, setBusy] = useState(false)
  const up = (x: Partial<Appearance>) => setA({ ...a, ...x })
  const check = (label: string, key: keyof Appearance, disabled = false) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" className="size-4" checked={!!a[key]} disabled={!editable || disabled} onChange={(e) => up({ [key]: e.target.checked } as Partial<Appearance>)} />
      {label}
    </label>
  )
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
      <Card>
        <CardContent className="grid gap-4 pt-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Brand colour" htmlFor="w-color">
              <div className="flex items-center gap-2">
                <input type="color" aria-label="Pick colour" value={a.color} disabled={!editable} onChange={(e) => up({ color: e.target.value })} className="h-9 w-12 rounded border" />
                <Input id="w-color" value={a.color} maxLength={7} disabled={!editable} onChange={(e) => up({ color: e.target.value })} />
              </div>
            </Field>
            <Field label="Position" htmlFor="w-pos">
              <Select id="w-pos" value={a.position} disabled={!editable} onChange={(e) => up({ position: e.target.value as Appearance['position'] })}>
                <option value="right">Bottom right</option>
                <option value="left">Bottom left</option>
              </Select>
            </Field>
            <Field label="Side offset (px)" htmlFor="w-ox"><Input id="w-ox" type="number" min={0} max={200} value={a.offset_x} disabled={!editable} onChange={(e) => up({ offset_x: Number(e.target.value) || 0 })} /></Field>
            <Field label="Bottom offset (px)" htmlFor="w-oy"><Input id="w-oy" type="number" min={0} max={300} value={a.offset_y} disabled={!editable} onChange={(e) => up({ offset_y: Number(e.target.value) || 0 })} /></Field>
            <Field label="Launcher icon" htmlFor="w-icon">
              <Select id="w-icon" value={a.launcher_icon} disabled={!editable} onChange={(e) => up({ launcher_icon: e.target.value as Appearance['launcher_icon'] })}>
                <option value="chat">Chat bubble</option>
                <option value="help">Question mark</option>
                <option value="sparkles">Sparkles</option>
                <option value="wave">Waving hand</option>
              </Select>
            </Field>
            <Field label="Launcher text (optional)" htmlFor="w-ltext"><Input id="w-ltext" maxLength={40} value={a.launcher_text} disabled={!editable} onChange={(e) => up({ launcher_text: e.target.value })} placeholder="Chat with us" /></Field>
            <Field label="Header title" htmlFor="w-title"><Input id="w-title" maxLength={60} value={a.title} disabled={!editable} onChange={(e) => up({ title: e.target.value })} /></Field>
            <Field label="Header subtitle" htmlFor="w-sub"><Input id="w-sub" maxLength={120} value={a.subtitle} disabled={!editable} onChange={(e) => up({ subtitle: e.target.value })} /></Field>
            <Field label="Theme" htmlFor="w-theme">
              <Select id="w-theme" value={a.theme} disabled={!editable} onChange={(e) => up({ theme: e.target.value as Appearance['theme'] })}>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="auto">Follow the visitor's device</option>
              </Select>
            </Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {check('Show on phones', 'show_on_mobile')}
            {check('Full screen on phones', 'mobile_fullscreen')}
            {check('Sound for new messages', 'sound')}
            {check(bot.branding_hidden ? '"Powered by Signalcraft" (hidden on Pro)' : 'Show "Powered by Signalcraft"', 'show_branding', bot.branding_hidden)}
          </div>
          <fieldset className="grid gap-3 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">Proactive greeting</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={p.enabled} disabled={!editable} onChange={(e) => setP({ ...p, enabled: e.target.checked })} />
              Pop up a message to visitors who haven't opened the chat
            </label>
            {p.enabled && (
              <>
                <Field label="Message" htmlFor="p-msg"><Input id="p-msg" maxLength={300} value={p.message} disabled={!editable} onChange={(e) => setP({ ...p, message: e.target.value })} /></Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="After (seconds)" htmlFor="p-delay"><Input id="p-delay" type="number" min={0} max={600} value={p.delay_seconds} disabled={!editable} onChange={(e) => setP({ ...p, delay_seconds: Number(e.target.value) || 0 })} /></Field>
                  <Field label="Only on these paths" htmlFor="p-paths" hint="One per line, e.g. /pricing or /blog/*. Empty = every page.">
                    <Textarea id="p-paths" rows={2} value={p.paths.join('\n')} disabled={!editable} onChange={(e) => setP({ ...p, paths: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20) })} />
                  </Field>
                </div>
              </>
            )}
          </fieldset>
          <Field label="Allowed websites" htmlFor="w-domains" hint="One domain per line (example.com also covers www.example.com; *.example.com covers subdomains). Empty = any website.">
            <Textarea id="w-domains" rows={3} value={domains} disabled={!editable} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" />
          </Field>
          {editable && (
            <div>
              <Button loading={busy} onClick={async () => { setBusy(true); await save({ appearance: a, proactive: p, allowed_domains: domains.split(/[\n,]/).map((d) => d.trim()).filter(Boolean) }); setBusy(false) }}>
                Save widget
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <WidgetPreview a={a} bot={bot} />
    </div>
  )
}

function WidgetPreview({ a, bot }: { a: Appearance; bot: ChatBot }) {
  const dark = a.theme === 'dark'
  return (
    <div aria-label="Widget preview" className="h-fit rounded-lg border bg-muted/40 p-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">Preview</p>
      <div className={cn('overflow-hidden rounded-xl border shadow-sm', dark ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-900')}>
        <div className="flex items-center gap-2 px-3 py-2 text-white" style={{ background: a.color }}>
          <span className="flex size-7 items-center justify-center rounded-full bg-white/20 text-xs font-bold">{(a.title || bot.name).charAt(0).toUpperCase()}</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{a.title || bot.name}</p>
            <p className="truncate text-[11px] opacity-90">{a.subtitle}</p>
          </div>
        </div>
        <div className="space-y-2 p-3 text-xs">
          <p className={cn('max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2', dark ? 'bg-slate-800' : 'bg-slate-100')}>{bot.welcome_message}</p>
          <p className="ml-auto max-w-[70%] rounded-2xl rounded-br-sm px-3 py-2 text-white" style={{ background: a.color }}>Hi! Do you deliver?</p>
        </div>
        {a.show_branding && !bot.branding_hidden && <p className="pb-2 text-center text-[10px] opacity-60">Powered by Signalcraft</p>}
      </div>
      <div className={cn('mt-3 flex', a.position === 'left' ? 'justify-start' : 'justify-end')}>
        <span className="flex h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold text-white shadow" style={{ background: a.color }}>
          <MessageSquareText className="size-5" /> {a.launcher_text}
        </span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ install

function InstallTab({ bot }: { bot: ChatBot }) {
  const [copied, setCopied] = useState(false)
  const preview = `/embed/chat-preview/${bot.public_key}`
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Add to your website</CardTitle>
          <CardDescription>Paste this once, just before <code>&lt;/body&gt;</code>, on every page (or in your site's footer / tag manager).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs" data-testid="snippet">{bot.snippet}</pre>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(bot.snippet)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                } catch {
                  toast.error('Copy failed; select the code and copy it')
                }
              }}
            >
              {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy code'}
            </Button>
            <Button variant="outline" asChild>
              <a href={preview} target="_blank" rel="noreferrer" data-testid="preview-link">
                <ExternalLink /> Open a test page
              </a>
            </Button>
          </div>
          {bot.status !== 'live' && <p className="text-xs text-warning-strong">This chatbot is a draft: publish it before it shows on your website.</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>JavaScript API (optional)</CardTitle>
          <CardDescription>Control the widget from your own code, after the script has loaded.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{`Signalcraft.chat.open()
Signalcraft.chat.close()
Signalcraft.chat.identify({ name: 'Asha', email: 'asha@example.com', phone: '+91…' })
Signalcraft.chat.setAttributes({ plan: 'gold', order_id: 'A123' })
Signalcraft.chat.on('lead', (lead) => console.log(lead))   // also 'open', 'close', 'message'`}</pre>
        </CardContent>
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ test & train

interface TestMsg {
  role: 'user' | 'assistant'
  content: string
  meta?: Omit<TestReply, 'reply'>
}

function TestChat({ bot, editable }: { bot: ChatBot; editable: boolean }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const status = useChatStatus(app!.id)
  const [msgs, setMsgs] = useState<TestMsg[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [improve, setImprove] = useState<{ question: string; answer: string } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [msgs, busy])
  async function send(t: string) {
    const content = t.trim()
    if (!content || busy) return
    const next: TestMsg[] = [...msgs, { role: 'user', content }]
    setMsgs(next)
    setText('')
    setBusy(true)
    try {
      const r = await chatApi(app!.id).test(bot.id, next.map(({ role, content }) => ({ role, content })))
      const { reply, ...meta } = r
      setMsgs([...next, { role: 'assistant', content: reply, meta }])
    } catch (e) {
      toast.error(errorMessage(e))
      setMsgs(msgs)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card className="flex h-[600px] min-w-0 flex-col lg:sticky lg:top-4" data-testid="test-chat">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 border-b pb-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /> Test &amp; train</CardTitle>
          <CardDescription>Chat as a visitor. Free; nothing is saved.</CardDescription>
        </div>
        <div className="flex items-center gap-1">
          {status.data && !status.data.configured && <Badge variant="warning" data-testid="simulated-badge">Simulated</Badge>}
          <Button size="icon" variant="ghost" aria-label="Restart test chat" onClick={() => setMsgs([])}><RotateCcw /></Button>
        </div>
      </CardHeader>
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4" role="log" aria-live="polite">
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm">{bot.welcome_message}</div>
        {!msgs.length && !!bot.quick_replies.length && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {bot.quick_replies.map((c) => (
              <button key={c} type="button" className="rounded-full border border-primary px-3 py-1 text-xs text-primary hover:bg-accent" onClick={() => send(c)}>{c}</button>
            ))}
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">{m.content}</div>
          ) : (
            <div key={i} className="space-y-1" data-testid="test-reply">
              <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm">{m.content}</div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {m.meta?.simulated && <Badge variant="outline">Simulated</Badge>}
                {m.meta?.unanswered && <Badge variant="warning">Didn't know</Badge>}
                {m.meta?.handoff && <Badge variant="secondary">Hands over to a person</Badge>}
                {m.meta?.collect_contact && <Badge variant="secondary">Shows the lead form</Badge>}
                {m.meta?.knowledge_mode === 'retrieval' && !!m.meta.retrieved.length && <Badge variant="outline">{m.meta.retrieved.length} passages used</Badge>}
                {editable && (
                  <button type="button" className="inline-flex items-center gap-1 font-medium text-primary hover:underline" onClick={() => setImprove({ question: m.meta?.question ?? msgs[i - 1]?.content ?? '', answer: '' })}>
                    <Wand2 className="size-3" /> Improve answer
                  </button>
                )}
              </div>
            </div>
          ),
        )}
        {busy && <div className="w-16 animate-pulse rounded-2xl bg-muted px-3 py-2 text-sm">…</div>}
      </div>
      <form className="flex gap-2 border-t p-3" onSubmit={(e) => { e.preventDefault(); send(text) }}>
        <Input value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder="Ask something a visitor would…" aria-label="Test message" data-testid="test-input" />
        <Button type="submit" size="icon" aria-label="Send" disabled={busy || !text.trim()}><Send /></Button>
      </form>
      {improve && (
        <ImproveDialog
          botId={bot.id}
          initial={improve}
          onClose={() => setImprove(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: cqk.sources(app!.id, bot.id) })
            qc.invalidateQueries({ queryKey: cqk.bot(app!.id, bot.id) })
          }}
        />
      )}
    </Card>
  )
}

export function ImproveDialog({ botId, initial, messageId, onClose, onSaved }: {
  botId: string
  initial: { question: string; answer: string }
  messageId?: string | null
  onClose: () => void
  onSaved?: () => void
}) {
  const { app } = useWorkspace()
  const [q, setQ] = useState(initial.question)
  const [a, setA] = useState(initial.answer)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Teach the right answer</DialogTitle>
          <DialogDescription>Saved as a FAQ, so the bot answers this question (and similar ones) correctly from now on.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Visitor's question" htmlFor="imp-q"><Input id="imp-q" value={q} maxLength={2000} onChange={(e) => setQ(e.target.value)} /></Field>
          <Field label="Correct answer" htmlFor="imp-a"><Textarea id="imp-a" rows={4} value={a} maxLength={10000} onChange={(e) => setA(e.target.value)} autoFocus /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            loading={busy}
            disabled={!q.trim() || !a.trim()}
            data-testid="save-improve"
            onClick={async () => {
              setBusy(true)
              try {
                await chatApi(app!.id).improve(botId, { question: q, answer: a, message_id: messageId ?? null })
                toast.success('Saved as a FAQ')
                onSaved?.()
                onClose()
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Save answer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
