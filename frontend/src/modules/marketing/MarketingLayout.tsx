/**
 * The public marketing site's shell: glass header with the Products mega-menu, footer, scroll handling
 * and reduced-motion support. Loaded as its own chunk; it never pulls in the app shell.
 */
import { Suspense, useEffect, type ReactNode } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import './marketing.css'

/** Scroll to the top on a new page, or to the #hash target once it has rendered. */
function ScrollManager() {
  const { pathname, hash } = useLocation()
  useEffect(() => {
    if (!hash) {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior })
      return
    }
    let tries = 0
    let raf = 0
    const find = () => {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)))
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      else if (tries++ < 60) raf = requestAnimationFrame(find)
    }
    find()
    return () => cancelAnimationFrame(raf)
  }, [pathname, hash])
  return null
}

function PageFallback() {
  return <div className="mk-ink min-h-[80vh]" aria-busy="true" />
}

export function MarketingLayout({ children }: { children?: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-full flex-col overflow-x-clip bg-background text-foreground">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[#0b0b14]"
        >
          Skip to content
        </a>
        <ScrollManager />
        <Header />
        <main id="main" className="flex-1">
          <Suspense fallback={<PageFallback />}>{children ?? <Outlet />}</Suspense>
        </main>
        <Footer />
      </div>
    </MotionConfig>
  )
}
