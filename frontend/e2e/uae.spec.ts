import { expect, test } from '@playwright/test'
import { createOrgAndApp, registerAndVerify, uniqueEmail } from './helpers'

// United Arab Emirates: AED wallet, TRN-only sales (reverse charge), SMS and calls "coming soon",
// Arabic in the chatbot renders right to left, and AED on the marketing pricing page.

test('UAE organization: AED wallet, TRN required, SMS and voice coming soon', async ({ page }) => {
  test.setTimeout(120_000)
  await registerAndVerify(page, 'Omar Haddad', uniqueEmail('uae'))
  await createOrgAndApp(page, 'Falcon Trading', 'Falcon Dubai', 'AE')
  const appId = new URL(page.url()).pathname.split('/')[2]!
  const base = `/apps/${appId}`

  // The app defaults to the UAE time zone (shown under the app name in the sidebar).
  await expect(page.getByRole('navigation', { name: 'Main' }).locator('..').getByText('Asia/Dubai').first()).toBeVisible()

  // AED wallet.
  const orgUrl = await page.evaluate(async () => {
    const tok = (await (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })).json()).access_token
    const orgs = await (await fetch('/api/v1/organizations', { headers: { Authorization: `Bearer ${tok}` } })).json()
    return `/orgs/${(Array.isArray(orgs) ? orgs : orgs.items)[0].id}/billing`
  })
  await page.waitForLoadState('networkidle')
  await page.goto(orgUrl)
  await expect(page.getByTestId('wallet-kpis')).toContainText('AED wallet')
  await expect(page.getByTestId('wallet-kpis')).toContainText(/AED/)
  await expect(page.getByTestId('plan-price-pro')).toContainText(/AED\s?179/)

  // Billing details demand a TRN (15 digits, starting with 100) and an emirate.
  await expect(page.getByTestId('billing-details-prompt')).toContainText('TRN')
  await page.getByTestId('tab-billing-details').click()
  const details = page.getByTestId('billing-details')
  await expect(details.getByTestId('trn-required')).toBeVisible()
  await expect(details.getByLabel(/TRN/)).toBeVisible()
  await expect(details.getByLabel('GSTIN (optional)')).toHaveCount(0)
  await details.getByLabel('Legal name').fill('Falcon Trading LLC')
  await details.getByLabel('Email for invoices').fill('accounts@falcon.example')
  await details.getByLabel('Billing address').fill('Office 1201, Bay Square, Business Bay')
  await details.getByLabel(/TRN/).fill('200123456700003')
  await details.getByLabel('Emirate').selectOption('Dubai')
  await page.getByTestId('bd-save').click()
  await expect(details).toContainText('starts with 100')
  await details.getByLabel(/TRN/).fill('100123456700003')
  await page.getByTestId('bd-save').click()
  await expect(page.getByText('Billing details saved')).toBeVisible()
  await expect(details.getByTestId('trn-required')).toHaveCount(0)

  // Prices table includes the UAE; SMS prices read "Coming soon".
  await expect(page.getByText('United Arab Emirates').first()).toBeVisible()

  // SMS: coming soon (every market).
  await page.goto(`${base}/sms`)
  await expect(page.getByTestId('sms-coming-soon')).toContainText('SMS is coming soon')
  await expect(page.getByTestId('sms-coming-soon')).toContainText('UAE')

  // Voice: coming soon for the UAE, with the reason and the rules that will apply.
  await page.goto(`${base}/voice`)
  const voice = page.getByTestId('voice-uae-coming-soon')
  await expect(voice).toContainText('Coming soon for the UAE')
  await expect(voice).toContainText('own licensed UAE number')
  await expect(voice).toContainText('09:00–18:00')
  await expect(voice).toContainText('Do Not Call Registry')
  await expect(page.getByRole('button', { name: /New campaign/ })).toHaveCount(0)
  await page.goto(`${base}/voice/campaigns`)
  await expect(page.getByTestId('voice-uae-banner')).toContainText('Coming soon for the UAE')
})

test('chatbot test chat: Arabic input renders right to left', async ({ page }) => {
  test.setTimeout(120_000)
  await registerAndVerify(page, 'Layla Arabic', uniqueEmail('uae-chat'))
  await createOrgAndApp(page, 'Falcon Chat', 'Falcon Web', 'AE')
  const appId = new URL(page.url()).pathname.split('/')[2]!
  await page.goto(`/apps/${appId}/chat/bots`)
  await page.getByTestId('new-bot').click()
  await page.getByRole('radio', { name: /Website assistant/ }).click()
  await page.getByLabel('Name').fill('Falcon Helper')
  await page.getByLabel('Website').fill('https://www.falcon.example/contact')
  await page.getByTestId('create-bot').click()
  await expect(page.getByRole('heading', { name: 'Falcon Helper' })).toBeVisible()

  // The language picker (Behaviour tab) offers Arabic.
  await page.getByRole('tab', { name: 'Behaviour' }).click()
  await expect(page.locator('#b-lang option[value="ar"]')).toHaveText('Arabic')
  await page.getByRole('tab', { name: 'Training' }).click()

  const question = 'ما هي ساعات العمل؟'
  await page.getByTestId('test-input').fill(question)
  await expect(page.getByTestId('test-input')).toHaveAttribute('dir', 'auto')
  await page.getByTestId('test-input').press('Enter')
  const mine = page.getByTestId('test-user-message').last()
  await expect(mine).toHaveText(question)
  await expect(mine).toHaveAttribute('dir', 'auto')
  expect(await mine.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl')
  await expect(page.getByTestId('test-reply').first()).toBeVisible({ timeout: 60_000 })
})

test('marketing pricing: the currency toggle shows AED 179', async ({ page }) => {
  await page.goto('/pricing')
  await page.getByRole('radio', { name: 'AED' }).click()
  await expect(page.getByTestId('plan-pro')).toContainText(/AED\s179/)
})
