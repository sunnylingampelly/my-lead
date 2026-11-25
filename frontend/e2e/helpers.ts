import { expect, type Page } from '@playwright/test'

export const PASSWORD = 'E2eSecretPass1'

export function uniqueEmail(prefix: string) {
  return `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`
}

/** Read the newest link to `path` from the simulated mailbox for `email`. */
export async function linkFromMailbox(page: Page, email: string, path: string): Promise<string> {
  let link: string | undefined
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/v1/dev/mailbox?to=${encodeURIComponent(email)}`)
      const body = (await res.json()) as { items: { text: string }[] }
      for (const m of body.items) {
        const match = m.text.match(new RegExp(`https?://[^\\s]+${path.replace('/', '\\/')}\\?token=[^\\s]+`))
        if (match) {
          link = match[0]
          return true
        }
      }
      return false
    })
    .toBe(true)
  const url = new URL(link!)
  return url.pathname + url.search
}

export async function registerAndVerify(page: Page, name: string, email: string) {
  await page.goto('/register')
  await page.getByLabel('Full name').fill(name)
  await page.getByLabel('Work email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  await page.goto(await linkFromMailbox(page, email, '/verify-email'))
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible()
  await page.getByRole('link', { name: 'Continue setup' }).click()
}

export async function createOrgAndApp(page: Page, orgName: string, appName: string, market: 'IN' | 'AE' | 'US' = 'IN') {
  await expect(page.getByRole('heading', { name: 'Set up your organization' })).toBeVisible()
  await page.getByLabel('Organization name').fill(orgName)
  await page.getByLabel('Primary market').selectOption(market)
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Create your first application' })).toBeVisible()
  await page.getByLabel('Application name').fill(appName)
  await page.getByRole('button', { name: 'Create application' }).click()
  await expect(page.getByText(`Here's what's happening in ${appName}.`)).toBeVisible()
}

/** Click a sidebar link; expands its group (Audience, Email, SMS, Voice, CRM) first when the link lives inside it. */
export async function navTo(page: Page, name: string) {
  const nav = page.getByRole('navigation', { name: 'Main' })
  const link = nav.getByRole('link', { name, exact: true })
  for (const group of ['Audience', 'Email', 'SMS', 'Voice', 'CRM']) {
    if (await link.isVisible()) break
    const toggle = nav.getByRole('button', { name: `Show ${group} pages` })
    if (await toggle.isVisible()) await toggle.click()
  }
  await link.click()
}
