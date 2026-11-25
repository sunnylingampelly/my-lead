import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_PROXY_TARGET || 'http://127.0.0.1:8010'
  return {
    plugins: [react()],
    resolve: { alias: { '@': path.resolve(__dirname, './src') } },
    build: {
      rollupOptions: {
        output: {
          // Heavy libraries get their own long-cached chunks, loaded only by the pages that use them.
          manualChunks(id) {
            // React and the CommonJS interop helpers are shared by everything: pin them to one vendor chunk,
            // otherwise Rollup folds them into the first manual chunk that needs them and the entry then
            // imports (and preloads) the charts / flow chunks on every page.
            if (id.includes('commonjsHelpers')) return 'vendor'
            if (!id.includes('node_modules')) return undefined
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-is|use-sync-external-store|clsx)[\\/]/.test(id)) return 'vendor'
            if (/[\\/]node_modules[\\/](@xyflow|d3-zoom|d3-drag|d3-selection|d3-transition)[\\/]/.test(id)) return 'flow'
            if (/[\\/]node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor|internmap|decimal\.js-light)[\\/]/.test(id)) return 'charts'
            if (/[\\/]node_modules[\\/](grapesjs|grapesjs-preset-newsletter)[\\/]/.test(id)) return 'editor'
            // Animation library: only the public marketing site uses it.
            if (/[\\/]node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/.test(id)) return 'motion'
            return undefined
          },
        },
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      // Same-origin API keeps the httpOnly refresh cookie first-party.
      proxy: {
        '/api': { target, changeOrigin: false },
        '/docs': { target },
        // Embeds (lead forms, chat widget) are served by the backend.
        '/embed': { target },
      },
    },
  }
})
