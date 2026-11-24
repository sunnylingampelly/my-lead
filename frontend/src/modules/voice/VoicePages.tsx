/** Voice overview, campaigns and the audio library. AI agents have their own pages; Signalcraft picks caller numbers automatically. */
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AudioLines,
  Bot,
  CalendarClock,
  CircleDollarSign,
  Clock,
  Mic,
  MoreHorizontal,
  Pencil,
  PhoneCall,
  PhoneIncoming,
  Plus,
  Search,
  Trash2,
  Upload,
  UserMinus,
} from 'lucide-react'
import { useAudio, useVoiceCampaigns, useVoiceOptions, useVoiceOverview, voiceApi, vqk } from '@/api/voice'
import { errorMessage } from '@/api/client'
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input } from '@/components/ui/form-controls'
import { Badge, Skeleton } from '@/components/ui/misc'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Pagination, StatCard } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatCount } from '@/lib/regions'
import { cn, formatDate, formatDateTime, timeAgo } from '@/lib/utils'
import type { VoiceAudio, VoiceCampaignListItem, VoiceLanguage } from '@/types/voice'
import { CampaignStatusBadge, pct } from '../email/components'
import { formatMoney } from '../sms/format'
import { TtsForm } from './components'
import { CATEGORY_LABEL, formatDuration } from './format'
import { NewVoiceCampaignButton } from './VoiceCampaignEditorPage'
import { SetupChecklist } from '../email/campaignKit'

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
  return (
    <>
      <PageHeader breadcrumbs={useCrumbs('Overview')} title="Voice" description="Automated calls over the last 30 days, from provider call records." actions={can('campaigns.write') && <NewVoiceCampaignButton />} />
      {q.data && (
        <SetupChecklist
          testId="voice-setup"
          title="Finish voice setup before your first campaign"
          items={[
            ...(q.data.setup.default_country !== 'US'
              ? [{ key: 'dlt', label: 'DLT registration (shared by SMS and voice)', done: q.data.setup.dlt_registered, to: `${base}/registration`, term: 'pe_id' }]
              : []),
            {
              key: 'message',
              label: 'Record a message, write one, or create an AI agent',
              done: !!q.data.audio_count || !!(q.data.agents && Object.keys(q.data.agents).length),
              to: q.data.audio_count ? `${base}/audio` : `${base}/agents`,
            },
            {
              key: 'consent',
              label: q.data.setup.default_country === 'US' ? 'Contacts with call consent (TCPA)' : 'Contacts with call consent',
              done: q.data.setup.consented > 0,
              to: `/apps/${app!.id}/audience/import`,
              term: q.data.setup.default_country === 'US' ? 'tcpa' : 'consent',
            },
          ]}
        />
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
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                  <CardTitle>Recent campaigns</CardTitle>
                  <Button variant="link" size="sm" asChild>
                    <Link to={`${base}/campaigns`}>All campaigns</Link>
                  </Button>
                </CardHeader>
                {q.data.recent.length === 0 ? (
                  <EmptyState icon={PhoneCall} title="No voice campaigns yet" description="Pick a phone number, a message or an AI agent and an audience, and the platform handles calling hours, retries and opt-outs." action={can('campaigns.write') && <NewVoiceCampaignButton variant="outline" />} />
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
                        <Link to={`${base}/agents`}>
                          <Bot /> AI agents ({q.data.agents?.active ?? 0} active)
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
