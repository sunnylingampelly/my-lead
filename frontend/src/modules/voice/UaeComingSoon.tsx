import { Link } from 'react-router-dom'
import { CheckCircle2, PhoneCall } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/misc'
import { CountryFlag } from '@/components/CountryFlag'

/** Voice for a UAE application while UAE calling is switched off: why, and the rules that will apply. */
export function UaeVoiceComingSoon({ appId, reason, rules }: { appId: string; reason: string; rules: string[] }) {
  return (
    <Card data-testid="voice-uae-coming-soon">
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <PhoneCall className="size-5 text-primary" />
          <h2 className="text-lg font-semibold">Coming soon for the UAE</h2>
          <CountryFlag code="AE" />
          <Badge variant="secondary">Coming soon</Badge>
        </div>
        <p className="text-sm text-muted-foreground">{reason}</p>
        {rules.length > 0 && (
          <div>
            <div className="text-sm font-medium">Rules that will apply (Cabinet Resolution 56 of 2024)</div>
            <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              {rules.map((r) => (
                <li key={r} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-strong" /> {r}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          Available in the UAE today: <Link className="text-primary hover:underline" to={`/apps/${appId}/email`}>email</Link>,{' '}
          <Link className="text-primary hover:underline" to={`/apps/${appId}/forms`}>lead forms</Link>,{' '}
          <Link className="text-primary hover:underline" to={`/apps/${appId}/chat`}>the AI chatbot (with Arabic replies)</Link>, CRM and automation.
        </p>
      </CardContent>
    </Card>
  )
}
