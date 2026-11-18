/** Channel identity colours, the same wherever a channel is charted. Both sets pass the dataviz
 * palette validator (lightness band, chroma, colour-blind separation, contrast) against their surface.
 * Charts always pair them with a legend, so colour is never the only cue. */
const LIGHT: Record<string, string> = { email: '#2563eb', sms: '#059669', voice: '#9333ea', automation: '#d97706' }
const DARK: Record<string, string> = { email: '#3b82f6', sms: '#059669', voice: '#a855f7', automation: '#d97706' }

export const channelColors = (theme: 'light' | 'dark') => (theme === 'dark' ? DARK : LIGHT)
