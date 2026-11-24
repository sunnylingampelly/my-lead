import { expect, type Page, test } from '@playwright/test'
import { createOrgAndApp, navTo, registerAndVerify, uniqueEmail } from './helpers'

const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true })
}

test('wallet with trial credit, test top-up, ledger, and analytics with export', async ({ page }) => {
  test.setTimeout(120_000)
  await registerAndVerify(page, 'Bina Billing', uniqueEmail('bill'))
  await createOrgAndApp(page, 'Chai Wallet', 'Chai Billing')

  // The organization wallet starts with simulation trial credit in INR.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Billing', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible()
  await expect(page.getByText('Simulation mode.')).toBeVisible()
  await expect(page.getByTestId('wallet-kpis')).toContainText('₹1,000.00')
  await expect(page.getByTestId('tx-row')).toContainText('Trial credit')

  await page.getByRole('button', { name: 'Add test credit' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '₹500.00' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add credit' }).click()
  await expect(page.getByTestId('wallet-kpis')).toContainText('₹1,500.00')
  await expect(page.getByTestId('tx-row').first()).toContainText('Test credit')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  expect((await download).suggestedFilename()).toBe('wallet-transactions.csv')
  await shot(page, 'b1-billing')

  // The header always shows what the wallet can spend, and links back to Billing.
  await expect(page.getByTestId('wallet-chip')).toContainText('₹1,500.00')

  // One Billing page: the application has a usage card on its overview that opens Billing filtered to it,
  // and the old per-application billing address redirects there.
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Billing & usage' })).toHaveCount(0)
  await navTo(page, 'Overview')
  await expect(page.getByTestId('usage-card')).toContainText('Nothing charged yet this month')
  await expect(page.getByTestId('usage-card')).toContainText('₹1,500.00')
  await page.getByTestId('usage-card').getByRole('link', { name: 'Open billing' }).click()
  await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible()
  await expect(page).toHaveURL(/\/billing\?app=/)
  await expect(page.getByTestId('tx-empty')).toContainText('No charges by Chai Billing yet')
  const appId = (await page.url()).match(/app=([^&]+)/)![1]
  await page.goto(`/apps/${appId}/billing`)
  await expect(page).toHaveURL(new RegExp(`/billing\\?app=${appId}`))
  await expect(page.getByTestId('wallet-kpis')).toContainText('₹1,500.00')

  // Analytics: nothing has been sent yet, so the page guides the next steps instead of showing zeros;
  // presets, the custom range and CSV export still work.
  await navTo(page, 'Analytics')
  await expect(page.getByTestId('analytics-empty')).toContainText('Nothing to measure in this period yet')
  await expect(page.getByTestId('analytics-empty')).toContainText('Send your first campaign')
  await expect(page.getByTestId('analytics-kpis')).toHaveCount(0)
  await page.getByRole('radio', { name: 'Last 7 days' }).click()
  await expect(page.getByRole('radio', { name: 'Last 7 days' })).toBeChecked()
  await expect(page.getByTestId('analytics-empty')).toBeVisible()
  await page.getByRole('radio', { name: 'Custom' }).click()
  await expect(page.getByLabel('Start date')).toBeVisible()
  const csv = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  expect((await csv).suggestedFilename()).toMatch(/^analytics.*\.csv$/)
  await shot(page, 'b2-analytics')
})

test('plans: upgrade to Pro from the wallet, schedule and undo a switch to Starter', async ({ page }) => {
  test.setTimeout(120_000)
  await registerAndVerify(page, 'Pia Plans', uniqueEmail('plan'))
  await createOrgAndApp(page, 'Chai Plans', 'Chai Pro')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Billing', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible()
  const plan = page.getByTestId('plan-section')
  await expect(plan.getByTestId('current-plan')).toHaveText(/Starter/)
  await expect(plan.getByTestId('plan-card-pro')).toContainText('₹2,999.00')
  await expect(plan.getByTestId('plan-usage')).toContainText('Applications')
  await expect(plan.getByTestId('plan-usage')).toContainText('1 / 2')

  // Not enough credit yet (trial ₹1,000): the dialog says so and the server refuses.
  await plan.getByTestId('upgrade-pro').click()
  await expect(page.getByRole('alertdialog')).toContainText('₹2,999.00 will be charged from your wallet now')
  await expect(page.getByRole('alertdialog')).toContainText('too low')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('button', { name: 'Add test credit' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '₹10,000.00' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add credit' }).click()
  await expect(page.getByTestId('wallet-kpis')).toContainText('₹11,000.00')

  await plan.getByTestId('upgrade-pro').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Pay ₹2,999.00' }).click()
  await expect(plan.getByTestId('current-plan')).toHaveText(/Pro/)
  await expect(plan.getByTestId('next-charge')).toContainText('₹2,999.00')
  await expect(page.getByTestId('wallet-kpis')).toContainText('₹8,001.00')
  await expect(page.getByTestId('tx-row').first()).toContainText('Plan')
  await expect(page.getByTestId('plan-badge')).toHaveCount(1)

  // Switching to Starter is scheduled for the end of the period and can be undone.
  await plan.getByTestId('switch-starter').click()
  await expect(page.getByRole('alertdialog')).toContainText('Nothing is charged now')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Switch to Starter' }).click()
  await expect(plan.getByTestId('plan-scheduled')).toBeVisible()
  await expect(plan.getByTestId('next-charge')).toContainText('No renewal')
  await plan.getByRole('button', { name: 'Keep Pro' }).click()
  await expect(plan.getByTestId('plan-scheduled')).toHaveCount(0)
  await expect(plan.getByTestId('next-charge')).toContainText('₹2,999.00')

  // Phone width: no horizontal scroll.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await shot(page, 'b3-plans')
})
