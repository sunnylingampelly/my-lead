import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'
import { createOrgAndApp, registerAndVerify, uniqueEmail } from './helpers'

const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true })
}

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend')
const python = path.join(backend, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')

test('super admin: overview, organizations, wallet credit, staff, support access, webhooks and settings', async ({ page, browser }) => {
  test.setTimeout(120_000)
  const email = uniqueEmail('root')
  await registerAndVerify(page, 'Root Admin', email)
  const opsOrg = `Ops ${Date.now()}`
  await createOrgAndApp(page, opsOrg, 'Ops App')

  // Not an admin yet: the menu has no admin link and /admin redirects away.
  await page.getByTestId('profile-menu').click()
  await expect(page.getByRole('menuitem', { name: 'Platform admin' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  execFileSync(python, ['-m', 'app.cli', 'grant-admin', email], { cwd: backend })
  await page.goto('/account')
  await page.reload() // refresh the signed-in user
  await page.getByTestId('profile-menu').click()
  await page.getByRole('menuitem', { name: 'Platform admin' }).click()
  await expect(page.getByRole('heading', { name: 'Platform admin', level: 1 })).toBeVisible()
  await expect(page.getByText('Last 24 hours')).toBeVisible()
  await shot(page, 'c1-admin')

  await page.getByRole('button', { name: 'Organizations' }).click()
  await page.getByLabel('Search organizations').fill(opsOrg)
  await page.getByTestId('admin-org-row').filter({ hasText: opsOrg }).click()
  await page.getByRole('button', { name: 'Adjust wallet' }).click()
  const form = page.getByTestId('adjust-form')
  await form.getByLabel(/Amount/).fill('250')
  await form.getByLabel('Reason').fill('Launch bonus')
  await form.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText(/Balance is now/)).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('Credit by platform: Launch bonus')
  await page.keyboard.press('Escape')

  // Platform staff: the super admin is listed.
  await page.getByRole('button', { name: 'Platform staff' }).click()
  await expect(page.getByTestId('staff-row').filter({ hasText: '(you)' })).toContainText('Super admin')

  // A customer signs up separately; the super admin opens their workspace read-only.
  const customer = await browser.newPage()
  const customerOrg = `Customer ${Date.now()}`
  await registerAndVerify(customer, 'Cara Customer', uniqueEmail('cust'))
  await createOrgAndApp(customer, customerOrg, 'Customer App')
  await customer.close()
  await page.getByRole('button', { name: 'Organizations' }).click()
  await page.getByLabel('Search organizations').fill(customerOrg)
  await page.getByTestId('admin-org-row').filter({ hasText: customerOrg }).click()
  await page.getByRole('button', { name: 'Open read-only' }).click()
  await page.getByLabel('Reason (shown to the customer)').fill('Checking an import issue')
  await page.getByRole('dialog').getByRole('button', { name: 'Open read-only' }).last().click()
  await expect(page.getByTestId('support-banner')).toContainText(`Read-only support access to ${customerOrg}`)
  await expect(page.getByText('Customer App').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'New application' })).toHaveCount(0)
  await shot(page, 'c2-support')
  await page.getByTestId('support-banner').getByRole('button', { name: 'End session' }).click()
  await expect(page.getByRole('heading', { name: 'Platform admin', level: 1 })).toBeVisible()
  await expect(page.getByText(/^Ended/).first()).toBeVisible()

  await page.getByRole('button', { name: 'Webhooks' }).click()
  await expect(page.getByRole('button', { name: 'Failed' })).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByTestId('provider-payments-stripe')).toBeVisible()
  await expect(page.getByText('simulation', { exact: true })).toBeVisible()
})
