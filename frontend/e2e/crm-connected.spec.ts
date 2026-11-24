import { expect, test, type Page } from '@playwright/test'
import { createOrgAndApp, registerAndVerify, uniqueEmail } from './helpers'

/** No horizontal page scroll. */
async function expectNoHScroll(page: Page) {
  await page.waitForTimeout(300)
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(over, `page is ${over}px wider than the viewport at ${page.url()}`).toBeLessThanOrEqual(0)
}

test('Audience ↔ CRM: inline create in pickers, bulk assign on leads, quick actions, 390px layouts', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await registerAndVerify(page, 'Meera Iyer', uniqueEmail('conn'))
  await createOrgAndApp(page, 'Connected Co', 'Connected Desk')
  const appId = page.url().match(/apps\/([^/]+)/)![1]
  const base = `/apps/${appId}`

  // Contact form: company picker creates a CRM company inline; consent checkboxes have unique names.
  await page.goto(`${base}/audience/contacts?new=1`)
  const form = page.getByRole('dialog')
  await form.getByLabel('First name').fill('Ravi')
  await form.getByLabel('Email', { exact: true }).fill('ravi@acmeworks.in')
  await expect(form.getByLabel('Email marketing consent')).toBeVisible()
  await form.getByLabel('Email marketing consent').check()
  await form.getByLabel('Where was consent collected?').fill('Website sign-up form')
  await form.locator('#c-company').fill('Acme Works')
  await form.getByRole('option', { name: /Create company “Acme Works”/ }).click()
  await expect(form.getByText('Acme Works')).toBeVisible()
  await form.getByRole('button', { name: /Save|Create|Add contact/ }).last().click()
  await expect(form).toBeHidden()
  if (!/contacts\/[0-9a-f-]{36}/.test(page.url())) await page.getByRole('link', { name: /Ravi/ }).first().click()
  await expect(page.getByRole('heading', { name: /Ravi/ }).first()).toBeVisible()

  // Quick actions on the profile: email is reachable, SMS explains why not.
  const qa = page.getByTestId('quick-actions')
  await expect(qa.getByRole('link', { name: 'Send email' })).toHaveAttribute('href', new RegExp(`/email/campaigns/new\\?contact_ids=`))
  await expect(qa.getByRole('button', { name: 'Send SMS' })).toBeDisabled()
  await expect(qa).toContainText('No phone number')
  await qa.getByRole('button', { name: 'Add task' }).click()
  await page.getByRole('dialog').getByLabel('Task').fill('Call Ravi back')
  await page.getByRole('dialog').getByRole('button', { name: 'Create task' }).click()
  await expect(page.getByText('Task created')).toBeVisible()
  await qa.getByRole('button', { name: 'Add tag' }).click()
  await page.getByRole('dialog').getByLabel('Tag', { exact: true }).fill('Priority')
  await page.getByRole('option', { name: /Create tag “Priority”/ }).click()
  await expect(page.getByText('Tag added')).toBeVisible()

  // Campaign history tab exists separately from the merged CRM & activity timeline.
  await page.getByRole('tab', { name: 'Campaign history' }).click()
  await expect(page.getByText('No campaigns sent to this contact')).toBeVisible()
  await page.getByRole('tab', { name: 'CRM & activity' }).click()
  await expect(page.getByText('Contact created').first()).toBeVisible()

  // Company is linked: it shows the contact.
  await page.goto(`${base}/crm/companies`)
  await page.getByRole('link', { name: 'Acme Works' }).first().click()
  await expect(page.getByText('Ravi').first()).toBeVisible()

  // New deal: contact picker creates a contact inline.
  await page.goto(`${base}/crm/deals`)
  await page.getByRole('button', { name: 'New deal' }).click()
  const dd = page.getByRole('dialog')
  await dd.getByLabel('Title').fill('Pilot')
  await dd.locator('#deal-contact').fill('Sunita Rao')
  await page.getByRole('option', { name: /Create contact “Sunita Rao”/ }).click()
  const qc = page.getByRole('dialog', { name: 'New contact' })
  await qc.getByLabel('Phone').fill('+91 98765 43210')
  await qc.getByRole('button', { name: 'Create contact' }).click()
  await expect(qc).toBeHidden()
  await expect(dd.getByText('Sunita Rao')).toBeVisible()
  await dd.getByRole('button', { name: 'Create deal' }).click()
  await expect(dd).toBeHidden()

  // Leads: bulk assign owner.
  await page.goto(`${base}/crm/leads`)
  await expect(page.getByTestId('view-as-contacts')).toBeVisible()
  await page.getByRole('checkbox', { name: /Select all/i }).first().check()
  const bar = page.getByTestId('leads-bulk-bar')
  await expect(bar).toBeVisible()
  await bar.getByRole('button', { name: /Assign owner/ }).click()
  await page.getByRole('menuitem', { name: 'Meera Iyer' }).click()
  await expect(page.getByText('Assigned to Meera Iyer')).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'Ravi' })).toContainText('MI') // owner avatar initials

  // 390px: no horizontal scroll on the pages this area owns.
  await page.setViewportSize({ width: 390, height: 844 })
  for (const path of [
    '/audience/contacts',
    '/audience/segments',
    '/audience/lists',
    '/audience/import',
    '/crm/leads',
    '/crm/deals?view=list',
    '/crm/companies',
    '/crm/tasks',
    '/crm/reports',
    '/crm/settings',
  ]) {
    await page.goto(base + path)
    await page.getByRole('heading', { level: 1 }).first().waitFor()
    await expectNoHScroll(page)
  }
})
