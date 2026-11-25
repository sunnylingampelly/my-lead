/** Design tab: theme, colours, font, corners, button and layout. */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Select } from '@/components/ui/form-controls'
import { FONTS, type FormDesign } from '@/types/forms'
import { type TabProps } from './meta'
import { PreviewPane } from './PreviewPane'
import { ColorField, RequiredText, Segmented, Switch } from './ui'

const THEMES: Record<'light' | 'dark', Partial<FormDesign>> = {
  light: { theme: 'light', background_color: '#ffffff', text_color: '#0f172a' },
  dark: { theme: 'dark', background_color: '#0f172a', text_color: '#f8fafc' },
}

export function DesignTab({ def, patch, meta, write }: TabProps) {
  const d = def.design
  const set = (p: Partial<FormDesign>) => patch({ design: { ...d, ...p } })
  const fonts = meta?.fonts?.length ? meta.fonts : [...FONTS]
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
      <fieldset disabled={!write} className="min-w-0 space-y-4">
        <legend className="sr-only">Design</legend>
        <Card>
          <CardHeader>
            <CardTitle>Theme & colours</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <span className="block text-sm font-medium">Theme</span>
              <Segmented
                label="Theme"
                value={d.theme}
                onChange={(v) => set(THEMES[v])}
                options={[
                  ['light', 'Light'],
                  ['dark', 'Dark'],
                ]}
              />
              <p className="text-xs text-muted-foreground">Switching theme resets the background and text colours.</p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <ColorField id="d-primary" label="Accent" value={d.primary_color} onChange={(v) => set({ primary_color: v })} />
              <ColorField id="d-bg" label="Background" value={d.background_color} onChange={(v) => set({ background_color: v })} />
              <ColorField id="d-text" label="Text" value={d.text_color} onChange={(v) => set({ text_color: v })} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Typography & shape</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Switch id="d-sitefont" label="Use my website’s font" hint="The form inherits the font of the page it is embedded on (inline and pop-up embeds)." checked={d.use_site_font} onChange={(v) => set({ use_site_font: v })} />
            <Field label="Font" htmlFor="d-font">
              <Select id="d-font" value={d.font} disabled={d.use_site_font || !write} onChange={(e) => set({ font: e.target.value })}>
                {fonts.map((f) => (
                  <option key={f} value={f}>
                    {f === 'system' ? 'System default' : f}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Corner radius: ${d.radius}px`} htmlFor="d-radius">
              <input id="d-radius" type="range" min={0} max={24} value={d.radius} onChange={(e) => set({ radius: Number(e.target.value) })} className="w-full accent-[hsl(var(--primary))]" />
            </Field>
            <div className="space-y-1.5">
              <span className="block text-sm font-medium">Labels</span>
              <Segmented
                label="Label position"
                value={d.label_position}
                onChange={(v) => set({ label_position: v })}
                options={[
                  ['top', 'Above'],
                  ['left', 'Beside'],
                  ['hidden', 'Hidden'],
                ]}
              />
              <p className="text-xs text-muted-foreground">Hidden labels become placeholders and stay available to screen readers. “Beside” stacks on phones.</p>
            </div>
            <Field label={`Maximum width: ${d.max_width}px`} htmlFor="d-width">
              <input id="d-width" type="range" min={280} max={1000} step={10} value={d.max_width} onChange={(e) => set({ max_width: Number(e.target.value) })} className="w-full accent-[hsl(var(--primary))]" />
            </Field>
            <Switch id="d-title" label="Show title and description" checked={d.show_title} onChange={(v) => set({ show_title: v })} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Submit button</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Button text" htmlFor="d-btn">
              <RequiredText id="d-btn" value={d.button_text} maxLength={60} onChange={(v) => set({ button_text: v })} />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <ColorField id="d-btn-bg" label="Button colour" value={d.button_color} onChange={(v) => set({ button_color: v })} />
              <ColorField id="d-btn-fg" label="Button text colour" value={d.button_text_color} onChange={(v) => set({ button_text_color: v })} />
            </div>
          </CardContent>
        </Card>
      </fieldset>
      <PreviewPane def={def} meta={meta} />
    </div>
  )
}
