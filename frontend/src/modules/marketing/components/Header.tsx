import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, Menu, Receipt, Route, X } from 'lucide-react'
import { Logo } from '@/components/logo'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import { PRODUCTS } from '../products'
import { useHomePath } from '../useHomePath'
import { CtaLink } from './Buttons'

const PANEL_ID = 'mk-products-panel'

/** "Soon" pill for products that aren't available yet (SMS). */
function SoonTag() {
  return (
    <span className="rounded-full bg-amber-400/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-200" data-testid="soon-tag">
      Soon
    </span>
  )
}

/** The Products mega-menu: opens on hover or click, arrow keys move between items, Escape closes. */
function ProductsMenu() {
  const [open, setOpen] = useState(false)
  const home = useHomePath()
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const { pathname } = useLocation()

  useEffect(() => setOpen(false), [pathname])
  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  const hoverOpen = () => {
    window.clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const hoverClose = () => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 140)
  }

  const items = () => Array.from(panel.current?.querySelectorAll<HTMLAnchorElement>('a[data-menu-item]') ?? [])
  const focusItem = (i: number) => {
    const list = items()
    list[(i + list.length) % list.length]?.focus()
  }

  function onButtonKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      requestAnimationFrame(() => requestAnimationFrame(() => focusItem(0)))
    } else if (e.key === 'Escape') setOpen(false)
  }

  function onPanelKey(e: KeyboardEvent) {
    const list = items()
    const i = list.indexOf(document.activeElement as HTMLAnchorElement)
    const cols = window.matchMedia('(min-width: 1024px)').matches ? 2 : 1
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      btn.current?.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusItem(i + cols)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (i - cols < 0) btn.current?.focus()
      else focusItem(i - cols)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      focusItem(i + 1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      focusItem(i - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusItem(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusItem(list.length - 1)
    }
  }

  return (
    <div
      className="relative"
      onMouseEnter={hoverOpen}
      onMouseLeave={hoverClose}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={(e) => {
          // With a mouse, hovering already opened the menu, so a click must not toggle it shut again.
          // Keyboard (detail 0) and touch (no hover) still toggle.
          const mouseWithHover = e.detail > 0 && window.matchMedia('(hover: hover)').matches
          setOpen((o) => (mouseWithHover ? true : !o))
        }}
        onKeyDown={onButtonKey}
        className={cn('flex items-center gap-1 rounded-full px-3.5 py-2 text-sm font-medium transition', open ? 'bg-white/10 text-white' : 'text-white/70 hover:text-white')}
      >
        Products
        <ChevronDown className={cn('size-3.5 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panel}
            id={PANEL_ID}
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            onKeyDown={onPanelKey}
            style={{ x: '-50%' }}
            className="fixed left-1/2 top-[76px] w-[min(940px,calc(100vw-32px))] pt-2"
          >
            <div className="grid grid-cols-1 overflow-hidden rounded-3xl border border-white/10 bg-[#11111b] shadow-[0_40px_120px_-20px_rgb(0_0_0/0.8)] backdrop-blur-2xl lg:grid-cols-[1fr_260px]">
              <nav aria-label="Products menu" className="p-3">
                <ul className="grid grid-cols-1 gap-1 lg:grid-cols-2">
                  {PRODUCTS.map((p) => (
                    <li key={p.slug} className={p.slug === 'ai-team' ? 'lg:col-span-2' : undefined}>
                      <Link
                        data-menu-item
                        to={`/products/${p.slug}`}
                        className="group flex items-start gap-3 rounded-2xl p-3 outline-none transition hover:bg-white/[0.06] focus-visible:bg-white/[0.08] focus-visible:ring-1 focus-visible:ring-indigo-400/60 focus-visible:ring-offset-0"
                      >
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.08] to-transparent text-indigo-200 transition group-hover:border-indigo-400/40 group-hover:text-white">
                          <p.icon className="size-[18px]" aria-hidden />
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 text-sm font-medium text-white">
                            {p.name}
                            {p.soon && <SoonTag />}
                          </span>
                          <span className="mt-0.5 block text-[13px] leading-snug text-white/50">{p.line}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="relative hidden flex-col gap-2 overflow-hidden border-l border-white/[0.07] bg-gradient-to-b from-indigo-500/[0.12] to-violet-500/[0.04] p-5 lg:flex">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-indigo-200/80">One workspace</p>
                <p className="text-sm leading-relaxed text-white/70">Nine tools sharing one contact record, one wallet and one timeline.</p>
                <Link data-menu-item to={`${home}#flow`} className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-sm text-white/90 transition hover:bg-white/[0.08]">
                  <Route className="size-4 text-indigo-300" aria-hidden /> How a lead flows
                </Link>
                <Link data-menu-item to="/pricing" className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-sm text-white/90 transition hover:bg-white/[0.08]">
                  <Receipt className="size-4 text-indigo-300" aria-hidden /> Pricing and calculator
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Full-screen menu for phones. */
function MobileSheet({ onClose, signedIn }: { onClose: () => void; signedIn: boolean }) {
  const closeBtn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeBtn.current?.focus()
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return createPortal(
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="mk-ink pointer-events-auto fixed inset-0 z-[70] flex flex-col overflow-y-auto"
    >
      <div className="flex h-16 shrink-0 items-center justify-between px-4">
        <Link to="/" onClick={onClose} aria-label="Signalcraft home">
          <Logo inverted />
        </Link>
        <button ref={closeBtn} type="button" onClick={onClose} aria-label="Close menu" className="flex size-10 items-center justify-center rounded-full text-white hover:bg-white/10">
          <X className="size-5" aria-hidden />
        </button>
      </div>
      <motion.nav
        aria-label="Mobile"
        className="flex-1 px-4 pb-6"
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.03 } } }}
      >
        <p className="px-2 pb-2 pt-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/40">Products</p>
        <ul className="grid grid-cols-1 gap-0.5">
          {PRODUCTS.map((p) => (
            <motion.li key={p.slug} variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}>
              <Link to={`/products/${p.slug}`} onClick={onClose} className="flex items-center gap-3 rounded-2xl px-2 py-2.5 hover:bg-white/[0.06]">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-indigo-200">
                  <p.icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-[15px] font-medium text-white">
                    {p.name}
                    {p.soon && <SoonTag />}
                  </span>
                  <span className="block truncate text-xs text-white/45">{p.line}</span>
                </span>
              </Link>
            </motion.li>
          ))}
        </ul>
        <div className="my-4 h-px bg-white/10" />
        <Link to="/pricing" onClick={onClose} className="block rounded-2xl px-2 py-3 text-lg font-medium text-white hover:bg-white/[0.06]">
          Pricing
        </Link>
        {!signedIn && (
          <Link to="/login" onClick={onClose} className="block rounded-2xl px-2 py-3 text-lg font-medium text-white hover:bg-white/[0.06]">
            Sign in
          </Link>
        )}
      </motion.nav>
      <div className="sticky bottom-0 border-t border-white/10 bg-[#0b0b14]/90 p-4 backdrop-blur">
        <CtaLink to={signedIn ? '/' : '/register'} arrow className="w-full">
          {signedIn ? 'Open workspace' : 'Start free'}
        </CtaLink>
      </div>
    </motion.div>,
    document.body,
  )
}

export function Header() {
  const { status } = useAuth()
  const signedIn = status === 'authenticated'
  const [scrolled, setScrolled] = useState(false)
  const [mobile, setMobile] = useState(false)
  const { pathname } = useLocation()
  const closeMobile = useCallback(() => setMobile(false), [])

  useEffect(() => setMobile(false), [pathname])
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])

  return (
    // A floating glass pill: inset from the edges, it tightens and gains depth once the page scrolls.
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 px-3 pt-3 text-white sm:px-4 sm:pt-4">
      <motion.nav
        aria-label="Main"
        initial={{ y: -24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          'pointer-events-auto relative mx-auto flex items-center gap-2 rounded-full border pl-4 pr-2 transition-[max-width,height,background-color,box-shadow,border-color] duration-500 ease-out sm:pl-5',
          scrolled
            ? 'h-14 max-w-4xl border-white/[0.12] bg-[#0b0b14]/75 shadow-[0_12px_40px_-12px_rgba(8,8,20,0.65),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl backdrop-saturate-150'
            : 'h-16 max-w-6xl border-white/[0.09] bg-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-md',
        )}
      >
        {/* A thin highlight along the top edge, like light catching glass. */}
        <span aria-hidden className="pointer-events-none absolute inset-x-10 -top-px h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />
        <Link to="/" aria-label="Signalcraft home" className="mr-4 rounded-md">
          <Logo inverted />
        </Link>
        <div className="hidden items-center gap-1 md:flex">
          <ProductsMenu />
          <Link to="/pricing" className={cn('rounded-full px-3.5 py-2 text-sm font-medium transition', pathname === '/pricing' ? 'text-white' : 'text-white/70 hover:text-white')}>
            Pricing
          </Link>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {signedIn ? (
            <CtaLink to="/" size="md" variant="white" arrow className="hidden sm:inline-flex">
              Open workspace
            </CtaLink>
          ) : (
            <>
              <Link to="/login" className="hidden rounded-full px-3.5 py-2 text-sm font-medium text-white/80 transition hover:text-white sm:block">
                Sign in
              </Link>
              <CtaLink to="/register" size="md" variant="white" arrow>
                Start free
              </CtaLink>
            </>
          )}
          <button
            type="button"
            onClick={() => setMobile(true)}
            aria-label="Open menu"
            aria-expanded={mobile}
            className="flex size-10 items-center justify-center rounded-full text-white hover:bg-white/10 md:hidden"
          >
            <Menu className="size-5" aria-hidden />
          </button>
        </div>
      </motion.nav>
      <AnimatePresence>{mobile && <MobileSheet onClose={closeMobile} signedIn={signedIn} />}</AnimatePresence>
    </header>
  )
}
