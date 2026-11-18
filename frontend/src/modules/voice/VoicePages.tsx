/** Voice overview, campaigns, audio library and caller IDs. */
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AudioLines,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  Mic,
  MoreHorizontal,
  Pencil,
  Phone,
  PhoneCall,
  PhoneIncoming,
  Plus,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  TriangleAlert,
  Upload,
  UserMinus,
  XCircle,
} from 'lucide-react'
import { useAudio, useCallers, useVoiceCampaigns, useVoiceOptions, useVoiceOverview, voiceApi, vqk } from '@/api/voice'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Pagination, StatCard } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import { cn, formatDate, formatDateTime, timeAgo } from '@/lib/utils'
import type { CallerId, CallerKind, VoiceAudio, VoiceCampaignListItem, VoiceLanguage } from '@/types/voice'
import { CampaignStatusBadge, pct } from '../email/components'
import { formatMoney } from '../sms/format'
import { TtsForm } from './components'
import { CALLER_KIND_LABEL, CATEGORY_LABEL, formatDuration } from './format'
import { NewVoiceCampaignButton } from './VoiceCampaignEditorPage'

function useCrumbs(label: string) {
  const { app, org } = useWorkspace()
  return [{ label: org?.name ?? '' }, { label: app!.name, to: `/apps/${app!.id}` }, { label: 'Voice', to: `/apps/${app!.id}/voice` }, { label }]
}

const answerRate = (s: VoiceCampaignListItem['stats']) => {
  if (!s) return null
  const fin = s.answered + s.voicemail + s.no_answer + s.busy + s.failed
  return fin ? (100 * s.answered) / fin : null
}

// ------------------------------------------------------------------ overview

