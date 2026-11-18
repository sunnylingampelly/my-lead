import type { FieldValues, Path, UseFormSetError } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { ApiError, errorMessage } from '@/api/client'

export const passwordSchema = z
  .string()
  .min(10, 'At least 10 characters')
  .max(128, 'At most 128 characters')
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number')

export const emailSchema = z.string().trim().min(1, 'Email is required').email('Enter a valid email address')

/** Map server validation errors onto form fields; anything else becomes a toast. */
export function applyServerErrors<T extends FieldValues>(err: unknown, setError: UseFormSetError<T>, fields: string[]) {
  if (err instanceof ApiError) {
    const fe = err.fieldErrors()
    let mapped = false
    for (const [k, msg] of Object.entries(fe)) {
      if (fields.includes(k)) {
        setError(k as Path<T>, { message: msg })
        mapped = true
      }
    }
    if (mapped) return
  }
  toast.error(errorMessage(err))
}
