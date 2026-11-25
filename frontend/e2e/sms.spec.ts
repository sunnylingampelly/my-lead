import { expect, test } from '@playwright/test'
import { createOrgAndApp, registerAndVerify, uniqueEmail } from './helpers'

// SMS is "coming soon" in every market (SMS_ENABLED=false). Every /sms route shows one coming-soon page,
// and nothing SMS-related can be clicked into an action.

test('SMS is coming soon: one page for every SMS route, no SMS actions anywhere', async ({ page }) => {
  await registerAndVerify(page, 'Sana SMS', uniqueEmail('sms'))
  await createOrgAndApp(page, 'Chai Texts', 'Chai SMS')
  const appId = page.url().match(/\/apps\/([^/?]+)/)![1]
  const base = `/apps/${appId}`

  // Sidebar: SMS carries a "Soon" tag and has no sub-pages.
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByTestId('nav-badge-SMS')).toHaveText('Soon')
  await expect(nav.getByRole('button', { name: 'Show SMS pages' })).toHaveCount(0)

  for (const path of ['/sms', '/sms/campaigns', '/sms/campaigns/new', '/sms/templates', '/sms/senders', '/sms/registration', '/sms/inbox']) {
    await page.goto(base + path)
    const soon = page.getByTestId('sms-coming-soon')
    await expect(soon, path).toBeVisible()
    await expect(soon).toContainText('SMS is coming soon')
    await expect(soon).toContainText('DLT')
    await expect(soon).toContainText('Two-way inbox')
    // No actions: only navigation links (back to the overview, email, voice).
    await expect(soon.getByRole('button')).toHaveCount(0)
    await expect(page.getByLabel('Campaign name')).toHaveCount(0)
  }
  await page.getByTestId('sms-back-to-overview').click()
  await expect(page).toHaveURL(new RegExp(`${base}$`))

  // Dashboard: the SMS channel is "Coming soon" with nothing to click, and no SMS setup step.
  await expect(page.getByTestId('channel-sms')).toContainText('Coming soon')
  await expect(page.getByTestId('channel-sms').getByRole('link')).toHaveCount(0)
  await expect(page.getByText(/Set up SMS/)).toHaveCount(0)

  // Command palette: no "New SMS campaign".
  await page.keyboard.press('Control+k')
  await page.keyboard.type('SMS')
  await expect(page.getByRole('option', { name: /New SMS campaign/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Automation: "Send SMS" is shown but disabled with a "Coming soon" tag.
  await page.goto(`${base}/automation`)
  await page.getByRole('button', { name: 'New workflow' }).first().click()
  await page.getByTestId('starter-welcome').click()
  await expect(page.getByTestId('node-trigger')).toContainText('Contact is created')
  const soonStep = page.getByTestId('step-soon-send_sms').first()
  await expect(soonStep).toBeVisible()
  await expect(soonStep).toContainText('Coming soon')
  await expect(page.getByRole('button', { name: 'Add Send SMS' })).toHaveCount(0)

  // The API refuses SMS actions.
  const r = await page.evaluate(async (appId) => {
    const tok = (await (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })).json()).access_token
    const res = await fetch(`/api/v1/apps/${appId}/sms/campaigns`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ name: 'Nope' }) })
    return { status: res.status, body: await res.json() }
  }, appId)
  expect(r.status).toBe(422)
  expect(r.body.error.code).toBe('SMS_COMING_SOON')
})
