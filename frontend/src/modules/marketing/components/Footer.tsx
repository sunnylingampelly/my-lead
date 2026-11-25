import { Link } from 'react-router-dom'
import { FileCheck2, KeyRound, Moon, PhoneCall, ReceiptIndianRupee, ShieldCheck, Sun, UserRoundCheck } from 'lucide-react'
import { Logo } from '@/components/logo'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/hooks/useTheme'
import { PRODUCTS } from '../products'
import { useHomePath } from '../useHomePath'

const BADGES = [
  { icon: ShieldCheck, label: 'TRAI DLT' },
  { icon: PhoneCall, label: 'TCPA windows' },
  { icon: ShieldCheck, label: 'UAE TDRA & PDPL' },
  { icon: FileCheck2, label: 'Consent evidence' },
  { icon: UserRoundCheck, label: 'DPDP & GDPR' },
  { icon: ReceiptIndianRupee, label: 'GST invoices' },
  { icon: KeyRound, label: 'Two-factor sign-in' },
]

function Column({ title, links }: { title: string; links: { to: string; label: string }[] }) {
  return (
    <div>
      <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-white/40">{title}</h2>
      <ul className="mt-4 space-y-2.5">
        {links.map((l) => (
          <li key={l.to}>
            <Link to={l.to} className="text-sm text-white/65 transition hover:text-white">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Footer() {
  const { status } = useAuth()
  const { resolved, toggle } = useTheme()
  const home = useHomePath()
  const account =
    status === 'authenticated'
      ? [{ to: '/', label: 'Open workspace' }]
      : [
          { to: '/login', label: 'Sign in' },
          { to: '/register', label: 'Create account' },
        ]
  return (
    <footer className="mk-ink relative overflow-hidden px-4 pb-10 pt-20 sm:px-6">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-400/40 to-transparent" aria-hidden />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[60rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(79_70_229/0.18),transparent)]" aria-hidden />
      <div className="relative mx-auto max-w-6xl">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="col-span-2 md:col-span-1">
            <Logo inverted />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/55">
              Lead capture, multichannel follow-up and CRM for growing businesses in India, the UAE and the US.
            </p>
            <button
              type="button"
              onClick={toggle}
              className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/60 transition hover:bg-white/5 hover:text-white"
            >
              {resolved === 'dark' ? <Sun className="size-3.5" aria-hidden /> : <Moon className="size-3.5" aria-hidden />}
              {resolved === 'dark' ? 'Light page theme' : 'Dark page theme'}
            </button>
          </div>
          <Column title="Products" links={PRODUCTS.slice(0, 4).map((p) => ({ to: `/products/${p.slug}`, label: p.name }))} />
          <Column title="More products" links={PRODUCTS.slice(4).map((p) => ({ to: `/products/${p.slug}`, label: p.name }))} />
          <Column
            title="Signalcraft"
            links={[{ to: '/pricing', label: 'Pricing' }, { to: `${home}#flow`, label: 'How a lead flows' }, { to: `${home}#faq`, label: 'FAQ' }, ...account]}
          />
        </div>
        <ul className="mt-14 flex flex-wrap gap-2 border-t border-white/[0.08] pt-8" aria-label="Compliance built in">
          {BADGES.map(({ icon: Icon, label }) => (
            <li key={label} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-white/60">
              <Icon className="size-3.5 text-indigo-300" aria-hidden /> {label}
            </li>
          ))}
        </ul>
        <div className="mt-8 flex flex-col gap-2 text-xs text-white/40 sm:flex-row sm:justify-between">
          <span>© {new Date().getFullYear()} Signalcraft. All rights reserved.</span>
          <span>Built for India, the UAE and the US.</span>
        </div>
      </div>
    </footer>
  )
}
