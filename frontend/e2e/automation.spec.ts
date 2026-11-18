import { expect, type Page, test } from '@playwright/test'
import { createOrgAndApp, navTo, registerAndVerify, uniqueEmail } from './helpers'

const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true })
}

test('build, validate, activate and run a workflow from the React Flow builder', async ({ page }) => {
  test.setTimeout(150_000)
  await registerAndVerify(page, 'Ada Automation', uniqueEmail('auto'))
  await createOrgAndApp(page, 'Chai Flows', 'Chai Journeys')

  // A tag for the workflow to apply.
  await navTo(page, 'Tags')
  await page.getByLabel('New tag name').fill('Pune fan')
  await page.getByRole('button', { name: 'Create tag' }).click()
  await expect(page.getByText('Pune fan')).toBeVisible()

  // New workflow from scratch.
  await navTo(page, 'Automation')
  await page.getByRole('button', { name: 'New workflow' }).first().click()
  await page.getByTestId('starter-blank').click()
  await expect(page.getByLabel('Workflow name')).toHaveValue('Untitled workflow')
  await page.getByLabel('Workflow name').fill('Pune welcome')
  await page.getByLabel('Workflow name').blur()

  // Select the trigger, then add a condition (auto-connected) and configure it.
  await page.getByTestId('node-trigger').click()
  await expect(page.getByTestId('inspector')).toContainText('Trigger')
  await page.getByRole('button', { name: 'Add Condition' }).click()
  const insp = page.getByTestId('inspector')
  await insp.getByLabel('Check').selectOption('rules')
  await insp.getByLabel('Field').selectOption('city')
  await insp.getByLabel('Value').fill('Pune')

  // With the condition selected, new steps fill the Yes branch, then the No branch.
  await page.getByRole('button', { name: 'Add Update contact' }).click()
  await insp.getByLabel('Tag', { exact: true }).selectOption({ label: 'Pune fan' })
  await page.locator('[data-testid^="node-condition_"]').click()
  await page.getByRole('button', { name: 'Add End' }).click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(3)
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 10_000 })
  await page.getByTestId('issues').click()
  await expect(page.getByTestId('issues')).toHaveText('Ready', { timeout: 10_000 })
  await shot(page, 'a1-builder')

  // Activate.
  await page.getByTestId('publish').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Activate' }).click()
  await expect(page.getByText('Active', { exact: true })).toBeVisible()

  // A new contact in Pune enters the journey and gets tagged by the local scheduler.
  await navTo(page, 'All contacts')
  await page.getByRole('button', { name: 'Add contact' }).first().click()
  const form = page.getByRole('dialog')
  await form.getByLabel('First name').fill('Priya')
  await form.locator('#c-email').fill(uniqueEmail('priya'))
  await form.getByLabel('City').fill('Pune')
  await page.getByRole('dialog').getByRole('button', { name: 'Add contact' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  await navTo(page, 'Automation')
  await page.getByText('Pune welcome').click()
  await page.getByRole('button', { name: /Enrollments/ }).click()
  await expect(page.getByTestId('run-row').first()).toContainText('Completed', { timeout: 60_000 })
  await page.getByTestId('run-row').first().click()
  await expect(page.getByRole('dialog')).toContainText('Tag added')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Builder' }).click()
  await expect(page.locator('[data-testid^="node-stats-condition_"]')).toContainText('Yes 1')
  // Reopening the builder must not invent unpublished changes.
  await expect(page.getByText('Unpublished changes')).toHaveCount(0)
  await shot(page, 'a2-results')
})
