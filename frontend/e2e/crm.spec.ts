import { expect, test } from '@playwright/test'
import { createOrgAndApp, navTo, registerAndVerify, uniqueEmail } from './helpers'

// Wide enough for every board column to be on screen, so drags never scroll the board mid-drag.
test.use({ viewport: { width: 2200, height: 1000 } })

test('CRM: deals board drag, lost reason, won, note with mention, task', async ({ page }) => {
  test.setTimeout(120_000)
  await registerAndVerify(page, 'Kiran Desai', uniqueEmail('crm'))
  await createOrgAndApp(page, 'Crm Co', 'Crm Desk')

  await navTo(page, 'Deals')
  await expect(page.getByRole('heading', { name: 'Deals' })).toBeVisible()

  const createDeal = async (title: string, amount: string) => {
    await page.getByRole('button', { name: 'New deal' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Title').fill(title)
    await dlg.getByLabel(/Amount/).fill(amount)
    await dlg.getByRole('button', { name: 'Create deal' }).click()
    await expect(dlg).toBeHidden()
  }
  await createDeal('Factory rollout', '1250000')
  await createDeal('Tiny add-on', '5000')
  const col = (name: string) => page.getByTestId(`column-${name}`)
  await expect(col('New').getByTestId('deal-card')).toHaveCount(2)
  await expect(col('New')).toContainText('₹12,50,000')

  // Drag to the next stage (optimistic), and the move survives a reload.
  await col('New').getByText('Factory rollout').dragTo(col('Qualified'))
  await expect(page.getByText('Moved to Qualified')).toBeVisible()
  await expect(col('Qualified').getByTestId('column-count')).toHaveText('1')

  // Dropping on Lost asks for a reason.
  await col('New').getByText('Tiny add-on').dragTo(col('Lost'))
  const lost = page.getByRole('dialog')
  await expect(lost).toContainText('Mark as lost')
  await lost.getByLabel('Lost reason').selectOption({ label: 'Price too high' })
  await lost.getByRole('button', { name: 'Mark as lost' }).click()
  await expect(page.getByText('Tiny add-on marked lost')).toBeVisible()
  await page.reload()
  await expect(col('Qualified').getByText('Factory rollout')).toBeVisible()
  await expect(col('Lost').getByText('Tiny add-on')).toBeVisible()

  // Deal page: note with an @mention, a task, then win the deal.
  await col('Qualified').getByText('Factory rollout').click()
  await expect(page.getByRole('heading', { name: 'Factory rollout' })).toBeVisible()
  await page.getByRole('tab', { name: 'Add note' }).click()
  const note = page.getByLabel('Note', { exact: true })
  await note.click()
  await note.pressSequentially('Pricing approved by @Kir')
  await page.getByRole('listbox', { name: 'Mention a teammate' }).getByRole('option', { name: /Kiran Desai/ }).click()
  await page.getByRole('button', { name: 'Add note' }).click()
  await expect(page.getByTestId('timeline').locator('[data-mention]').first()).toHaveText('@Kiran Desai')

  await page.getByRole('tab', { name: 'Add task' }).click()
  await page.getByLabel('Task', { exact: true }).fill('Send the contract')
  await page.getByRole('button', { name: 'Add task' }).click()
  await page.getByRole('tab', { name: 'Tasks' }).click()
  await page.getByLabel('Complete Send the contract').check()
  await expect(page.getByText('Task completed')).toBeVisible()
  await page.getByRole('tab', { name: 'Timeline' }).click()
  await expect(page.getByTestId('timeline')).toContainText('Completed: Send the contract')

  await page.getByRole('button', { name: 'Won' }).click()
  // A toast celebrates the win and the timeline records it.
  await expect(page.getByText('🎉 Deal won')).toBeVisible()
  await expect(page.getByTestId('timeline')).toContainText('Deal won')
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible()

  // Reports pick up the win and the lost reason.
  await navTo(page, 'Reports')
  await expect(page.getByTestId('kpis')).toContainText('₹12.5 L')
  await expect(page.getByTestId('lost-reasons')).toContainText('Price too high')
})
