import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import * as D from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUp, History, Loader2, MessageSquarePlus, Sparkles, Square, Wrench, X } from 'lucide-react'
import { aiApi, aiqk, streamAssistant, useAiStatus, useConversations } from '@/api/ai'
import { ApiError, errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Badge, Kbd } from '@/components/ui/misc'
import { Tooltip } from '@/components/ui/tooltip'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { cn } from '@/lib/utils'
import type { ActionCard as Card, AiUsage, AssistantMessage } from '@/types/ai'
import { ActionCard, LinkButtons } from './ActionCard'
import { OPEN_ASSISTANT_EVENT } from './lib'
import { formatMoney } from '../sms/format'
import { Markdown } from './Markdown'
import { EXAMPLES, pageContext, suggestionsFor } from './suggestions'

interface Item {
  id: string
  role: 'user' | 'assistant'
  content: string
  links: AssistantMessage['links']
  tools: { name: string; label?: string; ok: boolean }[]
  cards: Card[]
  simulated: boolean
  streaming?: boolean
  error?: string
  limit?: boolean
  noCredit?: boolean
  charge?: AssistantMessage['charge']
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

function fromDetail(messages: AssistantMessage[], actions: Card[]): Item[] {
  const items: Item[] = messages.map((m) => ({ id: m.id, role: m.role, content: m.content, links: m.links, tools: m.tools, cards: [], simulated: m.simulated, charge: m.charge }))
  for (const a of actions) {
    const host = items.find((it, i) => it.role === 'assistant' && messages[i]!.created_at >= a.created_at)
    if (host) host.cards.push(a)
  }
  return items
}

function UsageMeter({ usage }: { usage: AiUsage | undefined }) {
  const m = usage?.assistant_messages
  if (!m || m.limit == null) return null
  const near = m.used >= m.limit * 0.8
  return (
    <Tooltip content={`Fair-use limit on your plan: ${m.limit} assistant messages a day (resets at midnight UTC).`}>
      <span className={cn('text-[11px] tabular-nums', near ? 'font-medium text-warning-strong' : 'text-muted-foreground')} data-testid="ai-usage">
        {m.used}/{m.limit} today
      </span>
    </Tooltip>
  )
}

export function AssistantPanel() {
  const { app, org } = useWorkspace()
  const { user } = useAuth()
  const can = !!app?.permissions.includes('ai.use')
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Item[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<AiUsage | undefined>()
  const abort = useRef<AbortController | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const location = useLocation()
  const qc = useQueryClient()
  const status = useAiStatus(app?.id, can && open)
  const history = useConversations(app?.id ?? '', can && open)
  const simulated = status.data?.simulated ?? false
  const appId = app?.id

  useEffect(() => {
    if (status.data) setUsage(status.data.usage)
  }, [status.data])

  // Remember where focus was so closing the panel puts it back (keyboard users don't lose their place).
  const show = useCallback(() => {
    setOpen((o) => {
      if (!o) returnFocus.current = document.activeElement as HTMLElement | null
      return true
    })
  }, [])

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (!text || !appId || busy) return
      setInput('')
      setBusy(true)
      const uid = `u-${Date.now()}`
      const aid = `a-${Date.now()}`
      setItems((xs) => [...xs, { id: uid, role: 'user', content: text, links: [], tools: [], cards: [], simulated: false }, { id: aid, role: 'assistant', content: '', links: [], tools: [], cards: [], simulated, streaming: true }])
      const patch = (f: (it: Item) => Item) => setItems((xs) => xs.map((it) => (it.id === aid ? f(it) : it)))
      const ctrl = new AbortController()
      abort.current = ctrl
      try {
        await streamAssistant(
          appId,
          { text, conversation_id: conversationId, page: pageContext(location.pathname, document.title) },
          (e) => {
            if (e.event === 'conversation') setConversationId(e.data.id)
            else if (e.event === 'meta') patch((it) => ({ ...it, simulated: e.data.simulated }))
            else if (e.event === 'delta') patch((it) => ({ ...it, content: it.content + e.data.text }))
            else if (e.event === 'tool') patch((it) => ({ ...it, tools: [...it.tools, { name: e.data.name, label: e.data.label, ok: e.data.ok }] }))
            else if (e.event === 'action') patch((it) => ({ ...it, cards: [...it.cards, e.data] }))
            else if (e.event === 'done') {
              patch((it) => ({ ...it, id: e.data.message.id, content: e.data.message.content, links: e.data.message.links, charge: e.data.message.charge, streaming: false }))
              setUsage(e.data.usage)
            } else if (e.event === 'error') patch((it) => ({ ...it, streaming: false, error: e.data.message }))
          },
          ctrl.signal,
        )
      } catch (err) {
        if ((err as Error).name === 'AbortError') patch((it) => ({ ...it, streaming: false, content: it.content || '_Stopped._' }))
        else
          patch((it) => ({
            ...it,
            streaming: false,
            error: errorMessage(err),
            limit: err instanceof ApiError && err.code === 'AI_DAILY_LIMIT',
            noCredit: err instanceof ApiError && err.code === 'INSUFFICIENT_BALANCE',
          }))
      } finally {
        patch((it) => ({ ...it, streaming: false }))
        setBusy(false)
        abort.current = null
        qc.invalidateQueries({ queryKey: aiqk.conversations(appId) })
        setTimeout(() => inputRef.current?.focus(), 0)
      }
    },
    [appId, busy, conversationId, location.pathname, qc, simulated],
  )

