import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import { ApiError } from '@/api/client'
import { AuthProvider } from '@/hooks/useAuth'
import { ThemeProvider, useTheme } from '@/hooks/useTheme'
import { router } from '@/routes/router'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Do not retry client errors such as 403/404; they will not change on retry.
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
})

function ThemedToaster() {
  const { resolved } = useTheme()
  return <Toaster position="bottom-right" richColors closeButton theme={resolved} toastOptions={{ duration: 3500 }} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <AuthProvider>
            <RouterProvider router={router} />
            <ThemedToaster />
          </AuthProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
