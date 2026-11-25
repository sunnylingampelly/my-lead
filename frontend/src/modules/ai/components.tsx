import { ArrowRight, CheckCircle2, CircleDashed, Clock, Loader2, MessageSquareText, Send, ShieldQuestion, Wrench, XCircle, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/misc'
import { cn } from '@/lib/utils'
import type { AgentRun, RunStep } from '@/types/ai'
import { Markdown } from './Markdown'

/** trigger → actions → destination, as small chips joined by arrows. */
export function FlowChips({ steps, className }: { steps: string[]; className?: string }) {
  return (
    <ol className={cn('flex flex-wrap items-center gap-1 text-[11px]', className)} aria-label="How it works">
      {steps.map((s, i) => (
        <li key={i} className="flex items-center gap-1">
          {i > 0 && <ArrowRight className="size-3 text-muted-foreground" aria-hidden />}
          <span className={cn('rounded-md px-1.5 py-0.5 font-medium', i === 0 ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' : i === steps.length - 1 ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300' : 'bg-muted text-muted-foreground')}>
            {s}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** An accessible on/off switch. */
export function Switch({ checked, onChange, label, disabled, testId }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
      )}
    >
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  )
}

const RUN_STATUS: Record<AgentRun['status'], { label: string; tone: 'success' | 'destructive' | 'secondary' | 'default' | 'warning' }> = {
  queued: { label: 'Queued', tone: 'secondary' },
  running: { label: 'Running', tone: 'default' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'destructive' },
  skipped: { label: 'Skipped', tone: 'warning' },
}

export function RunStatus({ run }: { run: Pick<AgentRun, 'status' | 'dry_run' | 'simulated'> }) {
  const s = RUN_STATUS[run.status] ?? RUN_STATUS.queued
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant={s.tone}>
        {(run.status === 'running' || run.status === 'queued') && <Loader2 className="size-3 animate-spin" />}
        {s.label}
      </Badge>
      {run.dry_run && <Badge variant="outline">Dry run</Badge>}
      {run.simulated && <Badge variant="warning">Simulated</Badge>}
    </span>
  )
}

function stepIcon(s: RunStep): { icon: LucideIcon; tone: string } {
  if (s.status === 'failed' || s.kind === 'error') return { icon: XCircle, tone: 'text-destructive bg-danger-soft' }
  if (s.kind === 'proposed') return { icon: ShieldQuestion, tone: 'text-warning-strong bg-warning-soft' }
  if (s.kind === 'message') return { icon: MessageSquareText, tone: 'text-primary bg-accent' }
  if (s.kind === 'deliver') return { icon: Send, tone: 'text-indigo-700 bg-indigo-100 dark:text-indigo-300 dark:bg-indigo-500/15' }
  if (s.status === 'simulated') return { icon: CircleDashed, tone: 'text-muted-foreground bg-muted' }
  return { icon: s.kind === 'tool' ? Wrench : CheckCircle2, tone: 'text-success-strong bg-success-soft' }
}

/** A run's steps as a vertical timeline: each tool call with its result, approvals, the report and where it went. */
export function RunTimeline({ steps }: { steps: RunStep[] }) {
  if (!steps.length)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Clock className="size-4" /> No steps yet.
      </p>
    )
  return (
    <ol className="relative space-y-4 border-l pl-5" data-testid="run-timeline">
      {steps.map((s) => {
        const { icon: Icon, tone } = stepIcon(s)
        const title =
          s.kind === 'message' ? 'Report' : s.kind === 'deliver' ? 'Delivered' : s.kind === 'error' ? 'Error' : s.kind === 'proposed' ? `Approval needed: ${s.tool_label}` : s.tool_label ?? s.tool ?? 'Step'
        return (
          <li key={s.id} className="relative" data-testid="run-step" data-kind={s.kind}>
            <span className={cn('absolute -left-[31px] flex size-6 items-center justify-center rounded-full ring-4 ring-card', tone)}>
              <Icon className="size-3.5" />
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{title}</span>
              {s.status === 'simulated' && <Badge variant="outline">Simulated</Badge>}
              {s.kind === 'proposed' && s.action_status && <Badge variant={s.action_status === 'pending' ? 'warning' : s.action_status === 'executed' ? 'success' : 'secondary'}>{s.action_status}</Badge>}
              <time className="ml-auto text-[11px] text-muted-foreground" dateTime={s.at}>
                {new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </time>
            </div>
            {s.summary && (
              <div className={cn('mt-1 rounded-md text-muted-foreground', s.kind === 'message' && 'border bg-muted/30 p-3 text-foreground')}>
                <Markdown text={s.summary} className="text-xs" />
              </div>
            )}
            {s.args && Object.keys(s.args).length > 0 && s.kind !== 'message' && (
              <details className="mt-1 text-[11px] text-muted-foreground">
                <summary className="cursor-pointer select-none">Arguments</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono">{JSON.stringify(s.args, null, 2)}</pre>
              </details>
            )}
            {(s.input_tokens > 0 || s.output_tokens > 0) && (
              <div className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
                {s.input_tokens + s.output_tokens} tokens
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
