import { memo, useContext } from 'react'
import { Handle, type NodeProps, Position } from '@xyflow/react'
import { AlertCircle, Users } from 'lucide-react'
import type { NodeType } from '@/api/automation'
import { cn } from '@/lib/utils'
import { BuilderContext } from './context'
import { HANDLE_LABEL, NODE_META } from './meta'

function count(s: Record<string, number> | undefined) {
  if (!s) return null
  const passed = Object.entries(s).filter(([k]) => k !== 'waiting' && k !== 'here_now').reduce((a, [, v]) => a + v, 0)
  return { passed, here: s.here_now ?? 0, yes: s.branch_yes ?? s.branch_a ?? 0, no: s.branch_no ?? s.branch_b ?? 0 }
}

export const FlowNodeCard = memo(function FlowNodeCard({ id, type, data, selected }: NodeProps) {
  const view = useContext(BuilderContext)
  const t = type as NodeType
  const meta = NODE_META[t]
  const Icon = meta.icon
  const issues = view.issues[id] ?? []
  const st = view.stats ? count(view.stats[id]) : null
  const d = data as Record<string, unknown>
  return (
    <div
      className={cn(
        'w-[260px] rounded-xl border bg-card text-left shadow-card transition',
        selected ? 'border-primary ring-2 ring-primary/30' : 'hover:border-primary/40',
        issues.length && !selected && 'border-destructive/60',
      )}
      data-testid={`node-${id}`}
    >
      {t !== 'trigger' && <Handle type="target" position={Position.Top} className="!size-3 !border-2 !border-card !bg-muted-foreground" />}
      <div className="flex items-start gap-3 p-3">
        <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', meta.tone)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{meta.label}</span>
            {issues.length > 0 && <AlertCircle className="size-3.5 text-destructive" aria-label={`${issues.length} problem(s)`} />}
          </div>
          <div className="truncate text-sm font-medium">{(d.label as string) || view.summary(id, t, d) || meta.description}</div>
          {d.label ? <div className="truncate text-xs text-muted-foreground">{view.summary(id, t, d)}</div> : null}
        </div>
      </div>
      {issues.length > 0 && <div className="border-t bg-danger-soft px-3 py-1.5 text-[11px] text-danger-strong">{issues[0]}</div>}
      {st && (
        <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground" data-testid={`node-stats-${id}`}>
          <span className="flex items-center gap-1">
            <Users className="size-3" /> {st.passed} passed
          </span>
          {st.here > 0 && <span className="font-medium text-primary">{st.here} here now</span>}
          {(t === 'condition' || t === 'split') && (
            <span className="ml-auto tabular-nums">
              {t === 'condition' ? 'Yes' : 'A'} {st.yes} · {t === 'condition' ? 'No' : 'B'} {st.no}
            </span>
          )}
        </div>
      )}
      {meta.outputs.length === 1 && <Handle type="source" position={Position.Bottom} className="!size-3 !border-2 !border-card !bg-primary" />}
      {meta.outputs.length === 2 &&
        meta.outputs.map((h, i) => (
          <Handle key={h} id={h!} type="source" position={Position.Bottom} style={{ left: i === 0 ? '28%' : '72%' }} className={cn('!size-3 !border-2 !border-card', i === 0 ? '!bg-success-strong' : '!bg-destructive')}>
            <span className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded bg-card px-1 text-[10px] font-semibold text-muted-foreground">{HANDLE_LABEL[h!]}</span>
          </Handle>
        ))}
    </div>
  )
})
