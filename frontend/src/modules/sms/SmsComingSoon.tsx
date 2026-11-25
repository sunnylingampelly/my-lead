import { Link } from 'react-router-dom'
import { ArrowLeft, Inbox, Mail, MessageSquare, PhoneCall, ShieldCheck, Workflow } from 'lucide-react'
import { PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/misc'
import { useWorkspace } from '@/hooks/useWorkspace'

const COMING = [
  { icon: ShieldCheck, title: 'Compliant campaigns in every market', text: "Ready for India's TRAI DLT, US A2P 10DLC and the UAE's TDRA rules, with quiet hours and opt-out text built in." },
  { icon: Inbox, title: 'Two-way inbox', text: 'Replies in one place, with STOP and START handled for you and linked to each contact.' },
  { icon: Workflow, title: 'SMS in automation', text: 'Text steps in workflows and "SMS reply received" triggers.' },
]

/** Every /apps/:appId/sms/* route: SMS is coming soon in every market. No actions. */
export function SmsComingSoonPage() {
  const { app, org } = useWorkspace()
  const base = `/apps/${app!.id}`
  return (
    <>
      <PageHeader breadcrumbs={[{ label: org?.name ?? '' }, { label: app!.name, to: base }, { label: 'SMS' }]} title="SMS" />
      <Card className="mx-auto max-w-3xl" data-testid="sms-coming-soon">
        <CardContent className="space-y-6 p-6 sm:p-10">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <MessageSquare className="size-7" />
            </div>
            <Badge variant="secondary">Coming soon</Badge>
            <h2 className="text-2xl font-semibold tracking-tight">SMS is coming soon</h2>
            <p className="max-w-xl text-sm text-muted-foreground">
              We're finishing text messaging with carrier registration built in. Until it's ready, nothing can be texted from Signalcraft and SMS isn't charged.
            </p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-3">
            {COMING.map((c) => (
              <li key={c.title} className="rounded-lg border bg-muted/30 p-4">
                <c.icon className="size-4 text-primary" />
                <div className="mt-2 text-sm font-medium">{c.title}</div>
                <p className="mt-1 text-xs text-muted-foreground">{c.text}</p>
              </li>
            ))}
          </ul>
          <div className="rounded-lg border px-4 py-3 text-sm">
            <div className="font-medium">Available today</div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-muted-foreground">
              <Link to={`${base}/email`} className="inline-flex items-center gap-1.5 hover:text-primary">
                <Mail className="size-4" /> Email campaigns
              </Link>
              <Link to={`${base}/voice`} className="inline-flex items-center gap-1.5 hover:text-primary">
                <PhoneCall className="size-4" /> Voice and AI calls
              </Link>
            </div>
          </div>
          <div className="flex justify-center">
            <Button variant="outline" asChild>
              <Link to={base} data-testid="sms-back-to-overview">
                <ArrowLeft /> Back to overview
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  )
}
