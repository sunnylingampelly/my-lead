import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { safeHref } from './lib'

/**
 * A small, safe markdown renderer for AI answers: paragraphs, headings, bullet and numbered lists, **bold**,
 * _italic_, `code` and [links](/apps/...). It builds React elements only (no innerHTML), so HTML in the text is
 * shown as text. Links work only for app paths (opened in the app) and https URLs (new tab, noopener).
 */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|(?<![\w*])_[^_]+_(?!\w)|(?<![\w*])\*[^*\s][^*]*\*(?!\w))/g

function inline(text: string, onNavigate?: () => void): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0]
    if (m.index! > last) out.push(text.slice(last, m.index))
    if (tok.startsWith('**')) out.push(<strong key={k++}>{inline(tok.slice(2, -2), onNavigate)}</strong>)
    else if (tok.startsWith('`')) out.push(<code key={k++} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!
      const target = safeHref(lm[2]!)
      if (!target) out.push(lm[1])
      else if (target.internal)
        out.push(
          <Link key={k++} to={target.href} onClick={onNavigate} className="font-medium text-primary underline-offset-2 hover:underline">
            {lm[1]}
          </Link>,
        )
      else
        out.push(
          <a key={k++} href={target.href} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-primary underline-offset-2 hover:underline">
            {lm[1]}
          </a>,
        )
    } else out.push(<em key={k++}>{tok.slice(1, -1)}</em>)
    last = m.index! + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

type Block = { kind: 'p' | 'h' | 'ul' | 'ol'; lines: string[] }

function blocks(src: string): Block[] {
  const out: Block[] = []
  for (const raw of src.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const prev = out[out.length - 1]
    if (!line.trim()) {
      out.push({ kind: 'p', lines: [] })
      continue
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const head = /^#{1,4}\s+(.*)$/.exec(line)
    if (bullet) {
      if (prev?.kind === 'ul') prev.lines.push(bullet[1]!)
      else out.push({ kind: 'ul', lines: [bullet[1]!] })
    } else if (num) {
      if (prev?.kind === 'ol') prev.lines.push(num[1]!)
      else out.push({ kind: 'ol', lines: [num[1]!] })
    } else if (head) out.push({ kind: 'h', lines: [head[1]!] })
    else if (prev?.kind === 'p' && prev.lines.length) prev.lines.push(line)
    else out.push({ kind: 'p', lines: [line] })
  }
  return out.filter((b) => b.lines.length)
}

export function Markdown({ text, className, onNavigate }: { text: string; className?: string; onNavigate?: () => void }) {
  return (
    <div className={cn('space-y-2 break-words text-sm leading-relaxed', className)}>
      {blocks(text).map((b, i) => {
        if (b.kind === 'h') return <p key={i} className="font-semibold">{inline(b.lines[0]!, onNavigate)}</p>
        if (b.kind === 'ul' || b.kind === 'ol') {
          const List = b.kind
          return (
            <List key={i} className={cn('space-y-1 pl-5', b.kind === 'ul' ? 'list-disc' : 'list-decimal')}>
              {b.lines.map((l, j) => (
                <li key={j}>{inline(l, onNavigate)}</li>
              ))}
            </List>
          )
        }
        return (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l, onNavigate)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