export function VoiceOverviewPage() {
  const { app, can } = useWorkspace()
  const q = useVoiceOverview(app!.id)
  const f = (n: number) => formatCount(n, app!.default_country)
  const base = `/apps/${app!.id}/voice`
  const spend = q.data ? Object.entries(q.data.last_30_days.spend) : []
  const noCaller = q.data && !q.data.callers.active
  return (
    <>
      <PageHeader breadcrumbs={useCrumbs('Overview')} title="Voice" description="Automated calls over the last 30 days, from provider call records." actions={can('campaigns.write') && <NewVoiceCampaignButton />} />
      {q.data && can('settings.write') && (noCaller || !q.data.audio_count) && (
        <div className="mb-6 rounded-lg border border-warning-border bg-warning-soft p-4 text-sm text-warning-strong" data-testid="voice-setup">
          <div className="mb-3 flex items-center gap-2 font-semibold">
            <TriangleAlert className="size-4" /> Finish voice setup before your first campaign
          </div>
          <ol className="grid gap-2 md:grid-cols-2">
            <li className="flex items-center gap-2">
              {noCaller ? <XCircle className="size-4" /> : <CheckCircle2 className="size-4 text-success-strong" />}
              <Link className="underline" to={`${base}/callers`}>
                Add and confirm a caller ID
              </Link>
            </li>
            <li className="flex items-center gap-2">
              {!q.data.audio_count ? <XCircle className="size-4" /> : <CheckCircle2 className="size-4 text-success-strong" />}
              <Link className="underline" to={`${base}/audio`}>
                Record or write a message
              </Link>
            </li>
          </ol>
        </div>
      )}
      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        q.data && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <StatCard label="People called" value={f(q.data.last_30_days.attempted)} icon={PhoneCall} hint={`${f(q.data.last_30_days.campaigns)} campaigns · ${f(q.data.last_30_days.attempts)} attempts`} />
              <StatCard label="Answer rate" value={pct(q.data.last_30_days.answer_rate)} icon={PhoneIncoming} tone="success" hint={`${f(q.data.last_30_days.answered)} answered`} />
              <StatCard label="Talk time" value={formatDuration(q.data.last_30_days.talk_seconds)} icon={Clock} hint={`${f(q.data.last_30_days.billable_minutes)} billable minutes`} />
              <StatCard label="Spend" value={spend.length ? spend.map(([cur, v]) => formatMoney(v, cur)).join(' + ') : '—'} icon={CircleDollarSign} hint="Minutes × per-minute price" />
              <StatCard label="Opt-outs" value={f(q.data.last_30_days.opted_out)} icon={UserMinus} hint="Pressed 9 during a call" />
            </div>
            <div className="grid gap-6 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>Recent campaigns</CardTitle>
                  <Button variant="link" size="sm" asChild>
                    <Link to={`${base}/campaigns`}>All campaigns</Link>
                  </Button>
                </CardHeader>
                {q.data.recent.length === 0 ? (
                  <EmptyState icon={PhoneCall} title="No voice campaigns yet" description="Pick a message, an audience and a caller ID, and the platform handles calling hours, retries and opt-outs." action={can('campaigns.write') && <NewVoiceCampaignButton variant="outline" />} />
                ) : (
                  <ul className="divide-y border-t">
                    {q.data.recent.map((c) => (
                      <li key={c.id}>
                        <Link to={c.status === 'draft' ? `${base}/campaigns/${c.id}/edit` : `${base}/campaigns/${c.id}`} className="flex items-center gap-4 px-5 py-3 transition hover:bg-muted/40">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{c.name}</div>
                            <div className="text-xs text-muted-foreground">{CATEGORY_LABEL[c.category]}</div>
                          </div>
                          {c.stats && c.stats.attempted > 0 && (
                            <div className="hidden text-right text-xs sm:block">
                              <div className="tabular-nums">{pct(answerRate(c.stats))} answered</div>
                              <div className="tabular-nums text-muted-foreground">{f(c.stats.attempted)} called</div>
                            </div>
                          )}
                          <CampaignStatusBadge status={c.status} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <CalendarClock className="size-4" /> Upcoming
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {q.data.upcoming.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Nothing scheduled.</p>
                    ) : (
                      <ul className="space-y-3">
                        {q.data.upcoming.map((c) => (
                          <li key={c.id}>
                            <Link className="text-sm font-medium hover:text-primary" to={`${base}/campaigns/${c.id}`}>
                              {c.name}
                            </Link>
                            <div className="text-xs text-muted-foreground">{c.scheduled_at && formatDateTime(c.scheduled_at)}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Calling rules</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm text-muted-foreground">
                    <p>🇮🇳 Promotional calls 09:00–21:00 from 140-series numbers; service calls from 160-series.</p>
                    <p>🇺🇸 Marketing calls 08:00–21:00 local time, with identification and a press-9 opt-out (TCPA).</p>
                    <div className="grid gap-2 pt-2">
                      <Button variant="outline" className="justify-start" asChild>
                        <Link to={`${base}/audio`}>
                          <AudioLines /> Audio library ({q.data.audio_count})
                        </Link>
                      </Button>
                      <Button variant="outline" className="justify-start" asChild>
                        <Link to={`${base}/callers`}>
                          <Phone /> Caller IDs ({q.data.callers.active ?? 0} approved)
                        </Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        )
      )}
    </>
  )
}

// ------------------------------------------------------------------ campaigns

const TABS = [
  ['', 'All'],
  ['draft', 'Drafts'],
  ['scheduled', 'Scheduled'],
  ['sending', 'Calling'],
  ['completed', 'Finished'],
] as const

export function VoiceCampaignsPage() {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  const [del, setDel] = useState<VoiceCampaignListItem | null>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])
  const q = useVoiceCampaigns(appId, { page, page_size: 20, status: status || undefined, search: debounced || undefined })
  const f = (n: number) => formatCount(n, app!.default_country)
  const base = `/apps/${appId}/voice/campaigns`
  const open = (c: VoiceCampaignListItem) => navigate(c.status === 'draft' ? `${base}/${c.id}/edit` : `${base}/${c.id}`)
  return (
    <>
      <PageHeader breadcrumbs={useCrumbs('Campaigns')} title="Voice campaigns" description="Drafts, scheduled calling and results." actions={can('campaigns.write') && <NewVoiceCampaignButton />} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="flex gap-1">
            {TABS.map(([k, label]) => (
              <button key={k} onClick={() => { setStatus(k); setPage(1) }} className={cn('rounded-full px-3 py-1.5 text-xs font-medium transition', status === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                {label}
              </button>
            ))}
          </div>
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search campaigns" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search campaigns" data-page-search />
          </div>
        </div>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState icon={PhoneCall} title={debounced || status ? 'No campaigns match' : 'No voice campaigns yet'} description="Campaigns you create appear here with their results." action={can('campaigns.write') && !debounced && !status && <NewVoiceCampaignButton variant="outline" />} />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Campaign</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Recipients</TH>
                  <TH className="text-right">Answered</TH>
                  <TH className="text-right">Cost</TH>
                  <TH>Date</TH>
                  <TH className="w-10" />
                </TR>
              </THead>
              <TBody>
                {q.data.items.map((c) => (
                  <TR key={c.id} className="cursor-pointer" onClick={() => open(c)}>
                    <TD>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{CATEGORY_LABEL[c.category]}</div>
                    </TD>
                    <TD>
                      <CampaignStatusBadge status={c.status} />
                    </TD>
                    <TD className="text-right tabular-nums">{c.recipient_count ? f(c.recipient_count) : '—'}</TD>
                    <TD className="text-right tabular-nums">{pct(answerRate(c.stats))}</TD>
                    <TD className="text-right tabular-nums">{c.stats && c.stats.attempts ? formatMoney(c.stats.cost, c.currency) : '—'}</TD>
                    <TD className="whitespace-nowrap text-xs text-muted-foreground">
                      {c.launched_at ? formatDate(c.launched_at) : c.scheduled_at ? `Scheduled ${formatDateTime(c.scheduled_at)}` : `Edited ${timeAgo(c.updated_at)}`}
                    </TD>
                    <TD onClick={(e) => e.stopPropagation()}>
                      {can('campaigns.write') && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`Actions for ${c.name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => open(c)}>{c.status === 'draft' ? 'Edit' : 'View report'}</DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={async () => {
                                try {
                                  const d = await voiceApi(appId).duplicateCampaign(c.id)
                                  navigate(`${base}/${d.id}/edit`)
                                } catch (e) {
                                  toast.error(errorMessage(e))
                                }
                              }}
                            >
                              Duplicate
                            </DropdownMenuItem>
                            {c.status === 'draft' && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="text-destructive" onSelect={() => setDel(c)}>
                                  Delete
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={20} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete “${del?.name}”?`}
        description="The draft is removed permanently."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          try {
            await voiceApi(appId).deleteCampaign(del!.id)
            await qc.invalidateQueries({ queryKey: vqk.all(appId) })
            toast.success('Draft deleted')
          } catch (e) {
            toast.error(errorMessage(e))
          } finally {
            setDel(null)
          }
        }}
      />
    </>
  )
}

// ------------------------------------------------------------------ audio library

export function VoiceAudioPage() {
  const { app, can } = useWorkspace()
  const q = useAudio(app!.id)
  const options = useVoiceOptions(app!.id)
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [edit, setEdit] = useState<{ id: string | null; name: string; tts_text: string; tts_language: VoiceLanguage; tts_voice: 'female' | 'male' } | null>(null)
  const [rename, setRename] = useState<VoiceAudio | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [del, setDel] = useState<VoiceAudio | null>(null)
  const [busy, setBusy] = useState(false)
  const write = can('campaigns.write')
  const lang: VoiceLanguage = app!.default_country === 'US' ? 'en-US' : 'en-IN'
  const refresh = () => qc.invalidateQueries({ queryKey: vqk.all(app!.id) })
  return (
    <>
      <PageHeader
        breadcrumbs={useCrumbs('Audio library')}
        title="Audio library"
        description="Recordings and text-to-speech messages for your calls."
        actions={
          write && (
            <>
              <Button variant="outline" loading={uploading} onClick={() => fileRef.current?.click()}>
                <Upload /> Upload recording
              </Button>
              <Button onClick={() => setEdit({ id: null, name: '', tts_text: '', tts_language: lang, tts_voice: 'female' })}>
                <Plus /> Text to speech
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="audio/mpeg,audio/wav,.mp3,.wav"
                className="hidden"
                data-testid="audio-file"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  setUploading(true)
                  try {
                    await voiceApi(app!.id).uploadAudio(file, file.name.replace(/\.[^.]+$/, ''))
                    await refresh()
                    toast.success('Recording uploaded')
                  } catch (err) {
                    toast.error(errorMessage(err))
                  } finally {
                    setUploading(false)
                  }
                }}
              />
            </>
          )
        }
      />
      {q.isLoading ? (
        <LoadingRows />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.length ? (
        <Card>
          <EmptyState icon={Mic} title="No messages yet" description={`Upload an MP3 or WAV up to ${Math.round((options.data?.max_bytes ?? 5242880) / 1048576)} MB and ${options.data?.max_seconds ?? 120} seconds, or type a message for the phone network to read aloud.`} />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {q.data.map((a) => (
            <Card key={a.id} className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">{a.name}</CardTitle>
                    <CardDescription>
                      {a.kind === 'tts' ? `Text to speech · ${options.data?.languages[a.tts_language!] ?? a.tts_language} · ${a.tts_voice}` : `Recording · ${a.content_type === 'audio/wav' ? 'WAV' : 'MP3'}`} · {formatDuration(a.duration_seconds)}
                    </CardDescription>
                  </div>
                  <Badge variant="secondary">{a.kind === 'tts' ? 'TTS' : 'Audio'}</Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3">
                {a.kind === 'tts' ? <p className="line-clamp-4 flex-1 rounded-lg bg-muted/50 p-3 text-sm">{a.tts_text}</p> : <audio controls preload="none" src={a.url ?? undefined} className="w-full" />}
                {write && (
                  <div className="flex justify-end gap-1">
                    <NewVoiceCampaignButton variant="outline" label="Use" audioId={a.id} name={a.name} />
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Edit ${a.name}`}
                      onClick={() => {
                        if (a.kind === 'tts') setEdit({ id: a.id, name: a.name, tts_text: a.tts_text ?? '', tts_language: a.tts_language ?? lang, tts_voice: a.tts_voice ?? 'female' })
                        else {
                          setRename(a)
                          setRenameTo(a.name)
                        }
                      }}
                    >
                      <Pencil />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label={`Delete ${a.name}`} onClick={() => setDel(a)}>
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{edit?.id ? 'Edit message' : 'New text-to-speech message'}</DialogTitle>
            <DialogDescription>Read aloud by the phone network. Personalisation fields are filled in for each person.</DialogDescription>
          </DialogHeader>
          {edit && <TtsForm appId={app!.id} languages={options.data?.languages} value={edit} onChange={(v) => setEdit({ ...edit, ...v })} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={!edit?.name.trim() || !edit?.tts_text.trim()}
              onClick={async () => {
                setBusy(true)
                try {
                  const { id, ...body } = edit!
                  if (id) await voiceApi(app!.id).updateAudio(id, body)
                  else await voiceApi(app!.id).createTts(body)
                  await refresh()
                  setEdit(null)
                  toast.success('Message saved')
                } catch (e) {
                  toast.error(errorMessage(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Save message
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!rename} onOpenChange={(o) => !o && setRename(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename recording</DialogTitle>
          </DialogHeader>
          <Field label="Name" htmlFor="rn">
            <Input id="rn" value={renameTo} onChange={(e) => setRenameTo(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRename(null)}>
              Cancel
            </Button>
            <Button
              disabled={!renameTo.trim()}
              onClick={async () => {
                try {
                  await voiceApi(app!.id).updateAudio(rename!.id, { name: renameTo })
                  await refresh()
                  setRename(null)
                } catch (e) {
                  toast.error(errorMessage(e))
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Delete “${del?.name}”?`}
        description="Finished campaigns keep their results. Campaigns that are scheduled or calling block deletion."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          try {
            await voiceApi(app!.id).deleteAudio(del!.id)
            await refresh()
            toast.success('Message deleted')
          } catch (e) {
            toast.error(errorMessage(e))
          } finally {
            setDel(null)
          }
        }}
      />
    </>
  )
}

// ------------------------------------------------------------------ caller IDs

const KINDS: Record<'IN' | 'US', CallerKind[]> = { IN: ['series_140', 'series_160'], US: ['local', 'toll_free'] }
const PLACEHOLDER: Record<CallerKind, string> = { series_140: '+911401234567', series_160: '+911601234567', local: '+14155550100', toll_free: '+18885550100' }

function AddCallerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { app } = useWorkspace()
  const qc = useQueryClient()
  const first: 'IN' | 'US' = app!.default_country === 'US' ? 'US' : 'IN'
  const [country, setCountry] = useState<'IN' | 'US'>(first)
  const [kind, setKind] = useState<CallerKind>(KINDS[first][0]!)
  const [number, setNumber] = useState('')
  const [label, setLabel] = useState('')
  const [provider, setProvider] = useState<'simulation' | 'telnyx' | 'exotel' | 'twilio'>('simulation')
  const telnyx = useQuery({ queryKey: ['voice', app!.id, 'telnyx-numbers'], queryFn: () => voiceApi(app!.id).providerNumbers(), enabled: open, staleTime: 60_000, retry: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setNumber('')
      setLabel('')
      setError(null)
    }
  }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a caller ID</DialogTitle>
          <DialogDescription>A number your business owns and has registered. You confirm it on the next step.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Country">
            {(['IN', 'US'] as const).map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={country === c}
                onClick={() => {
                  setCountry(c)
                  setKind(KINDS[c][0]!)
                  setProvider('simulation')
                }}
                className={cn('rounded-lg border px-3 py-2.5 text-sm font-medium transition', country === c ? 'border-primary bg-accent/50' : 'text-muted-foreground hover:bg-muted')}
              >
                {c === 'IN' ? '🇮🇳 India' : '🇺🇸 United States'}
              </button>
            ))}
          </div>
          <Field label="Number type" htmlFor="cl-kind">
            <Select id="cl-kind" value={kind} onChange={(e) => setKind(e.target.value as CallerKind)}>
              {KINDS[country].map((k) => (
                <option key={k} value={k}>
                  {CALLER_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          {telnyx.data?.configured && !!telnyx.data.numbers.length && (
            <Field label="Numbers on your Telnyx account" htmlFor="cl-tx" hint="Picking one fills in the number and sets Telnyx as the provider.">
              <Select
                id="cl-tx"
                value=""
                onChange={(e) => {
                  if (!e.target.value) return
                  setNumber(e.target.value)
                  setProvider('telnyx')
                }}
              >
                <option value="">Choose a number…</option>
                {telnyx.data.numbers.map((n) => (
                  <option key={n.number} value={n.number}>
                    {n.number}
                    {n.label ? ` · ${n.label}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Number" htmlFor="cl-num" error={error ?? undefined} hint="International format with the country code.">
            <Input id="cl-num" value={number} onChange={(e) => setNumber(e.target.value)} placeholder={PLACEHOLDER[kind]} className="font-mono" />
          </Field>
          <Field label="Label (optional)" htmlFor="cl-label">
            <Input id="cl-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Head office" />
          </Field>
          <Field label="Provider" htmlFor="cl-prov" hint="Simulation never dials anyone. Live providers are used only after the platform is switched to live mode.">
            <Select id="cl-prov" value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
              <option value="simulation">Simulation</option>
              <option value="telnyx">Telnyx</option>
              {country === 'IN' && <option value="exotel">Exotel</option>}
              <option value="twilio">Twilio</option>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!number.trim()}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await voiceApi(app!.id).createCaller({ number, country, kind, provider, label: label || null })
                await qc.invalidateQueries({ queryKey: vqk.all(app!.id) })
                toast.success('Caller ID added. Confirm it to start using it.')
                onOpenChange(false)
              } catch (e) {
                setError(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            Add caller ID
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function VoiceCallersPage() {
  const { app, can } = useWorkspace()
  const q = useCallers(app!.id)
  const qc = useQueryClient()
  const [add, setAdd] = useState(false)
  const [attest, setAttest] = useState<CallerId | null>(null)
  const [del, setDel] = useState<CallerId | null>(null)
  const [busy, setBusy] = useState(false)
  const write = can('settings.write')
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try {
      await fn()
      await qc.invalidateQueries({ queryKey: vqk.all(app!.id) })
      toast.success(msg)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
      setAttest(null)
      setDel(null)
    }
  }
  return (
    <>
      <PageHeader breadcrumbs={useCrumbs('Caller IDs')} title="Caller IDs" description="Numbers your calls come from: 140 and 160-series numbers in India, local or toll-free numbers in the US." actions={write && <Button onClick={() => setAdd(true)}><Plus /> Add caller ID</Button>} />
      <Card>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.length ? (
          <EmptyState icon={Phone} title="No caller IDs yet" description="Add the number people will see when you call them." action={write && <Button variant="outline" onClick={() => setAdd(true)}>Add caller ID</Button>} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Number</TH>
                <TH>Type</TH>
                <TH>Provider</TH>
                <TH>Status</TH>
                <TH className="w-10" />
              </TR>
            </THead>
            <TBody>
              {q.data.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold">{c.number}</span>
                      {c.is_default && (
                        <Badge variant="secondary">
                          <Star className="size-3" /> Default
                        </Badge>
                      )}
                    </div>
                    {c.label && <div className="text-xs text-muted-foreground">{c.label}</div>}
                  </TD>
                  <TD className="text-sm text-muted-foreground">
                    {c.country} · {CALLER_KIND_LABEL[c.kind]}
                  </TD>
                  <TD className="text-sm capitalize">{c.provider}</TD>
                  <TD>
                    {c.status === 'active' ? (
                      <Badge variant="success">Approved {c.attested_at && `· ${formatDate(c.attested_at)}`}</Badge>
                    ) : write ? (
                      <Button size="sm" variant="outline" onClick={() => setAttest(c)}>
                        <ShieldCheck /> Confirm ownership
                      </Button>
                    ) : (
                      <Badge variant="warning">Not confirmed</Badge>
                    )}
                  </TD>
                  <TD>
                    {write && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${c.number}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {!c.is_default && <DropdownMenuItem onSelect={() => act(() => voiceApi(app!.id).defaultCaller(c.id), `${c.number} is now the default`)}>Make default</DropdownMenuItem>}
                          <DropdownMenuItem className="text-destructive" onSelect={() => setDel(c)}>
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <AddCallerDialog open={add} onOpenChange={setAdd} />
      <ConfirmDialog
        open={!!attest}
        onOpenChange={(o) => !o && setAttest(null)}
        title={`Confirm ${attest?.number} is yours?`}
        description={
          attest?.country === 'IN'
            ? 'You confirm this number was allotted to your business in the correct TRAI series and is registered under your DLT entity. Your name and the time are recorded.'
            : 'You confirm your business owns this number and it is provisioned with your provider (STIR/SHAKEN). Your name and the time are recorded.'
        }
        confirmLabel="I confirm"
        loading={busy}
        onConfirm={() => act(() => voiceApi(app!.id).attestCaller(attest!.id), 'Caller ID approved')}
      />
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Remove ${del?.number}?`}
        description="Draft campaigns using it will need a new caller ID."
        confirmLabel="Remove"
        destructive
        loading={busy}
        onConfirm={() => act(() => voiceApi(app!.id).deleteCaller(del!.id), 'Caller ID removed')}
      />
    </>
  )
}
