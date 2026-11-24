import { expect, test, type Page } from '@playwright/test'
import { createOrgAndApp, navTo, registerAndVerify, uniqueEmail } from './helpers'

/** Create a form from a template on the Lead forms page and land in its builder. */
async function createForm(page: Page, template: RegExp, name: string) {
  await page.getByTestId('new-form').first().click()
  const dlg = page.getByRole('dialog')
  await dlg.getByRole('radio', { name: template }).click()
  await dlg.getByLabel('Form name').fill(name)
  await dlg.getByRole('button', { name: 'Create form' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

async function publish(page: Page) {
  await page.getByTestId('publish-form').click()
  await expect(page.getByText('Published. Your form is live.')).toBeVisible()
  await expect(page.getByTestId('form-status').first()).toHaveText('Published')
}

/** No horizontal page scroll (the document, and the app's main scroll area). */
async function expectNoOverflow(page: Page, width: number) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  const main = await page.evaluate(() => {
    const m = document.querySelector('main')
    return m ? m.scrollWidth - m.clientWidth : 0
  })
  expect(main).toBeLessThanOrEqual(1)
}

test('Lead forms: build from a template, publish, submit on the hosted page, see the lead', async ({ page }) => {
  test.setTimeout(150_000)
  await registerAndVerify(page, 'Asha Rao', uniqueEmail('forms'))
  await createOrgAndApp(page, 'Forms Co', 'Forms Desk')

  await navTo(page, 'Lead forms')
  await expect(page.getByRole('heading', { name: 'Lead forms' })).toBeVisible()
  await createForm(page, /^Contact us/, 'Website contact')

  // The template's fields: first name, last name, email, phone, message, consent.
  await expect(page.getByTestId('field-row')).toHaveCount(6)
  await expect(page.getByTestId('form-preview')).toContainText('How can we help?')
  await publish(page)

  // The hosted link from the Share tab.
  await page.getByRole('tab', { name: 'Share' }).click()
  await page.getByRole('tab', { name: 'Hosted link' }).click()
  const hosted = await page.getByTestId('hosted-url').inputValue()
  expect(hosted).toMatch(/\/embed\/f\/[A-Za-z0-9_-]+$/)

  // A visitor fills it in. The server refuses submits within 2 seconds of the page loading.
  const lead = uniqueEmail('lead')
  const visitor = await page.context().newPage()
  await visitor.goto(hosted)
  await visitor.getByLabel('First name').fill('Meera')
  await visitor.getByLabel('Last name').fill('Iyer')
  await visitor.getByRole('textbox', { name: 'Email', exact: true }).fill(lead)
  await visitor.getByLabel('How can we help?').fill('We need a demo for our sales team.')
  await visitor.waitForTimeout(2500)
  await visitor.locator('button[type=submit]').click()
  await expect(visitor.locator('[data-sc-success]')).toBeVisible()
  await visitor.close()

  // The submission is listed, linked to the new contact.
  await page.getByRole('tab', { name: 'Submissions' }).click()
  await expect(page.getByTestId('submission-row')).toHaveCount(1)
  await expect(page.getByTestId('submission-row').first()).toContainText('Meera')
  await page.getByTestId('submission-row').first().click()
  await expect(page.getByRole('dialog')).toContainText('We need a demo for our sales team.')
  await page.keyboard.press('Escape')

  // The list shows the submission count; Contacts has the lead.
  await navTo(page, 'Lead forms')
  await expect(page.getByTestId('form-row').first()).toContainText('Website contact')
  await navTo(page, 'All contacts')
  await expect(page.getByText(lead)).toBeVisible()
})

test('Lead forms: copy the inline embed snippet', async ({ page, context }) => {
  test.setTimeout(120_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await registerAndVerify(page, 'Ravi Shah', uniqueEmail('formscopy'))
  await createOrgAndApp(page, 'Snippet Co', 'Snippet Site')

  await navTo(page, 'Lead forms')
  await createForm(page, /^Contact us/, 'Snippet form')
  await page.getByRole('tab', { name: 'Share' }).click()
  await expect(page.getByTestId('publish-banner')).toBeVisible()
  await publish(page)
  await expect(page.getByTestId('publish-banner')).toBeHidden()

  await expect(page.getByTestId('snippet-inline')).toContainText('data-signalcraft-inline')
  await page.getByTestId('snippet-inline-copy').click()
  await expect(page.getByText('Copied', { exact: true }).first()).toBeVisible()
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('data-signalcraft-inline')
  expect(clip).toContain('/embed/forms.js')
})

test('Lead forms: no horizontal scroll at phone width', async ({ page }) => {
  test.setTimeout(120_000)
  await registerAndVerify(page, 'Neha Phone', uniqueEmail('formsphone'))
  await createOrgAndApp(page, 'Phone Co', 'Phone Site')
  const appPath = new URL(page.url()).pathname.replace(/\/$/, '')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${appPath}/forms`)
  await expect(page.getByRole('heading', { name: 'Lead forms' })).toBeVisible()
  await expectNoOverflow(page, 390)

  await createForm(page, /^Contact us/, 'Phone form')
  await expect(page.getByTestId('field-row')).toHaveCount(6)
  await expectNoOverflow(page, 390)

  // The preview is a toggle on phones; opening it must not overflow either.
  await page.getByTestId('toggle-preview').click()
  await expect(page.getByTestId('form-preview')).toBeVisible()
  await expectNoOverflow(page, 390)

  for (const tab of ['Design', 'Settings', 'Share', 'Submissions', 'Analytics']) {
    await page.getByRole('tab', { name: tab }).click()
    await expectNoOverflow(page, 390)
  }

  await page.goto(`${appPath}/forms`)
  await expect(page.getByTestId('form-row').or(page.getByRole('button', { name: 'Actions for Phone form' })).first()).toBeAttached()
  await expectNoOverflow(page, 390)
})
