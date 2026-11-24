import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { FormDefinition, FormsMeta } from '@/types/forms'
import { DeviceToggle } from '../email/components'
import { FormPreview } from './FormPreview'
import { Segmented } from './ui'

/** Sticky live preview beside the editor on wide screens; a toggle on phones and tablets. */
export function PreviewPane({ def, meta, selectedId, onSelect }: { def: FormDefinition; meta?: FormsMeta; selectedId?: string | null; onSelect?: (id: string) => void }) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [view, setView] = useState<'form' | 'success'>('form')
  const [open, setOpen] = useState(false)
  return (
    <div className="min-w-0">
      <Button variant="outline" size="sm" className="mb-3 w-full lg:hidden" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="toggle-preview">
        {open ? <EyeOff /> : <Eye />} {open ? 'Hide preview' : 'Show preview'}
      </Button>
      <div className={cn('lg:sticky lg:top-4 lg:block', open ? 'block' : 'hidden')}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">Live preview</span>
          <div className="flex items-center gap-2">
            <Segmented
              label="Preview state"
              value={view}
              onChange={setView}
              options={[
                ['form', 'Form'],
                ['success', 'Thank you'],
              ]}
            />
            <DeviceToggle value={device} onChange={setDevice} />
          </div>
        </div>
        <div className="max-h-none overflow-hidden rounded-lg border bg-[repeating-linear-gradient(45deg,hsl(var(--muted))_0_10px,hsl(var(--muted)/0.6)_10px_20px)] p-3 sm:p-5 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
          <FormPreview def={def} meta={meta} device={device} showSuccess={view === 'success'} selectedId={selectedId} onSelect={onSelect} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Type into the preview to try conditional fields and steps. Nothing is submitted.</p>
      </div>
    </div>
  )
}
