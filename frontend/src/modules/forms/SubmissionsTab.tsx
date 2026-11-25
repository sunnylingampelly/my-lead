/** Submissions tab: filters, table, detail sheet, spam and GDPR delete, CSV export. */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Download, Inbox, Search, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { formsApi, fqk, useSubmissions } from '@/api/forms'
import { EmptyState, ErrorState, LoadingRows } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Input, Select } from '@/components/ui/form-controls'
import { Badge } from '@/components/ui/misc'
import { Sheet } from '@/components/ui/sheet'
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table'
import { Pagination } from '@/components/audience'
import { downloadFile } from '@/lib/download'
import { formatDateTime, timeAgo } from '@/lib/utils'
import type { FormOut, SubmissionFilters, SubmissionOut } from '@/types/forms'
import { useDebounced } from '../crm/hooks'
import { SUBMISSION_STATUS } from './meta'

const PAGE_SIZE = 25

const show = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : v === true ? 'Yes' : v === false ? 'No' : v == null ? '' : String(v))

function StatusBadge({ status }: { status: string }) {
  const m = SUBMISSION_STATUS[status] ?? { label: status, variant: 'secondary' as const }
  return <Badge variant={m.variant}>{m.label}</Badge>
}

/** Name or email for the row: the contact's name, else the first email-looking value. */
function who(s: SubmissionOut) {
  if (s.contact_name) return s.contact_name
  const email = Object.values(s.values).find((v) => typeof v === 'string' && v.includes('@'))
  return (email as string) || 'Anonymous'
}

function keyValues(s: SubmissionOut) {
  return Object.entries(s.values)
    .filter(([k, v]) => show(v) && !/^(first_name|last_name)$/.test(k))
    .slice(0, 3)
    .map(([k, v]) => `${s.labels[k] ?? k}: ${show(v)}`)
    .join(' · ')
}

const pathOf = (url: string | null) => {
  if (!url) return ''
  try {
    const u = new URL(url)
    return u.host + u.pathname
  } catch {
    return url
  }
}

