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
  await page.keyboard.press('Escape')
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

async function addContact(page: Page, first: string, extra: { city?: string } = {}) {
  await navTo(page, 'All contacts')
  await page.getByRole('button', { name: 'Add contact' }).first().click()
  const form = page.getByRole('dialog')
  await form.getByLabel('First name').fill(first)
  await form.locator('#c-email').fill(uniqueEmail(first.toLowerCase()))
  if (extra.city) await form.getByLabel('City').fill(extra.city)
  await form.getByRole('button', { name: 'Add contact' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
}

const appIdOf = (page: Page) => new URL(page.url()).pathname.split('/')[2]!

test('builder keeps edits, lists problems, creates prerequisites inline, tests, enrolls and works on a phone', async ({ page }) => {
  test.setTimeout(360_000)
  await registerAndVerify(page, 'Uma Usability', uniqueEmail('autoux'))
  await createOrgAndApp(page, 'Chai UX', 'Chai UX App')
  const appId = appIdOf(page)

  // Analytics on a brand-new app: next steps instead of zeros.
  await navTo(page, 'Analytics')
  await expect(page.getByTestId('analytics-empty')).toContainText('Verify a sender')
  await expect(page.getByTestId('analytics-empty')).toContainText('Build a workflow')

  await addContact(page, 'Ravi', { city: 'Pune' })

  // Welcome series starter: starts on "Contact is created", so no list is needed.
  await navTo(page, 'Automation')
  await page.getByRole('button', { name: 'New workflow' }).first().click()
  await page.getByTestId('starter-welcome').click()
  await expect(page.getByTestId('node-trigger')).toContainText('Contact is created')

  // Problems list: each problem names its step and selecting one opens that step.
  await expect(page.getByTestId('issues')).toContainText('to fix', { timeout: 10_000 })
  await page.getByTestId('issues').click()
  const problems = page.getByTestId('problem-item')
  await expect(problems.first()).toBeVisible()
  await expect(page.getByTestId('problems-list')).toContainText('Welcome email')
  await page.getByTestId('problems-list').getByText('Welcome email').first().click()
  await expect(page.getByTestId('inspector')).toContainText('Send email')
  // Missing sender: open the senders page in a new tab, with a refresh button here.
  const create = page.getByTestId('inspector').getByRole('link', { name: 'Create one' }).first()
  await expect(create).toHaveAttribute('target', '_blank')
  await expect(page.getByTestId('inspector').getByRole('button', { name: /Refresh/ }).first()).toBeVisible()
  // Activate is disabled and explains why.
  await page.getByTestId('publish-wrap').hover()
  await expect(page.getByRole('tooltip')).toContainText(/Fix \d+ problems? to activate/)

  // Inline tag creation on the "Tag as engaged" step.
  await page.getByTestId('node-tag').click()
  await page.getByTestId('inspector').getByRole('button', { name: 'New tag' }).click()
  await page.getByLabel('New tag name').fill('Engaged')
  await page.getByTestId('inspector').getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('inspector').getByLabel('Tag', { exact: true })).toHaveValue(/.+/)
  await expect(page.getByTestId('node-tag')).toContainText('Add tag: Engaged')

  // No lost edits: change the wait and leave immediately.
  await page.getByTestId('node-wait').click()
  await page.getByTestId('inspector').getByLabel('Wait for').fill('5')
  await page.getByRole('button', { name: 'Back to workflows' }).click()
  await page.getByText('Welcome series').first().click()
  await expect(page.getByTestId('node-wait')).toContainText('Wait 5 days')

  // Dry run with a contact: nothing is sent, the path is explained.
  await page.getByTestId('test-workflow').click()
  await page.getByTestId('test-dialog').getByRole('button', { name: /Ravi/ }).click()
  await page.getByTestId('run-test').click()
  await expect(page.getByTestId('test-steps')).toContainText('Would wait 5 days')
  await expect(page.getByTestId('test-steps')).toContainText('Condition → No')
  await page.keyboard.press('Escape')

  // A deal-won flow: activate (with a fallback assignee), enroll Ravi manually, see the task in history.
  await navTo(page, 'Automation')
  await page.getByRole('button', { name: 'New workflow' }).first().click()
  await page.getByTestId('starter-deal_won').click()
  await page.getByTestId('node-task').click()
  await page.getByTestId('inspector').getByLabel('If the contact has no owner').selectOption('user')
  await page.getByTestId('inspector').getByLabel('Fallback assignee').selectOption({ index: 1 })
  await expect(page.getByTestId('save-state')).toContainText('Saved', { timeout: 10_000 })
  await expect(page.getByTestId('issues')).toHaveText('Ready', { timeout: 10_000 })
  await page.getByTestId('publish').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Activate' }).click()
  await expect(page.getByText('Active', { exact: true })).toBeVisible()
  await page.getByTestId('enroll').click()
  await page.getByTestId('enroll-dialog').getByRole('button', { name: /Ravi/ }).click()
  await page.getByTestId('enroll-submit').click()
  await expect(page.getByText('1 enrolled')).toBeVisible()
  await page.getByRole('button', { name: /Enrollments/ }).click()
  await expect(page.getByTestId('run-row').first()).toContainText('Completed', { timeout: 60_000 })
  await page.getByTestId('run-row').first().click()
  await expect(page.getByRole('dialog')).toContainText('Create task: Onboard {{name}}')
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Open task' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Hot-lead starter shows the score threshold where it matters.
  await navTo(page, 'Automation')
  await page.getByRole('button', { name: 'New workflow' }).first().click()
  await page.getByTestId('starter-hot_lead').click()
  await page.getByTestId('node-trigger').click()
  await expect(page.getByTestId('hot-threshold')).toContainText('50')

  // C4: a preset trigger link opens a new draft with that trigger selected.
  await page.goto(`/apps/${appId}/automation/new?trigger=sla_breached`)
  await expect(page.getByTestId('inspector')).toContainText(/first-response SLA is off/i)

  // Phone width: no horizontal scroll, palette behind "Add step".
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('add-step')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.getByTestId('add-step').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add Wait' }).click()
  await expect(page.getByTestId('inspector')).toContainText('Wait')
  await page.setViewportSize({ width: 1280, height: 800 })

  // Analytics with data: the journey counts and the comparison shows.
  await navTo(page, 'Analytics')
  await expect(page.getByTestId('analytics-kpis')).toContainText('Entered journeys')
  await expect(page.getByTestId('delta-email_sent')).toBeVisible()
  await expect(page.getByTestId('analytics-crm')).toBeVisible()
})
