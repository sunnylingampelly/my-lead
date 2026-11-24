/** A small rich-text box (bold, italic, link, list) producing simple HTML. The server sanitises it. */
import { useEffect, useRef } from 'react'
import { Bold, Italic, Link2, List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { sanitizeHtml } from './meta'

export function RichText({ id, value, onChange, disabled, label }: { id: string; value: string; onChange: (html: string) => void; disabled?: boolean; label: string }) {
  const ref = useRef<HTMLDivElement>(null)

  // Load outside changes (e.g. discard) without disturbing the caret while typing.
  useEffect(() => {
    const el = ref.current
    if (el && document.activeElement !== el && el.innerHTML !== value) el.innerHTML = sanitizeHtml(value)
  }, [value])

  const emit = () => {
    const el = ref.current
    if (el) onChange(el.innerHTML.slice(0, 5000))
  }
  const exec = (cmd: string, arg?: string) => {
    ref.current?.focus()
    document.execCommand(cmd, false, arg)
    emit()
  }

  return (
    <div className="overflow-hidden rounded-md border border-input bg-card shadow-sm focus-within:ring-2 focus-within:ring-ring/40">
      <div className="flex gap-0.5 border-b bg-muted/40 p-1" role="toolbar" aria-label="Formatting">
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Bold" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')}>
          <Bold />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Italic" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')}>
          <Italic />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Bulleted list" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertUnorderedList')}>
          <List />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Link"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const url = window.prompt('Link address (https://…)', 'https://')
            if (url && /^https?:\/\/\S+$/i.test(url.trim())) exec('createLink', url.trim())
          }}
        >
          <Link2 />
        </Button>
      </div>
      <div
        id={id}
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        className="min-h-[96px] px-3 py-2 text-sm outline-none [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5"
      />
    </div>
  )
}