export function SubmissionsTab({ appId, form, write }: { appId: string; form: FormOut; write: boolean }) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const debounced = useDebounced(search.trim(), 300)
  const filters: SubmissionFilters = { search: debounced || undefined, status: status || undefined, date_from: from || undefined, date_to: to || undefined }
  const q = useSubmissions(appId, form.id, { ...filters, page, page_size: PAGE_SIZE })
  const [open, setOpen] = useState<SubmissionOut | null>(null)
  const [del, setDel] = useState<SubmissionOut | null>(null)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const filtered = !!(debounced || status || from || to)
  const refresh = () => qc.invalidateQueries({ queryKey: fqk.submissions(appId, form.id) })

  const spam = async (s: SubmissionOut, on: boolean) => {
    try {
      const saved = await formsApi(appId).markSpam(form.id, s.id, on)
      if (open?.id === s.id) setOpen(saved)
      await refresh()
      toast.success(on ? 'Marked as spam' : 'Marked as not spam')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <>
      <Card className="min-w-0">
        <div className="flex flex-col gap-2 border-b p-3 lg:flex-row lg:flex-wrap lg:items-center">
          <div className="relative w-full lg:w-64">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search name, email or answers"
              aria-label="Search submissions"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
            />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex lg:items-center">
            <Select
              aria-label="Status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(1)
              }}
              className="lg:w-48"
            >
              <option value="">All statuses</option>
              {Object.entries(SUBMISSION_STATUS).map(([k, m]) => (
                <option key={k} value={k}>
                  {m.label}
                </option>
              ))}
            </Select>
            <Input
              type="date"
              aria-label="From date"
              value={from}
              max={to || undefined}
              onChange={(e) => {
                setFrom(e.target.value)
                setPage(1)
              }}
            />
            <Input
              type="date"
              aria-label="To date"
              value={to}
              min={from || undefined}
              onChange={(e) => {
                setTo(e.target.value)
                setPage(1)
              }}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="lg:ml-auto"
            loading={exporting}
            onClick={async () => {
              setExporting(true)
              try {
                await downloadFile(formsApi(appId).exportPath(form.id, filters), `${form.name}-submissions.csv`)
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setExporting(false)
              }
            }}
          >
            <Download /> Export CSV
          </Button>
        </div>
        {q.isLoading ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.items.length ? (
          <EmptyState
            icon={Inbox}
            title={filtered ? 'No submissions match' : 'No submissions yet'}
            description={filtered ? 'Try other filters.' : form.status === 'published' ? 'Submissions appear here the moment someone sends the form.' : 'Publish the form and add it to your website to start collecting leads.'}
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Contact</TH>
                  <TH className="hidden md:table-cell">Answers</TH>
                  <TH>Status</TH>
                  <TH className="hidden lg:table-cell">Page</TH>
                </TR>
              </THead>
              <TBody>
                {q.data.items.map((s) => (
                  <TR key={s.id} className="cursor-pointer" onClick={() => setOpen(s)} data-testid="submission-row">
                    <TD className="whitespace-nowrap text-muted-foreground" title={formatDateTime(s.created_at)}>
                      {timeAgo(s.created_at)}
                    </TD>
                    <TD className="max-w-[12rem]">
                      {s.contact_id ? (
                        <Link to={`/apps/${appId}/audience/contacts/${s.contact_id}`} className="block truncate font-medium text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
                          {who(s)}
                        </Link>
                      ) : (
                        <span className="block truncate font-medium">{who(s)}</span>
                      )}
                    </TD>
                    <TD className="hidden max-w-[22rem] truncate text-muted-foreground md:table-cell">{keyValues(s)}</TD>
                    <TD>
                      <StatusBadge status={s.status} />
                    </TD>
                    <TD className="hidden max-w-[14rem] truncate text-xs text-muted-foreground lg:table-cell">{pathOf(s.page_url)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <Sheet
        open={!!open}
        onOpenChange={(o) => !o && setOpen(null)}
        title={open ? who(open) : ''}
        description={open ? formatDateTime(open.created_at) : undefined}
        footer={
          open &&
          write && (
            <>
              {open.status === 'spam' ? (
                <Button variant="outline" size="sm" onClick={() => spam(open, false)}>
                  <ShieldCheck /> Not spam
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => spam(open, true)}>
                  <ShieldAlert /> Mark as spam
                </Button>
              )}
              <Button variant="destructive" size="sm" onClick={() => setDel(open)}>
                <Trash2 /> Delete
              </Button>
            </>
          )
        }
      >
        {open && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={open.status} />
              {open.spam_reason && <span className="text-xs text-muted-foreground">Reason: {open.spam_reason}</span>}
              {open.confirmed_at && <span className="text-xs text-muted-foreground">Confirmed {formatDateTime(open.confirmed_at)}</span>}
            </div>
            <dl className="space-y-3">
              {Object.entries(open.values).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs font-medium text-muted-foreground">{open.labels[k] ?? k}</dt>
                  <dd className="whitespace-pre-wrap break-words">{show(v) || '—'}</dd>
                </div>
              ))}
            </dl>
            <div className="space-y-2 rounded-md border p-3 text-xs">
              {open.contact_id && (
                <p>
                  Contact:{' '}
                  <Link className="font-medium text-primary hover:underline" to={`/apps/${appId}/audience/contacts/${open.contact_id}`}>
                    {open.contact_name || 'Open profile'}
                  </Link>
                </p>
              )}
              {open.deal_id && (
                <p>
                  Deal:{' '}
                  <Link className="font-medium text-primary hover:underline" to={`/apps/${appId}/crm/deals/${open.deal_id}`}>
                    Open deal
                  </Link>
                </p>
              )}
              {open.page_url && <p className="break-all">Page: {open.page_url}</p>}
              {open.referrer && <p className="break-all">Referrer: {open.referrer}</p>}
              {open.country && <p>Country: {open.country}</p>}
              {Object.entries(open.utm ?? {}).map(([k, v]) => (
                <p key={k} className="break-all">
                  {k}: {String(v)}
                </p>
              ))}
            </div>
          </div>
        )}
      </Sheet>

      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title="Delete this submission?"
        description="The submission and its answers are erased permanently (for example, to honour a GDPR or DPDP erasure request). The contact record is not deleted; erase it from the contact’s profile if needed."
        confirmLabel="Delete permanently"
        destructive
        loading={busy}
        onConfirm={async () => {
          setBusy(true)
          try {
            await formsApi(appId).deleteSubmission(form.id, del!.id)
            setDel(null)
            setOpen(null)
            await refresh()
            toast.success('Submission deleted')
          } catch (e) {
            toast.error(errorMessage(e))
          } finally {
            setBusy(false)
          }
        }}
      />
    </>
  )
}
