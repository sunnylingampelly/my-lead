import { useEffect, useRef } from 'react'
import grapesjs, { type Editor } from 'grapesjs'
import newsletter from 'grapesjs-preset-newsletter'
import 'grapesjs/dist/css/grapes.min.css'
import './grapes-theme.css'

export interface VisualValue {
  design: Record<string, unknown> | null
  html: string
}

/**
 * Drag-and-drop email builder (GrapesJS with the newsletter preset). The editor owns its state;
 * we read the project data and inlined HTML on every change and hand them to the parent.
 */
export function VisualEditor({
  initialDesign,
  initialHtml,
  onChange,
}: {
  initialDesign: Record<string, unknown> | null
  initialHtml: string | null
  onChange: (v: VisualValue) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const cb = useRef(onChange)
  cb.current = onChange

  useEffect(() => {
    if (!ref.current) return
    const bodyMatch = initialHtml?.match(/<body[^>]*>([\s\S]*)<\/body>/i)
    const editor = grapesjs.init({
      container: ref.current,
      height: '100%',
      width: 'auto',
      fromElement: false,
      storageManager: false,
      plugins: [(ed) => newsletter(ed, { modalTitleImport: 'Import HTML' })],
      ...(initialDesign && Object.keys(initialDesign).length
        ? { projectData: initialDesign }
        : { components: bodyMatch ? bodyMatch[1] : initialHtml || '<table style="width:100%"><tr><td style="padding:24px;font-family:Arial">Drag blocks here</td></tr></table>' }),
    })
    editorRef.current = editor

    let timer: number | undefined
    const emit = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        let inner = ''
        try {
          inner = editor.runCommand('gjs-get-inlined-html') as string
        } catch {
          inner = `${editor.getHtml()}<style>${editor.getCss()}</style>`
        }
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0">${inner}</body></html>`
        cb.current({ design: editor.getProjectData() as Record<string, unknown>, html })
      }, 500)
    }
    editor.on('update', emit)
    editor.on('load', emit)
    return () => {
      window.clearTimeout(timer)
      editor.destroy()
      editorRef.current = null
    }
    // The editor is initialised once; parent re-renders must not reset the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="sc-grapes h-full min-h-[640px] overflow-hidden rounded-lg border" ref={ref} />
}
