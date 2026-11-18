/** Starter designs: table-based, inline-styled and responsive so they render in Gmail, Outlook and Apple Mail. */
const shell = (inner: string, accent = '#4f46e5') => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#111827">
<tr><td style="background:${accent};padding:20px 32px;color:#ffffff;font-size:18px;font-weight:bold">Your Brand</td></tr>
${inner}
</table></td></tr></table></body></html>`

const button = (label: string, href: string, color = '#4f46e5') =>
  `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:${color}"><a href="${href}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px">${label}</a></td></tr></table>`

export const STARTERS: { key: string; name: string; description: string; subject: string; preheader: string; html: string }[] = [
  {
    key: 'blank',
    name: 'Blank',
    description: 'A clean single column to build from.',
    subject: '',
    preheader: '',
    html: shell(`<tr><td style="padding:32px"><h1 style="margin:0 0 12px;font-size:24px">Hello {{first_name | default: "there"}},</h1>
<p style="margin:0;font-size:16px;line-height:24px;color:#374151">Start writing your message here.</p></td></tr>`),
  },
  {
    key: 'newsletter',
    name: 'Newsletter',
    description: 'Headline, two stories and a call to action.',
    subject: 'This month at Your Brand',
    preheader: 'Highlights, new arrivals and what is coming next',
    html: shell(`<tr><td style="padding:32px 32px 8px"><h1 style="margin:0 0 8px;font-size:26px">Hi {{first_name | default: "there"}}, here is what's new</h1>
<p style="margin:0;font-size:16px;line-height:24px;color:#374151">A quick round-up of the stories our customers in {{city | default: "your city"}} enjoyed most this month.</p></td></tr>
<tr><td style="padding:16px 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td width="50%" valign="top" style="padding-right:8px"><h3 style="margin:0 0 6px;font-size:17px">Story one</h3><p style="margin:0;font-size:14px;line-height:21px;color:#4b5563">A short summary that makes people want to read more.</p><p style="margin:8px 0 0"><a href="https://example.com/story-1" style="color:#4f46e5;font-weight:bold;text-decoration:none">Read more →</a></p></td>
<td width="50%" valign="top" style="padding-left:8px"><h3 style="margin:0 0 6px;font-size:17px">Story two</h3><p style="margin:0;font-size:14px;line-height:21px;color:#4b5563">Another highlight with a clear reason to click.</p><p style="margin:8px 0 0"><a href="https://example.com/story-2" style="color:#4f46e5;font-weight:bold;text-decoration:none">Read more →</a></p></td>
</tr></table></td></tr>
<tr><td style="padding:16px 32px 32px">${button('Visit the blog', 'https://example.com/blog')}</td></tr>`),
  },
  {
    key: 'promotion',
    name: 'Promotion',
    description: 'Bold offer with a code and a single button.',
    subject: '{{first_name | default: "Hey"}}, 30% off ends Sunday',
    preheader: 'Use code FESTIVE30 at checkout',
    html: shell(`<tr><td align="center" style="padding:40px 32px 16px"><p style="margin:0 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#e11d48;font-weight:bold">Festive sale</p>
<h1 style="margin:0 0 12px;font-size:36px;line-height:42px">30% off everything</h1>
<p style="margin:0 0 24px;font-size:16px;line-height:24px;color:#374151">For {{first_name | default: "you"}} and everyone at {{company | default: "home"}}. Ends Sunday midnight.</p>
<p style="margin:0 0 24px;display:inline-block;padding:10px 18px;border:2px dashed #e11d48;border-radius:8px;font-size:20px;font-weight:bold;letter-spacing:2px">FESTIVE30</p>
${button('Shop the sale', 'https://example.com/sale', '#e11d48')}</td></tr>
<tr><td style="padding:16px 32px 32px;font-size:12px;color:#6b7280" align="center">Offer valid on full-price items while stocks last.</td></tr>`, '#e11d48'),
  },
  {
    key: 'announcement',
    name: 'Announcement',
    description: 'A product update or important notice.',
    subject: 'Something new for {{company | default: "you"}}',
    preheader: 'We have been working on this for a while',
    html: shell(`<tr><td style="padding:32px"><h1 style="margin:0 0 12px;font-size:26px">Introducing our new app</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#374151">Hi {{first_name | default: "there"}}, track orders, manage subscriptions and get support in one place.</p>
<ul style="margin:0 0 24px;padding-left:20px;font-size:15px;line-height:24px;color:#374151"><li>Real-time order tracking</li><li>One-tap reorders</li><li>Support in English and Hindi</li></ul>
${button('Learn more', 'https://example.com/app', '#059669')}</td></tr>`, '#059669'),
  },
]
