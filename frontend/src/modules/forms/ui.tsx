/** Small controls shared by the lead form builder tabs. */
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label } from '@/components/ui/form-controls'
import { Checkbox } from '@/components/audience'
import { cn } from '@/lib/utils'
import { isHttpUrl } from './meta'

export function Switch({
  id,
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: ReactNode
  hint?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className={cn('text-sm font-medium', disabled && 'opacity-60')}>
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-primary' : 'bg-muted-foreground/30',
        )}
      >
        <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
    </div>
  )
}

export function Section({ title, description, children, className }: { title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  )
}

/** Segmented single choice. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  disabled,
}: {
  value: T
  onChange: (v: T) => void
  options: [T, ReactNode][]
  label: string
  disabled?: boolean
}) {
  return (
    <div className="inline-flex max-w-full flex-wrap rounded-md border bg-card p-0.5" role="radiogroup" aria-label={label}>
      {options.map(([k, l]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          disabled={disabled}
          onClick={() => onChange(k)}
          className={cn('rounded px-2.5 py-1 text-xs font-medium transition', value === k ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          {l}
        </button>
      ))}
    </div>
  )
}

const HEX = /^#[0-9a-fA-F]{6}$/

export function ColorField({ id, label, value, onChange, disabled }: { id: string; label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [text, setText] = useState(value)
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setText(value)
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={HEX.test(value) ? value : '#000000'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 shrink-0 cursor-pointer rounded-md border bg-card p-1"
        />
        <Input
          id={id}
          value={text}
          disabled={disabled}
          maxLength={7}
          aria-invalid={!HEX.test(text)}
          onChange={(e) => {
            const v = e.target.value.trim()
            setText(v)
            if (HEX.test(v)) onChange(v.toLowerCase())
          }}
          className="min-w-0 font-mono"
        />
      </div>
    </div>
  )
}

/** Free-text chips (e.g. allowed domains). Enter or comma adds. */
export function ChipsInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  normalize = (s) => s.trim(),
}: {
  id: string
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  disabled?: boolean
  normalize?: (s: string) => string
}) {
  const [text, setText] = useState('')
  const add = () => {
    const parts = text
      .split(/[,\s]+/)
      .map(normalize)
      .filter(Boolean)
    if (parts.length) onChange([...new Set([...value, ...parts])])
    setText('')
  }
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-card px-2 py-1.5 shadow-sm focus-within:ring-2 focus-within:ring-ring/40">
      {value.map((v) => (
        <span key={v} className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
          <span className="truncate">{v}</span>
          {!disabled && (
            <button type="button" className="rounded-full px-0.5 hover:bg-black/10" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              ×
            </button>
          )}
        </span>
      ))}
      <input
        id={id}
        value={text}
        disabled={disabled}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            add()
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
        }}
        onBlur={add}
        className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}

/** Multi-select as a scrollable list of checkboxes. */
export function CheckList({
  idPrefix,
  items,
  value,
  onChange,
  empty,
  disabled,
}: {
  idPrefix: string
  items: { id: string; label: ReactNode }[]
  value: string[]
  onChange: (v: string[]) => void
  empty: ReactNode
  disabled?: boolean
}) {
  if (!items.length) return <p className="text-xs text-muted-foreground">{empty}</p>
  return (
    <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
      {items.map((it) => (
        <label key={it.id} htmlFor={`${idPrefix}-${it.id}`} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted/50">
          <Checkbox
            id={`${idPrefix}-${it.id}`}
            checked={value.includes(it.id)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...value, it.id] : value.filter((x) => x !== it.id))}
          />
          <span className="min-w-0 truncate">{it.label}</span>
        </label>
      ))}
    </div>
  )
}

/** Text that must not be empty: edits commit only while non-empty; leaving it empty restores the saved value. */
export function RequiredText({ id, value, onChange, maxLength, disabled }: { id: string; value: string; onChange: (v: string) => void; maxLength?: number; disabled?: boolean }) {
  const [text, setText] = useState(value)
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setText(value)
  }
  return (
    <Input
      id={id}
      value={text}
      maxLength={maxLength}
      disabled={disabled}
      aria-invalid={!text.trim()}
      onChange={(e) => {
        setText(e.target.value)
        if (e.target.value.trim()) onChange(e.target.value)
      }}
      onBlur={() => !text.trim() && setText(value)}
    />
  )
}

/** URL input that only commits absolute http(s) URLs (or empty), and says why otherwise. */
export function UrlInput({
  id,
  value,
  onChange,
  placeholder = 'https://',
  disabled,
}: {
  id: string
  value: string | null
  onChange: (v: string | null) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [text, setText] = useState(value ?? '')
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    if ((value ?? '') !== text.trim()) setText(value ?? '')
  }
  const bad = !!text.trim() && !isHttpUrl(text.trim())
  return (
    <div className="space-y-1">
      <Input
        id={id}
        type="url"
        inputMode="url"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={bad}
        onChange={(e) => {
          const v = e.target.value
          setText(v)
          if (!v.trim()) onChange(null)
          else if (isHttpUrl(v.trim())) onChange(v.trim())
        }}
      />
      {bad && (
        <p role="alert" className="text-xs font-medium text-destructive">
          Enter a full address starting with http:// or https://
        </p>
      )}
    </div>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Copied')
    return true
  } catch {
    toast.error('Couldn’t copy. Select the text and copy it manually.')
    return false
  }
}

export function CopyButton({ text, label = 'Copy', testId }: { text: string; label?: string; testId?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid={testId}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true)
          window.setTimeout(() => setDone(false), 1500)
        }
      }}
    >
      {done ? <Check /> : <Copy />} {done ? 'Copied' : label}
    </Button>
  )
}

export function CodeBlock({ code, testId }: { code: string; testId?: string }) {
  return (
    <div className="min-w-0 space-y-2">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed" data-testid={testId}>
        {code}
      </pre>
      <CopyButton text={code} label="Copy code" testId={testId ? `${testId}-copy` : undefined} />
    </div>
  )
}
