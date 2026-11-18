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

  // The application view of the same wallet.
  await navTo(page, 'Billing & usage')
  await expect(page.getByRole('heading', { name: 'Billing & usage', level: 1 })).toBeVisible()
  await expect(page.getByTestId('wallet-kpis')).toContainText('₹1,500.00')

  // Analytics: presets, table view and CSV export.
  await navTo(page, 'Analytics')
  await expect(page.getByTestId('analytics-kpis')).toContainText('Emails sent')
  await page.getByRole('radio', { name: 'Last 7 days' }).click()
  await page.getByRole('button', { name: 'Show table' }).click()
  await expect(page.getByRole('row')).toHaveCount(8) // header + 7 days
  await page.getByRole('radio', { name: 'Custom' }).click()
  await expect(page.getByLabel('Start date')).toBeVisible()
  const csv = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV' }).click()
  expect((await csv).suggestedFilename()).toMatch(/^analytics.*\.csv$/)
  await shot(page, 'b2-analytics')
})
