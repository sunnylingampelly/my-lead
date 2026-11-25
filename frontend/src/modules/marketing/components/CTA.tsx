import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Aurora } from './Aurora'
import { CtaLink } from './Buttons'
import { Accent } from './GradientText'
import { Reveal } from './Reveal'

/** The closing call to action: a dark aurora panel with the sign-up button. */
export function CTA({
  title,
  lead = 'Every workspace starts in simulation mode, so you can try forms, chat, campaigns and AI calls before anything is sent for real.',
}: {
  title?: ReactNode
  lead?: string
}) {
  return (
    <section className="px-4 py-20 sm:px-6 sm:py-24">
      <Reveal className="mk-ink relative mx-auto max-w-6xl overflow-hidden rounded-[2.5rem] px-6 py-16 text-center sm:px-12 sm:py-24">
        <Aurora intensity={1.1} />
        <div className="relative">
          <h2 className="mx-auto max-w-3xl text-balance text-4xl font-semibold leading-[1.05] tracking-[-0.03em] sm:text-6xl">
            {title ?? (
              <>
                Your next customer is on your website <Accent tone="dark">right now.</Accent>
              </>
            )}
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-pretty text-lg text-white/65">{lead}</p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <CtaLink to="/register" variant="white" arrow>
              Create your free account
            </CtaLink>
            <CtaLink to="/pricing" variant="ghost-dark">
              See pricing
            </CtaLink>
          </div>
          <ul className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-white/55">
            {['No monthly fee on Starter', 'No card to sign up', 'Simulation mode included'].map((t) => (
              <li key={t} className="flex items-center gap-1.5">
                <Check className="size-4 text-indigo-300" aria-hidden /> {t}
              </li>
            ))}
          </ul>
        </div>
      </Reveal>
    </section>
  )
}
