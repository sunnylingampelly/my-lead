import { expect, test } from '@playwright/test'
import { createOrgAndApp, navTo, registerAndVerify, uniqueEmail } from './helpers'

test('dark mode, command palette contact search, quick view, shortcuts and notifications', async ({ page }) => {
  test.setTimeout(90_000)
  await registerAndVerify(page, 'Uday Ux', uniqueEmail('ux'))
  await createOrgAndApp(page, 'Mysore Mart', 'Mart Online')

  // Dark mode toggles and survives a reload.
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)

  // Import a small file to create contacts and a notification.
  await navTo(page, 'Import')
  const csv = ['Name,Email,Mobile,City', 'Lakshmi Rao,lakshmi@example.in,9845012345,Mysuru', 'Arjun Menon,arjun@example.in,9845012346,Kochi', 'Broken,nope,,']
  await page.getByTestId('import-file').setInputFiles({ name: 'few.csv', mimeType: 'text/csv', buffer: Buffer.from(csv.join('\n')) })
  await page.getByRole('button', { name: /Validate/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Start import' }).click()
  await expect(page.getByTestId('import-status')).toHaveText('Import complete', { timeout: 30_000 })

  // Notification bell shows the import result.
  await page.reload()
  await expect(page.getByTestId('notifications')).toHaveAccessibleName(/1 unread/)
  await page.getByTestId('notifications').click()
  await expect(page.getByText('Import finished: few.csv')).toBeVisible()
  await expect(page.getByText(/2 created, 0 updated, 1 not imported/)).toBeVisible()
  await page.getByRole('button', { name: 'Mark all read' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('notifications')).toHaveAccessibleName('Notifications')

  // Keyboard: G then C opens contacts; / focuses search.
  await page.locator('body').click()
  await page.keyboard.press('g')
  await page.keyboard.press('c')
  await expect(page.getByRole('heading', { name: 'All contacts' })).toBeVisible()
  await page.keyboard.press('/')
  await expect(page.getByLabel('Search contacts')).toBeFocused()

  // Row click opens a quick view instead of leaving the page.
  await page.getByRole('cell', { name: 'Lakshmi Rao', exact: true }).click()
  await expect(page.getByTestId('contact-peek')).toContainText('lakshmi@example.in')
  await expect(page.getByTestId('contact-peek')).toContainText('+91 98450 12345')
  await page.getByRole('link', { name: 'Open full profile' }).click()
  await expect(page.getByRole('heading', { name: 'Lakshmi Rao', level: 1 })).toBeVisible()

  // Command palette finds contacts by name.
  await page.keyboard.press('Control+k')
  await page.getByLabel('Command', { exact: true }).fill('arjun')
  await expect(page.getByRole('option', { name: /Arjun Menon/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Arjun Menon', level: 1 })).toBeVisible()

  // Palette action opens the add-contact form.
  await page.keyboard.press('Control+k')
  await page.getByLabel('Command', { exact: true }).fill('add a contact')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Add contact' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Shortcuts help (click a neutral spot: a table row would open the quick view and pause shortcuts).
  await page.getByRole('heading', { level: 1 }).click()
  await page.keyboard.press('?')
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible()
})

test('password field shows strength and can reveal characters', async ({ page }) => {
  await page.goto('/register')
  await page.getByLabel('Password', { exact: true }).fill('short')
  await expect(page.getByText('Too weak')).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill('Longer-Passphrase-2026')
  await expect(page.getByText('Strong')).toBeVisible()
  await page.getByRole('button', { name: 'Show typed characters' }).click()
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text')
})