  // Ctrl/Cmd+J anywhere, and "open" requests from the sidebar or command palette.
  useEffect(() => {
    if (!can) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setOpen((o) => {
          if (!o) returnFocus.current = document.activeElement as HTMLElement | null
          return !o
        })
      }
    }
    const onOpen = (e: Event) => {
      show()
      const prompt = (e as CustomEvent<{ prompt?: string }>).detail?.prompt
      if (prompt) setTimeout(() => void send(prompt), 50)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_ASSISTANT_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_ASSISTANT_EVENT, onOpen)
    }
  }, [can, send, show])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [items])

  const newChat = () => {
    abort.current?.abort()
    setItems([])
    setConversationId(null)
    inputRef.current?.focus()
  }

  const loadConversation = async (id: string) => {
    if (!appId) return
    try {
      const d = await aiApi(appId).conversation(id)
      setConversationId(d.id)
      setItems(fromDetail(d.messages, d.actions))
    } catch (e) {
      setItems([{ id: 'err', role: 'assistant', content: '', links: [], tools: [], cards: [], simulated: false, error: errorMessage(e) }])
    }
  }

  if (!app || !can) return null
  const close = () => setOpen(false)
  const suggestions = suggestionsFor(location.pathname)
  const decide = (card: Card) => (approve: boolean, args?: Record<string, unknown>) =>
    approve ? aiApi(app.id).confirm(card.id, args) : aiApi(app.id).cancel(card.id)

  return (
    <>
      {!open && (
        <Tooltip content="AI Assistant" shortcut={isMac ? '⌘ J' : 'Ctrl J'} side="left">
          <button
            type="button"
            onClick={show}
            className="fixed bottom-5 right-5 z-40 flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-pop transition hover:scale-105 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40 print:hidden"
            aria-label="Open AI Assistant"
            data-testid="ai-fab"
          >
            <Sparkles className="size-5" />
          </button>
        </Tooltip>
      )}
      <D.Root open={open} onOpenChange={setOpen} modal={false}>
        <D.Portal>
          <D.Content
            onInteractOutside={(e) => e.preventDefault()}
            onOpenAutoFocus={(e) => {
              e.preventDefault()
              inputRef.current?.focus()
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault()
              const el = returnFocus.current
              returnFocus.current = null
              if (el && document.contains(el)) el.focus()
            }}
            className={cn(
              'fixed inset-0 z-50 flex flex-col bg-card shadow-pop sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[440px] sm:border-l',
              'data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:duration-200',
            )}
            data-testid="ai-panel"
          >
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
                <Sparkles className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <D.Title className="flex items-center gap-2 text-sm font-semibold">
                  AI Assistant
                  {simulated && (
                    <Badge variant="warning" className="text-[10px]" data-testid="ai-simulated">
                      Simulated
                    </Badge>
                  )}
                </D.Title>
                <D.Description className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="truncate">Asks before changing anything</span>
                  <UsageMeter usage={usage} />
                </D.Description>
              </div>
              <DropdownMenu>
                <Tooltip content="Chat history">
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Chat history">
                      <History />
                    </Button>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
                  <DropdownMenuLabel>Recent chats</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {history.data?.length ? (
                    history.data.map((c) => (
                      <DropdownMenuItem key={c.id} onSelect={() => void loadConversation(c.id)} className={cn(c.id === conversationId && 'bg-muted')}>
                        <span className="truncate">{c.title}</span>
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <div className="px-2 py-3 text-xs text-muted-foreground">No chats yet</div>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip content="New chat">
                <Button variant="ghost" size="icon" onClick={newChat} aria-label="New chat" data-testid="ai-new-chat">
                  <MessageSquarePlus />
                </Button>
              </Tooltip>
              <D.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close assistant">
                  <X />
                </Button>
              </D.Close>
            </div>

            <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite" aria-busy={busy} aria-relevant="additions text">
              {items.length === 0 ? (
                <div className="space-y-5 pt-2" data-testid="ai-empty">
                  <div>
                    <p className="text-base font-semibold">Hi {user?.full_name.split(' ')[0] || 'there'}, how can I help?</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      I can answer questions about your contacts, campaigns, deals, forms and chats, and prepare changes for you to confirm. I never send, delete or spend on my own.
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground" data-testid="ai-price-hint">
                      {simulated
                        ? 'Simulation mode: answers are scripted and free.'
                        : status.data?.pricing
                          ? `Pay per use from your wallet: ≈ ${formatMoney(status.data.pricing.ai_assistant_message_typical, status.data.pricing.currency)} per simple question. The charge is shown under each reply.`
                          : null}
                    </p>
                  </div>
                  {EXAMPLES.map((g) => (
                    <div key={g.title}>
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {g.prompts.map((p) => (
                          <button key={p} type="button" onClick={() => void send(p)} className="rounded-full border bg-background px-3 py-1 text-left text-xs transition hover:border-primary/50 hover:bg-accent">
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                items.map((it) =>
                  it.role === 'user' ? (
                    <div key={it.id} className="flex justify-end">
                      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">{it.content}</div>
                    </div>
                  ) : (
                    <div key={it.id} className="space-y-2" data-testid="ai-message">
                      {it.tools.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {it.tools.map((t, i) => (
                            <span key={i} className={cn('inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground', !t.ok && 'text-destructive')}>
                              <Wrench className="size-3" /> {t.label ?? t.name}
                            </span>
                          ))}
                        </div>
                      )}
                      {it.content ? (
                        <Markdown text={it.content} onNavigate={() => window.innerWidth < 640 && close()} />
                      ) : it.streaming ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="size-4 animate-spin" /> Thinking…
                        </div>
                      ) : null}
                      {it.cards.map((c) => (
                        <ActionCard key={c.id} card={c} onDecide={decide(c)} onNavigate={() => window.innerWidth < 640 && close()} />
                      ))}
                      {!it.streaming && it.links.length > 0 && <LinkButtons links={it.links} onNavigate={() => window.innerWidth < 640 && close()} />}
                      {it.error && (
                        <div role="alert" className={cn('rounded-lg border px-3 py-2 text-sm', it.limit || it.noCredit ? 'border-warning-border bg-warning-soft text-warning-strong' : 'border-danger-border bg-danger-soft text-danger-strong')}>
                          {it.error}
                          {it.noCredit && org?.permissions.includes('billing.read') && (
                            <Link to={`/orgs/${org.id}/billing?topup=1`} className="ml-1 font-medium underline" onClick={close} data-testid="ai-add-credit">
                              Add credit
                            </Link>
                          )}
                          {it.limit && org?.permissions.includes('billing.read') && (
                            <Link to={`/orgs/${org.id}/billing#plan`} className="ml-1 font-medium underline" onClick={close}>
                              See plans
                            </Link>
                          )}
                        </div>
                      )}
                      {!it.streaming && !it.error && (it.simulated || it.charge) && (
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground" data-testid="ai-charge">
                          {it.simulated ? 'Simulated, no charge' : `${formatMoney(it.charge!.amount, it.charge!.currency)} from your wallet`}
                        </div>
                      )}
                    </div>
                  ),
                )
              )}
            </div>

            <div className="border-t px-3 pb-3 pt-2">
              {!busy && (
                <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5" aria-label="Suggested questions">
                  {suggestions.map((p) => (
                    <button key={p} type="button" onClick={() => void send(p)} className="shrink-0 rounded-full border bg-background px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-primary/50 hover:text-foreground" data-testid="ai-suggestion">
                      {p}
                    </button>
                  ))}
                </div>
              )}
              <form
                className="flex items-end gap-2 rounded-xl border bg-background p-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/30"
                onSubmit={(e) => {
                  e.preventDefault()
                  void send(input)
                }}
              >
                <label htmlFor="ai-input" className="sr-only">
                  Ask the AI Assistant
                </label>
                <textarea
                  id="ai-input"
                  ref={inputRef}
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void send(input)
                    }
                  }}
                  maxLength={4000}
                  placeholder="Ask anything, or ask me to do something…"
                  className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground"
                  data-testid="ai-input"
                />
                {busy ? (
                  <Button type="button" size="icon" variant="outline" onClick={() => abort.current?.abort()} aria-label="Stop">
                    <Square className="size-3.5" />
                  </Button>
                ) : (
                  <Button type="submit" size="icon" disabled={!input.trim()} aria-label="Send" data-testid="ai-send">
                    <ArrowUp />
                  </Button>
                )}
              </form>
              <p className="mt-1.5 hidden text-center text-[10px] text-muted-foreground sm:block">
                <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd> <Kbd>J</Kbd> to toggle · AI can make mistakes: check the details before confirming.
              </p>
            </div>
          </D.Content>
        </D.Portal>
      </D.Root>
    </>
  )
}
