/**
 * Optional Sentry error tracking. Nothing is loaded unless VITE_SENTRY_DSN is set at build time: the SDK is
 * a separate chunk fetched lazily after start-up, so it never weighs on the main bundle.
 *
 * No personal data: sendDefaultPii is off, request bodies and cookies are dropped, Authorization headers and
 * token-like query parameters are scrubbed, and user context is never set.
 */
const SCRUB_QS = /((?:token|code|password|secret|key|signature)=)[^&#]*/gi

function scrubUrl(url: string | undefined) {
  return url ? url.replace(SCRUB_QS, '$1[Filtered]') : url
}

export function initErrorTracking() {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
  if (!dsn) return
  const start = () =>
    import('./sentryInit')
      .then((Sentry) => {
        Sentry.init({
          dsn,
          environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ?? import.meta.env.MODE,
          release: (import.meta.env.VITE_SENTRY_RELEASE as string | undefined) ?? 'signalcraft-frontend@0.1.0',
          sendDefaultPii: false,
          tracesSampleRate: 0,
          beforeSend(event) {
            if (event.request) {
              delete event.request.cookies
              delete event.request.data
              if (event.request.headers) {
                for (const h of Object.keys(event.request.headers)) {
                  if (/^(authorization|cookie)$/i.test(h)) event.request.headers[h] = '[Filtered]'
                }
              }
              event.request.url = scrubUrl(event.request.url)
              if (typeof event.request.query_string === 'string') event.request.query_string = scrubUrl(event.request.query_string)
            }
            delete event.user
            return event
          },
          beforeBreadcrumb(crumb) {
            // Keep navigation/request breadcrumbs but never their bodies or token query strings.
            if (crumb.data) {
              if (typeof crumb.data.url === 'string') crumb.data.url = scrubUrl(crumb.data.url)
              if (typeof crumb.data.to === 'string') crumb.data.to = scrubUrl(crumb.data.to)
              if (typeof crumb.data.from === 'string') crumb.data.from = scrubUrl(crumb.data.from)
            }
            if (crumb.category === 'ui.input') return null
            return crumb
          },
        })
        Sentry.setTag('service', 'frontend')
      })
      .catch(() => undefined)
  // Load after the app is interactive.
  if ('requestIdleCallback' in window) window.requestIdleCallback(() => void start())
  else setTimeout(() => void start(), 2000)
}
