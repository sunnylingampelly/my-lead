import * as React from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

const fieldBase =
  'flex w-full rounded-md border border-input bg-card px-3 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/30'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input type={type} className={cn(fieldBase, 'h-9 py-1', className)} ref={ref} {...props} />
  ),
)
Input.displayName = 'Input'

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea className={cn(fieldBase, 'min-h-[80px] py-2', className)} ref={ref} {...props} />
  ),
)
Textarea.displayName = 'Textarea'

/** Native select styled to match inputs: accessible and works with react-hook-form register(). */
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select ref={ref} className={cn(fieldBase, 'h-9 appearance-none pr-8', className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 size-4 text-muted-foreground" />
    </div>
  ),
)
Select.displayName = 'Select'

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn('text-sm font-medium leading-none', className)} {...props} />
))
Label.displayName = 'Label'

interface FieldProps {
  label: string
  htmlFor: string
  error?: string
  hint?: React.ReactNode
  children: React.ReactNode
  className?: string
  action?: React.ReactNode
}

export function Field({ label, htmlFor, error, hint, children, className, action }: FieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between">
        <Label htmlFor={htmlFor}>{label}</Label>
        {action}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
