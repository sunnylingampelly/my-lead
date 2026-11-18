import type { ReactNode } from 'react'
import { Mail, MessageSquare, Moon, PhoneCall, Sun } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { Logo } from '@/components/logo'

/** Split layout used by sign-in, registration and onboarding screens. */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  const { resolved, toggle } = useTheme()
  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_minmax(0,560px)]">
      <aside className="relative hidden overflow-hidden bg-sidebar p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <Logo inverted />
        <div className="relative z-10 max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            One audience. Every channel. Measured honestly.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-sidebar-muted">
            Organize contacts per application, then reach them by email, SMS and voice with consent checks, delivery
            tracking and spend controls built in.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-sidebar-foreground">
            {[
              { icon: Mail, text: 'Email campaigns with real delivery and engagement tracking' },
              { icon: MessageSquare, text: 'SMS with DLT-ready templates and delivery receipts' },
              { icon: PhoneCall, text: 'Voice broadcasts with calling windows and retries' },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <span className="flex size-8 items-center justify-center rounded-md bg-sidebar-accent">
                  <Icon className="size-4 text-indigo-300" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-sidebar-muted">Simulation mode is on by default. Nothing is sent until you connect a provider.</p>
        <div className="pointer-events-none absolute -right-32 top-1/3 size-[420px] rounded-full bg-indigo-600/20 blur-3xl" />
      </aside>
      <main className="relative flex items-center justify-center px-4 py-12 sm:px-10">
        <button
          onClick={toggle}
          className="absolute right-4 top-4 rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="Toggle theme"
        >
          {resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
        <div className="w-full max-w-sm">
          <Logo className="mb-10 lg:hidden" />
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  )
}
