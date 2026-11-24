import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests drive the real frontend against the real API (simulation mode).
 * Start both first: the backend on 127.0.0.1:8010 and `npm run dev` on 5173,
 * or set E2E_BASE_URL to another environment.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Browsers run one by one so tests that share seeded accounts don't interfere.
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
