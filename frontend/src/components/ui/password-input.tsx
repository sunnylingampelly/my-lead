import * as React from 'react'
import { ArrowBigUp, Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from './form-controls'

/** Password field with show/hide toggle and a Caps Lock warning. */
export const PasswordInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, onKeyUp, onKeyDown, onBlur, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false)
    const [caps, setCaps] = React.useState(false)
    const check = (e: React.KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.('CapsLock') ?? false)
    return (
      <div>
        <div className="relative">
          <Input
            ref={ref}
            type={visible ? 'text' : 'password'}
            className={cn('pr-10', className)}
            onKeyUp={(e) => {
              check(e)
              onKeyUp?.(e)
            }}
            onKeyDown={(e) => {
              check(e)
              onKeyDown?.(e)
            }}
            onBlur={(e) => {
              setCaps(false)
              onBlur?.(e)
            }}
            {...props}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setVisible((v) => !v)}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition hover:text-foreground"
            aria-label={visible ? 'Hide typed characters' : 'Show typed characters'}
          >
            {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        {caps && (
          <p className="mt-1 flex items-center gap-1 text-xs font-medium text-warning-strong" role="status">
            <ArrowBigUp className="size-3.5" /> Caps Lock is on
          </p>
        )}
      </div>
    )
  },
)
PasswordInput.displayName = 'PasswordInput'

const RULES: [RegExp, string][] = [
  [/.{10,}/, '10+ characters'],
  [/[A-Za-z]/, 'a letter'],
  [/\d/, 'a number'],
]

/** Live strength feedback matching the server's password policy, plus extra credit for length and symbols. */
export function PasswordStrength({ value }: { value: string }) {
  if (!value) return null
  const met = RULES.filter(([r]) => r.test(value)).length
  const bonus = (value.length >= 14 ? 1 : 0) + (/[^A-Za-z0-9]/.test(value) ? 1 : 0) + (/[a-z]/.test(value) && /[A-Z]/.test(value) ? 1 : 0)
  const score = met < 3 ? met - 1 : Math.min(4, 2 + bonus)
  const labels = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong']
  const colors = ['bg-destructive', 'bg-destructive', 'bg-warning', 'bg-success', 'bg-success']
  const idx = Math.max(0, score)
  const missing = RULES.filter(([r]) => !r.test(value)).map(([, l]) => l)
  return (
    <div className="mt-1.5" aria-live="polite">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cn('h-1 flex-1 rounded-full bg-muted transition-colors', i < idx || (idx === 4 && i <= 3) ? colors[idx] : '')} />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{labels[idx]}</span>
        <span>{missing.length ? `Needs ${missing.join(', ')}` : ''}</span>
      </div>
    </div>
  )
}
