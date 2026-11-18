import { Link } from 'react-router-dom'
import { ArrowUpRight, CheckCircle2, Clock, Mail, MapPin, Phone, XCircle } from 'lucide-react'
import { useContact } from '@/api/audience'
import { Button } from '@/components/ui/button'
import { Avatar, Badge, Skeleton } from '@/components/ui/misc'
import { Sheet } from '@/components/ui/sheet'
import { CHANNEL_META, StatusBadge, TagChip } from '@/components/audience'
import { useWorkspace } from '@/hooks/useWorkspace'
import { countryFlag, countryName } from '@/lib/regions'
import { formatDate } from '@/lib/utils'
import type { Channel } from '@/types/audience'

/** Quick view of a contact from a table, without leaving the page. */
export function ContactPeek({ contactId, onClose }: { contactId: string | null; onClose: () => void }) {
  const { app } = useWorkspace()
  return (
    <Sheet
      open={!!contactId}
      onOpenChange={(o) => !o && onClose()}
      title="Contact"
      footer={
        contactId && (
          <Button asChild>
            <Link to={`/apps/${app!.id}/audience/contacts/${contactId}`} onClick={onClose}>
              Open full profile <ArrowUpRight />
            </Link>
          </Button>
        )
      }
    >
      {contactId && <PeekBody id={contactId} />}
    </Sheet>
  )
}

function PeekBody({ id }: { id: string }) {
  const { app } = useWorkspace()
  const q = useContact(app!.id, id)
  if (q.isLoading)
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="size-12 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  if (!q.data) return <p className="text-sm text-muted-foreground">This contact could not be loaded.</p>
  const c = q.data
  const name = c.full_name || c.email || c.phone_display || 'Unnamed contact'
  return (
    <div className="space-y-6" data-testid="contact-peek">
      <div className="flex items-center gap-3">
        <Avatar name={name} className="size-12 text-sm" />
        <div className="min-w-0">
          <div className="truncate text-lg font-semibold">{name}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <StatusBadge status={c.status} />
            {c.jurisdiction && (
              <Badge variant="outline">
                {countryFlag(c.jurisdiction)} {c.jurisdiction_name}
              </Badge>
            )}
            {c.company && <span>{c.company}</span>}
          </div>
        </div>
      </div>

      <dl className="space-y-3 text-sm">
        {[
          { icon: Mail, label: 'Email', value: c.email },
          { icon: Phone, label: 'Phone', value: c.phone_display && `${countryFlag(c.phone_country)} ${c.phone_display}` },
          { icon: MapPin, label: 'Location', value: [c.city, c.state, c.country && countryName(c.country)].filter(Boolean).join(', ') },
          { icon: Clock, label: 'Local time zone', value: c.timezone },
        ].map((r) => (
          <div key={r.label} className="flex gap-3">
            <r.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{r.label}</dt>
              <dd className="break-words">{r.value || '—'}</dd>
            </div>
          </div>
        ))}
      </dl>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reachability</h4>
        <div className="grid grid-cols-3 gap-2">
          {(['email', 'sms', 'voice'] as Channel[]).map((ch) => {
            const e = c.eligibility[ch]
            const Icon = CHANNEL_META[ch].icon
            return (
              <div key={ch} className="rounded-lg border p-2.5" title={e.reasons.join(' · ')}>
                <div className="flex items-center justify-between">
                  <Icon className="size-4 text-muted-foreground" />
                  {e.eligible ? <CheckCircle2 className="size-4 text-success-strong" /> : <XCircle className="size-4 text-muted-foreground/50" />}
                </div>
                <div className="mt-1.5 text-xs font-medium">{CHANNEL_META[ch].label}</div>
                <div className="truncate text-[11px] text-muted-foreground">{e.eligible ? 'Reachable' : e.reasons[0]}</div>
              </div>
            )
          })}
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tags and lists</h4>
        <div className="flex flex-wrap gap-1.5">
          {c.tags.map((t) => (
            <TagChip key={t.id} name={t.name} color={t.color} />
          ))}
          {c.lists.map((l) => (
            <Badge key={l.id} variant="secondary">
              {l.name}
            </Badge>
          ))}
          {!c.tags.length && !c.lists.length && <span className="text-sm text-muted-foreground">None yet</span>}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Added {formatDate(c.created_at)} · source {c.source ?? 'unknown'}
      </p>
    </div>
  )
}
