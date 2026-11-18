import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom'
import { AlertOctagon, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** Friendly fallback for unexpected rendering errors anywhere in the route tree. */
export function RouteError() {
  const error = useRouteError()
  const notFound = isRouteErrorResponse(error) && error.status === 404
  const detail = error instanceof Error ? error.message : isRouteErrorResponse(error) ? error.statusText : String(error)
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger-strong">
        <AlertOctagon className="size-6" />
      </span>
      <h1 className="text-xl font-semibold tracking-tight">{notFound ? 'Page not found' : 'Something went wrong'}</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {notFound ? "The page you're looking for doesn't exist." : 'This screen hit an unexpected error. Your data is safe. Reload to try again.'}
      </p>
      {!notFound && import.meta.env.DEV && <code className="max-w-lg truncate rounded bg-muted px-2 py-1 text-xs text-muted-foreground">{detail}</code>}
      <div className="mt-2 flex gap-2">
        <Button variant="outline" onClick={() => window.location.reload()}>
          <RotateCw /> Reload
        </Button>
        <Button asChild>
          <Link to="/">Go to workspace</Link>
        </Button>
      </div>
    </div>
  )
}
