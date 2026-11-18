import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_PROXY_TARGET || 'http://127.0.0.1:8010'
  return {
    plugins: [react()],
    resolve: { alias: { '@': path.resolve(__dirname, './src') } },
    server: {
      port: 5173,
      strictPort: true,
      // Same-origin API keeps the httpOnly refresh cookie first-party.
      proxy: {
        '/api': { target, changeOrigin: false },
        '/docs': { target },
      },
    },
  }
})
