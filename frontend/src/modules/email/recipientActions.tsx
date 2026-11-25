/** Bulk actions on a campaign report's recipient tab: tag, list, follow-up tasks, workflow, resend. */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronDown, ListPlus, ListTodo, Send, Tag, Workflow } from 'lucide-react'
import { aqk, audienceApi, useLists, useTags } from '@/api/audience'
import { automationApi } from '@/api/automation'
import { errorMessage } from '@/api/client'
import { crmApi } from '@/api/crm'
import { emailApi } from '@/api/email'
import { smsApi } from '@/api/sms'
import { voiceApi } from '@/api/voice'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input, Select } from '@/components/ui/form-controls'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { Channel } from './campaignKit'

type Kind = 'tag' | 'list' | 'tasks' | 'workflow'

const api = (channel: Channel, appId: string) => (channel === 'email' ? emailApi(appId) : channel === 'sms' ? smsApi(appId) : voiceApi(appId))

export function RecipientActions({
  channel,
  campaignId,
  campaignName,
  status,
  tabLabel,
  count,
}: {
  channel: Channel
  campaignId: string
  campaignName: string
  /** Report filter (same values as the recipients list), '' = everyone. */
  status: string
  tabLabel: string
  count: number
}) {
  const { app, can } = useWorkspace()
  const appId = app!.id
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [open, setOpen] = useState<Kind | null>(null)
  const [busy, setBusy] = useState(false)
  const [value, setValue] = useState('')
  const [newName, setNewName] = useState('')
  const tags = useTags(appId)
  const lists = useLists(appId)
  const workflows = useQuery({
    queryKey: ['automation', appId, 'list', { page: 1, page_size: 100 }],
    queryFn: () => automationApi(appId).list({ page: 1, page_size: 100 }),
    enabled: open === 'workflow',
  })

  const ids = async () => {
    const r = await api(channel, appId).recipientIds(campaignId, status || undefined)
    if (r.truncated) toast.info(`Using the first ${r.limit.toLocaleString()} of ${r.total.toLocaleString()} people.`)
    if (!r.contact_ids.length) throw new Error('No contacts in this tab (people deleted since the send are skipped).')
    return r.contact_ids
  }

  const run = async (fn: (contactIds: string[]) => Promise<string>) => {
    setBusy(true)
    try {
      const msg = await fn(await ids())
      toast.success(msg)
      setOpen(null)
      setValue('')
      setNewName('')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const apply = () =>
    run(async (contactIds) => {
      const a = audienceApi(appId)
      if (open === 'tag') {
        const tagId = value || (await a.createTag({ name: newName.trim() })).id
        const r = await a.bulk({ action: 'add_tag', contact_ids: contactIds, tag_id: tagId })
        await qc.invalidateQueries({ queryKey: aqk.tags(appId) })
        return `Tagged ${r.affected} contact(s)`
      }
      if (open === 'list') {
        const listId = value || (await a.createList({ name: newName.trim() })).id
        const r = await a.bulk({ action: 'add_to_list', contact_ids: contactIds, list_id: listId })
        await qc.invalidateQueries({ queryKey: aqk.lists(appId) })
        return `Added ${r.affected} contact(s) to the list`
      }
      if (open === 'tasks') {
        let n = 0
        for (const cid of contactIds.slice(0, 200)) {
          await crmApi(appId).createTask({ title: newName.trim() || `Follow up: ${campaignName}`, type: 'follow_up', contact_id: cid })
          n++
        }
        return `Created ${n} follow-up task(s), assigned to each contact’s owner${contactIds.length > 200 ? ' (first 200 people)' : ''}`
      }
      const r = await automationApi(appId).enroll(value, { contact_ids: contactIds })
      return `Enrolled ${r.enrolled}${r.skipped ? `, skipped ${r.skipped}` : ''}`
    })

  const resend = async () => {
    setBusy(true)
    try {
      const contactIds = (await ids()).slice(0, 1000)
      const qs = new URLSearchParams({ contact_ids: contactIds.join(','), name: `${campaignName} (${tabLabel.toLowerCase()})` })
      navigate(`/apps/${appId}/${channel}/campaigns/new?${qs}`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!count) return null
  const title: Record<Kind, string> = { tag: 'Add a tag', list: 'Add to a list', tasks: 'Create follow-up tasks', workflow: 'Enroll in a workflow' }
  const canApply = open === 'workflow' ? !!value : open === 'tasks' ? true : !!value || !!newName.trim()
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" loading={busy} data-testid="recipient-actions">
            Act on {count.toLocaleString()} <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {can('audience.write') && (
            <>
              <DropdownMenuItem onSelect={() => setOpen('tag')}>
                <Tag /> Add tag
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setOpen('list')}>
                <ListPlus /> Add to list (or a new list)
              </DropdownMenuItem>
            </>
          )}
          {can('crm.write') && (
            <DropdownMenuItem onSelect={() => setOpen('tasks')}>
              <ListTodo /> Create follow-up tasks
            </DropdownMenuItem>
          )}
          {can('automation.write') && (
            <DropdownMenuItem onSelect={() => setOpen('workflow')}>
              <Workflow /> Enroll in workflow
            </DropdownMenuItem>
          )}
          {can('campaigns.write') && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={resend} data-testid="resend-to-tab">
                <Send /> {channel === 'email' && status === 'not_opened' ? 'Resend to non-openers' : `New ${channel === 'email' ? 'email' : channel === 'sms' ? 'SMS' : 'call'} campaign to these people`}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{open && title[open]}</DialogTitle>
            <DialogDescription>
              Applies to the {count.toLocaleString()} {count === 1 ? 'person' : 'people'} in “{tabLabel}” for {campaignName}.
            </DialogDescription>
          </DialogHeader>
          {open === 'tag' && (
            <div className="grid gap-3">
              <Field label="Existing tag" htmlFor="ra-tag">
                <Select id="ra-tag" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Create a new tag…</option>
                  {tags.data?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {!value && (
                <Field label="New tag name" htmlFor="ra-newtag">
                  <Input id="ra-newtag" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={`${tabLabel} · ${campaignName}`.slice(0, 60)} />
                </Field>
              )}
            </div>
          )}
          {open === 'list' && (
            <div className="grid gap-3">
              <Field label="Existing list" htmlFor="ra-list">
                <Select id="ra-list" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Create a new list…</option>
                  {lists.data?.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {!value && (
                <Field label="New list name" htmlFor="ra-newlist" hint="A list you can target in any campaign or workflow.">
                  <Input id="ra-newlist" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={`${campaignName}: ${tabLabel}`.slice(0, 60)} />
                </Field>
              )}
            </div>
          )}
          {open === 'tasks' && (
            <Field label="Task title" htmlFor="ra-task" hint="One task per person, assigned to the contact’s owner (or you).">
              <Input id="ra-task" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={`Follow up: ${campaignName}`} />
            </Field>
          )}
          {open === 'workflow' && (
            <Field label="Workflow" htmlFor="ra-wf" hint="People already in the workflow are skipped.">
              <Select id="ra-wf" value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">Choose a workflow…</option>
                {workflows.data?.items.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} {w.status !== 'active' ? `(${w.status})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!canApply} onClick={apply} data-testid="recipient-action-apply">
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
