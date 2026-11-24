/** One lead form: build, design, settings, share, submissions and analytics. */
import { useCallback, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ExternalLink, Pause, Play, Rocket, Undo2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { formsApi, fqk, useForm, useFormsMeta } from '@/api/forms'
import { ErrorState, FullPageSpinner, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/form-controls'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useWorkspace } from '@/hooks/useWorkspace'
import { formatDateTime } from '@/lib/utils'
import type { FormDefinition, FormOut } from '@/types/forms'
import { SaveIndicator, useCampaignAutosave } from '../email/campaignKit'
import { AnalyticsTab } from './AnalyticsTab'
import { BuildTab } from './BuildTab'
import { DesignTab } from './DesignTab'
import { FormStatusBadges } from './FormsPage'
import { withDefaults } from './meta'
import { SettingsTab } from './SettingsTab'
import { ShareTab } from './ShareTab'
import { SubmissionsTab } from './SubmissionsTab'

const TABS = [
  ['build', 'Build'],
  ['design', 'Design'],
  ['settings', 'Settings'],
  ['share', 'Share'],
  ['submissions', 'Submissions'],
  ['analytics', 'Analytics'],
] as const
type TabKey = (typeof TABS)[number][0]

export function FormDetailPage() {
  const { app, org, can } = useWorkspace()
  const appId = app!.id
  const { formId } = useParams()
  const q = useForm(appId, formId!)
  if (q.isLoading) return <FullPageSpinner />
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  return <FormEditor key={q.data.id} appId={appId} orgName={org?.name ?? ''} appName={app!.name} form={q.data} write={can('forms.write')} />
}

function FormEditor({ appId, orgName, appName, form, write }: { appId: string; orgName: string; appName: string; form: FormOut; write: boolean }) {
  const qc = useQueryClient()
  const meta = useFormsMeta(appId)
  const [params, setParams] = useSearchParams()
  const tab = (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'build') as TabKey
  const [busy, setBusy] = useState<'publish' | 'pause' | 'discard' | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const auto = useCampaignAutosave<FormOut>({
    campaign: form,
    save: (id, body) => formsApi(appId).update(id, { ...(body.name !== undefined && { name: body.name }), ...(body.draft !== undefined && { draft: body.draft }) }),
    onSaved: (saved) => {
      qc.setQueryData(fqk.form(appId, saved.id), saved)
      void qc.invalidateQueries({ queryKey: fqk.list(appId) })
    },
    rest: 'your form',
  })

  // The latest definition, so several edits in one tick compose instead of overwriting each other.
  const def = withDefaults((auto.draft.draft ?? form.draft) as FormDefinition)
  const defRef = useRef(def)
  defRef.current = def
  const update = auto.update
  const patch = useCallback(
    (p: Partial<FormDefinition>) => {
      const next = { ...defRef.current, ...p }
      defRef.current = next
      update({ draft: next })
    },
    [update],
  )

  const live = form.status === 'published'
  const canPublish = form.status !== 'published' || form.has_unpublished_changes || auto.state === 'saving'

  const act = async (kind: 'publish' | 'pause' | 'discard') => {
    setBusy(kind)
    try {
      if (!(await auto.flush())) return
      const api = formsApi(appId)
      const saved = kind === 'publish' ? await api.publish(form.id) : kind === 'pause' ? await api.pause(form.id) : await api.discard(form.id)
      qc.setQueryData(fqk.form(appId, saved.id), saved)
      void qc.invalidateQueries({ queryKey: fqk.list(appId) })
      void qc.invalidateQueries({ queryKey: fqk.versions(appId, saved.id) })
      if (kind === 'discard') {
        auto.setDraft(saved)
        defRef.current = withDefaults(saved.draft)
        toast.success('Changes discarded')
      } else if (kind === 'pause') toast.success('Form paused. It no longer accepts submissions.')
      else toast.success(form.status === 'paused' && !form.has_unpublished_changes ? 'Form resumed' : 'Published. Your form is live.')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
      setConfirmDiscard(false)
    }
  }

  const props = { appId, form, def, patch, meta: meta.data, write }

  return (
    <div className="min-w-0">
      <PageHeader
        breadcrumbs={[{ label: orgName }, { label: appName, to: `/apps/${appId}` }, { label: 'Lead forms', to: `/apps/${appId}/forms` }, { label: auto.draft.name || form.name }]}
        title={auto.draft.name || form.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <FormStatusBadges status={form.status} changes={form.has_unpublished_changes} />
            {form.published_at && <span className="text-xs">Last published {formatDateTime(form.published_at)}</span>}
            {write && <SaveIndicator state={auto.state} onRetry={() => void auto.flush()} />}
          </span>
        }
      />
      <div className="-mt-2 mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="w-full max-w-sm">
          <label htmlFor="form-name" className="sr-only">
            Form name
          </label>
          <Input
            id="form-name"
            value={auto.draft.name ?? form.name}
            maxLength={120}
            disabled={!write}
            onChange={(e) => (e.target.value.trim() ? auto.update({ name: e.target.value }) : auto.setDraft((d) => ({ ...d, name: '' })))}
            onBlur={(e) => !e.target.value.trim() && auto.setDraft((d) => ({ ...d, name: form.name }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {live && (
            <Button variant="outline" size="sm" asChild>
              <a href={form.embed.hosted_url} target="_blank" rel="noreferrer" data-testid="preview-live">
                <ExternalLink /> Preview
              </a>
            </Button>
          )}
          {write && form.published_version !== null && form.has_unpublished_changes && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmDiscard(true)} disabled={!!busy}>
              <Undo2 /> Discard changes
            </Button>
          )}
          {write && form.status === 'published' && (
            <Button variant="outline" size="sm" onClick={() => act('pause')} loading={busy === 'pause'} disabled={!!busy}>
              <Pause /> Pause
            </Button>
          )}
          {write && form.status === 'paused' && !form.has_unpublished_changes && (
            <Button variant="outline" size="sm" onClick={() => act('publish')} loading={busy === 'publish'} disabled={!!busy}>
              <Play /> Resume
            </Button>
          )}
          {write && (form.status !== 'paused' || form.has_unpublished_changes) && (
            <Button size="sm" onClick={() => act('publish')} loading={busy === 'publish'} disabled={!!busy || !canPublish} data-testid="publish-form">
              <Rocket /> {form.status === 'draft' ? 'Publish' : 'Publish changes'}
            </Button>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setParams((p) => (p.set('tab', v), p), { replace: true })}>
        <div className="overflow-x-auto">
          <TabsList className="w-max min-w-full">
            {TABS.map(([k, l]) => (
              <TabsTrigger key={k} value={k}>
                {l}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="build">
          <BuildTab {...props} />
        </TabsContent>
        <TabsContent value="design">
          <DesignTab {...props} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab {...props} />
        </TabsContent>
        <TabsContent value="share">
          <ShareTab {...props} onPublish={() => act('publish')} publishing={busy === 'publish'} />
        </TabsContent>
        <TabsContent value="submissions">
          <SubmissionsTab appId={appId} form={form} write={write} />
        </TabsContent>
        <TabsContent value="analytics">
          <AnalyticsTab appId={appId} form={form} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard unpublished changes?"
        description="The builder goes back to the version that is live on your website. This can't be undone."
        confirmLabel="Discard changes"
        destructive
        loading={busy === 'discard'}
        onConfirm={() => act('discard')}
      />
    </div>
  )
}
