import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, ExternalLink, FlaskConical, Hash, Unplug } from 'lucide-react'
import { SlackLogo as Slack } from '@/components/SlackLogo'
import { aiApi, aiqk, useSlackChannels, useSlackStatus } from '@/api/ai'
import { errorMessage } from '@/api/client'
import { ErrorState, LoadingRows, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/misc'
import { useWorkspace } from '@/hooks/useWorkspace'

const RESULT: Record<string, [string, 'success' | 'error']> = {
  connected: ['Slack is connected', 'success'],
  cancelled: ['Slack wasn’t connected: the install was cancelled', 'error'],
  error: ['Slack couldn’t be connected. Please try again.', 'error'],
  forbidden: ['You need permission to manage AI integrations', 'error'],
  invalid_state: ['That Slack link expired. Please try again.', 'error'],
}

function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{value}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(value)
            toast.success('Copied')
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  )
}

/** Slack: one workspace per organization. Agents post reports and approval requests; teammates approve there. */
export function IntegrationsPage() {
  const { app } = useWorkspace()
  const appId = app!.id
  const q = useSlackStatus(appId)
  const channels = useSlackChannels(appId, !!q.data?.connected)
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    const r = params.get('slack')
    if (r && RESULT[r]) {
      const [msg, kind] = RESULT[r]
      if (kind === 'success') toast.success(msg)
      else toast.error(msg)
      setParams({}, { replace: true })
    }
  }, [params, setParams])

  const refresh = () => qc.invalidateQueries({ queryKey: aiqk.all(appId) })
  const install = async () => {
    setBusy(true)
    try {
      window.location.href = (await aiApi(appId).slackInstall()).url
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }
  const simulate = async () => {
    setBusy(true)
    try {
      await aiApi(appId).slackSimulate()
      refresh()
      toast.success('Simulated Slack connected')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const disconnect = async () => {
    setBusy(true)
    try {
      await aiApi(appId).slackDisconnect()
      refresh()
      setConfirm(false)
      toast.success('Slack disconnected')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const s = q.data
  return (
    <div className="max-w-3xl">
      <PageHeader title="Integrations" description="Connect the tools your team already uses." breadcrumbs={[{ label: app!.name, to: `/apps/${appId}` }, { label: 'AI Team' }, { label: 'Integrations' }]} />
      {q.isLoading ? (
        <Card>
          <LoadingRows />
        </Card>
      ) : q.error || !s ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <Card data-testid="slack-card">
          <CardHeader className="flex-row items-start gap-3 space-y-0">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-white shadow-sm">
              <Slack className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <CardTitle className="flex flex-wrap items-center gap-2">
                Slack
                {s.connected ? (
                  <Badge variant="success">
                    <CheckCircle2 className="size-3" /> Connected
                  </Badge>
                ) : (
                  <Badge variant="secondary">Not connected</Badge>
                )}
                {s.simulated && <Badge variant="warning">Simulated</Badge>}
              </CardTitle>
              <CardDescription>AI agents post reports and approval requests with Approve / Reject buttons. Teammates are matched to Signalcraft by their email address.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {s.connected ? (
              <>
                <div className="text-sm">
                  Workspace <strong>{s.team_name}</strong>
                  {s.connected_at && <span className="text-muted-foreground"> · connected {new Date(s.connected_at).toLocaleDateString()}</span>}
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">Channels the bot can post to</div>
                  <div className="flex flex-wrap gap-1.5">
                    {channels.data?.map((c) => (
                      <span key={c.id} className="inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-xs">
                        <Hash className="size-3" />
                        {c.name}
                      </span>
                    )) ?? <span className="text-xs text-muted-foreground">Loading…</span>}
                  </div>
                  {!s.simulated && <p className="mt-1.5 text-xs text-muted-foreground">For private channels, invite the bot first (/invite @Signalcraft).</p>}
                </div>
                {s.simulated && (
                  <p className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning-strong">
                    Messages go to the development Slack log, not to a real workspace.{' '}
                    <a href="/dev/slack" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium underline">
                      Open the log <ExternalLink className="size-3" />
                    </a>
                  </p>
                )}
                {s.can_manage && (
                  <Button variant="outline" onClick={() => setConfirm(true)}>
                    <Unplug /> Disconnect
                  </Button>
                )}
              </>
            ) : s.can_manage ? (
              <div className="flex flex-wrap gap-2">
                {s.configured ? (
                  <Button onClick={install} loading={busy} data-testid="slack-install">
                    <Slack /> Add to Slack
                  </Button>
                ) : (
                  <Button onClick={simulate} loading={busy} data-testid="slack-simulate">
                    <FlaskConical /> Connect simulated Slack
                  </Button>
                )}
                {!s.configured && <p className="w-full text-xs text-muted-foreground">The Slack app isn’t configured on this server yet (SLACK_CLIENT_ID / SLACK_CLIENT_SECRET), so you can try everything with a simulated workspace.</p>}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Ask an admin to connect Slack.</p>
            )}
            {s.can_manage && (
              <details className="rounded-lg border p-3 text-sm">
                <summary className="cursor-pointer select-none font-medium">Slack app settings (for your administrator)</summary>
                <div className="mt-3 space-y-3">
                  <Copyable label="OAuth redirect URL" value={s.redirect_url} />
                  <Copyable label="Interactivity request URL" value={s.interactivity_url} />
                  <div>
                    <div className="text-xs font-medium text-muted-foreground">Bot token scopes</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.bot_scopes.map((x) => (
                        <code key={x} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                          {x}
                        </code>
                      ))}
                    </div>
                  </div>
                </div>
              </details>
            )}
          </CardContent>
        </Card>
      )}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Disconnect Slack?" description="The bot token is revoked and agents stop posting to Slack. Their other destinations keep working." confirmLabel="Disconnect" destructive loading={busy} onConfirm={disconnect} />
    </div>
  )
}
