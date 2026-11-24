import { expect, test, type Page } from '@playwright/test'
import { createOrgAndApp, linkFromMailbox, registerAndVerify, uniqueEmail } from './helpers'

/**
 * A brand-new user sends their first email, SMS and voice campaign using only the guidance inside the
 * editors: inline sender / caller / template dialogs, self-describing readiness fixes, "Back to campaign"
 * after registration, and no horizontal scrolling at phone width.
 */

async function noHorizontalScroll(page: Page, label: string) {
  const { sw, cw, wide } = await page.evaluate(() => {
    const cw = document.documentElement.clientWidth
    const wide = [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > cw + 1 && !el.closest('.overflow-x-auto, .overflow-auto, [data-overflow-ok]'))
      .slice(0, 4)
      .map((el) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 60)}`)
    return { sw: document.documentElement.scrollWidth, cw, wide }
  })
  expect(sw, `${label}: page is ${sw}px wide at ${cw}px: ${wide.join(' | ')}`).toBeLessThanOrEqual(cw + 1)
}

async function atPhoneWidth(page: Page, label: string, check?: () => Promise<void>) {
  const size = page.viewportSize()!
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  await noHorizontalScroll(page, label)
  if (check) await check()
  await page.setViewportSize(size)
}

test('India: first email, SMS and voice campaign from inside the editors', async ({ page, browser }) => {
  test.setTimeout(240_000)
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message, (e.stack ?? '').slice(0, 400)))
  const tag = String(Date.now()).slice(-5)
  await registerAndVerify(page, 'Nila First', uniqueEmail('first'))
  await createOrgAndApp(page, 'First Chai', 'First Chai App')
  const appId = page.url().match(/\/apps\/([^/?]+)/)![1]
  const base = `/apps/${appId}`

  // One contact who agreed to email, SMS and calls.
  const email = `meera.${tag}@example.in`
  const phone = `+9198766${tag}`
  await page.goto(`${base}/audience/import`)
  const csv = ['Name,Email,Phone', `Meera Iyer,${email},${phone}`].join('\n')
  await page.getByTestId('import-file').setInputFiles({ name: 'one.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await page.getByRole('button', { name: /Validate/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  for (const ch of ['Email', 'SMS', 'Voice calls']) await page.getByRole('checkbox', { name: ch, exact: true }).check()
  await page.getByLabel('Where was consent collected?').fill('Store sign-up')
  await page.getByLabel('Consent evidence').fill('Signed form')
  await page.getByRole('checkbox', { name: /I confirm/ }).check()
  await page.getByRole('button', { name: 'Start import' }).click()
  await expect(page.getByTestId('import-status')).toHaveText('Import complete', { timeout: 30_000 })

  // Quiet hours away from "now" in India so promotional texts are not held.
  const istHour = (new Date().getUTCHours() + 5 + (new Date().getUTCMinutes() + 30 >= 60 ? 1 : 0)) % 24
  const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`
  await page.goto(`${base}/settings`)
  await page.getByRole('tab', { name: 'Delivery' }).click()
  await page.getByLabel('Quiet hours start').fill(hh(istHour + 3))
  await page.getByLabel('Quiet hours end').fill(hh(istHour + 4))
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled()

  // ---------------------------------------------------------------- email
  await page.goto(`${base}/email/campaigns/new`) // contract C3, blank
  await expect(page.getByLabel('Campaign name')).toBeVisible()
  await atPhoneWidth(page, 'email setup', async () => {
    await expect(page.getByTestId('step-caption')).toContainText('Step 1 of 4: Setup')
  })
  await page.getByTestId('add-sender-inline').click()
  const senderEmail = `hello.${tag}@firstchai.example`
  await page.getByLabel('From name').fill('First Chai')
  await page.getByLabel('From email').fill(senderEmail)
  await page.getByRole('button', { name: 'Add and send confirmation' }).click()
  await expect(page.getByTestId('sender-pending')).toBeVisible()
  await expect(page.getByTestId('resend-confirmation')).toBeVisible()
  const verify = await browser.newPage()
  await verify.goto(await linkFromMailbox(verify, senderEmail, '/verify-sender'))
  await verify.close()
  // The editor notices the confirmation by itself (polling) — no reload.
  await expect(page.getByTestId('sender-pending')).toBeHidden({ timeout: 15_000 })
  await page.getByLabel('Subject line').fill('{{first_name}}, your first chai is on us')
  await page.getByRole('button', { name: /Next: Content/ }).click()
  await page.getByTestId('starter-promotion').click()
  await expect(page.locator('.gjs-editor')).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1500) // let the visual editor autosave its design
  await expect(page.getByTestId('save-state')).toContainText('All changes saved', { timeout: 15_000 })
  await page.getByRole('button', { name: /Next: Audience/ }).click()
  await atPhoneWidth(page, 'email audience')
  await page.getByText('All reachable contacts').click()
  await expect(page.getByTestId('eligible-count')).toHaveText('1')
  await page.getByRole('button', { name: /Next: Review/ }).click()
  await expect(page.locator('[data-check="wallet"]')).toBeVisible()
  await expect(page.getByTestId('wallet-balance')).toBeVisible()
  await atPhoneWidth(page, 'email review')
  await expect(page.getByTestId('launch')).toBeEnabled()
  await page.getByTestId('launch').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Send now' }).click()
  await expect(page.getByText('Simulation mode.')).toBeVisible()
  await atPhoneWidth(page, 'email report')
  await expect
    .poll(async () => (await (await page.request.get(`/api/v1/dev/mailbox?to=${encodeURIComponent(email)}`)).json()).items.length, { timeout: 20_000 })
    .toBeGreaterThan(0)

  // ---------------------------------------------------------------- SMS
  await page.goto(`${base}/sms/campaigns/new`)
  await expect(page.getByLabel('Campaign name')).toBeVisible()
  await page.getByRole('button', { name: 'Step 4: Review & send' }).click()
  // Before any sender is chosen every Indian requirement is listed, priced in rupees.
  const checks = page.getByTestId('readiness')
  for (const key of ['sender', 'registration', 'category', 'dlt_template', 'consent']) await expect(checks.locator(`[data-check="${key}"]`)).toBeVisible()
  await expect(checks.locator('[data-check="category"]')).toContainText('Needed')
  await checks.getByTestId('what-pe_id').click()
  await expect(checks.getByRole('note')).toContainText('Principal Entity')
  await atPhoneWidth(page, 'sms review (no sender)')
  // Registration opens with "Back to campaign".
  await checks.getByTestId('action-registration').click()
  await expect(page.getByTestId('return-banner')).toBeVisible()
  await page.getByLabel('Principal Entity ID').fill('1101456789012345678')
  await page.getByRole('checkbox', { name: 'Confirm registration' }).check()
  await page.getByRole('button', { name: 'Save registration' }).click()
  await expect(page.getByTestId('registration-confirmed')).toBeVisible()
  await page.getByTestId('return-banner').getByRole('link', { name: 'Back to campaign' }).click()
  await expect(checks.locator('[data-check="registration"]')).toHaveAttribute('data-ok', 'true')
  // Sender ID and DLT template, inline.
  await checks.getByTestId('fix-sender').click()
  await page.getByTestId('add-sender-inline').first().click()
  await page.getByLabel('Header', { exact: true }).fill('561234')
  await page.getByRole('dialog').getByRole('button', { name: 'Add sender ID' }).click()
  await page.getByTestId('confirm-sender-inline').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'I confirm' }).click()
  await expect(page.getByText('Approved')).toBeVisible()
  await page.getByTestId('add-template-inline').click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel('Name').fill('Welcome')
  await dlg.getByLabel('Message', { exact: true }).fill('Hi {{first_name}}, welcome to First Chai. Show this text for a free cup!')
  await dlg.getByLabel('DLT template ID').fill('1107160000000054321')
  await dlg.getByLabel('Registered text').fill('Hi {#var#}, welcome to First Chai. Show this text for a free cup!')
  await dlg.getByRole('button', { name: 'Create template' }).click()
  await expect(page.getByLabel('DLT content template')).not.toHaveValue('')
  await page.getByRole('button', { name: /Next: Message/ }).click()
  await expect(page.getByTestId('dlt-match')).toContainText('Matches the registered DLT template')
  await page.getByRole('button', { name: /Next: Audience/ }).click()
  await page.getByText('All reachable contacts').click()
  await expect(page.getByTestId('eligible-count')).toHaveText('1')
  await page.getByRole('button', { name: /Next: Review/ }).click()
  await expect(page.getByTestId('cost-estimate')).toContainText('₹')
  await atPhoneWidth(page, 'sms review (ready)')
  await expect(page.getByTestId('launch')).toBeEnabled()
  await page.getByTestId('launch').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Send now' }).click()
  await expect(page.getByText('Simulation mode.')).toBeVisible()
  await atPhoneWidth(page, 'sms report')
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get('/api/v1/dev/sms-outbox?limit=200')).json()).includes(phone.slice(-5)), { timeout: 20_000 })
    .toBe(true)

  // ---------------------------------------------------------------- voice
  await page.goto(`${base}/voice/campaigns/new`)
  await expect(page.getByLabel('Campaign name')).toBeVisible()
  await page.getByRole('radio', { name: 'Transactional', exact: true }).click()
  // No number to choose or pay for: Signalcraft picks the caller number for every call.
  await expect(page.getByTestId('managed-number-note')).toBeVisible()
  await expect(page.getByTestId('get-number-inline')).toHaveCount(0)
  await atPhoneWidth(page, 'voice setup')
  await page.getByRole('button', { name: /Next: Message/ }).click()
  await page.getByTestId('message-type-tts').click()
  await page.getByRole('button', { name: 'Text to speech' }).click()
  const tts = page.getByRole('dialog')
  await tts.getByLabel('Name').fill('Welcome call')
  await tts.getByLabel('What should the call say?').fill('Namaste {{first_name}}, your First Chai account is ready.')
  await tts.getByRole('button', { name: 'Save message' }).click()
  await expect(page.getByTestId('script-preview')).toContainText('your First Chai account is ready')
  await page.getByRole('button', { name: /Next: Audience/ }).click()
  await page.getByText('All reachable contacts').click()
  await expect(page.getByTestId('eligible-count')).toHaveText('1')
  await page.getByRole('button', { name: /Next: Review/ }).click()
  await expect(page.getByTestId('calling-window')).toBeVisible()
  await expect(page.getByTestId('cost-estimate')).toContainText('₹')
  await atPhoneWidth(page, 'voice review')
  await expect(page.getByTestId('launch')).toBeEnabled()
  await page.getByTestId('launch').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Start calling' }).click()
  await expect(page.getByText('Simulation mode.')).toBeVisible()
  await atPhoneWidth(page, 'voice report')
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get('/api/v1/dev/call-log?limit=200')).json()).includes(phone.slice(-5)), { timeout: 30_000 })
    .toBe(true)

  // Overview and list pages at phone width.
  for (const path of ['/email', '/email/campaigns', '/sms', '/sms/campaigns', '/sms/inbox', '/sms/senders', '/sms/templates', '/voice', '/voice/campaigns', '/voice/agents']) {
    await page.goto(base + path)
    await page.waitForLoadState('networkidle')
    await atPhoneWidth(page, path)
  }
})

test('US app: requirements and pricing before a sender is chosen; C3 preselects contacts', async ({ page }) => {
  await registerAndVerify(page, 'Ula First', uniqueEmail('first-us'))
  await createOrgAndApp(page, 'First Coffee', 'First Coffee App', 'US')
  const appId = page.url().match(/\/apps\/([^/?]+)/)![1]
  const contactId = await page.evaluate(async ({ appId, email }) => {
    const tok = (await (await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })).json()).access_token
    const r = await fetch(`/api/v1/apps/${appId}/contacts`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ first_name: 'Jo', email }) })
    return (await r.json()).id as string
  }, { appId, email: `jo.${Date.now()}@example.com` })
  expect(contactId).toBeTruthy()
  // The manual refresh above rotated the session; let the app finish re-authenticating its own
  // in-flight requests before navigating, or the navigation aborts the app's refresh mid-rotation.
  await page.waitForLoadState('networkidle')
  await page.goto(`/apps/${appId}/sms/campaigns/new?contact_ids=${contactId}`)
  await expect(page.getByLabel('Campaign name')).toBeVisible()
  await page.getByRole('button', { name: 'Step 3: Audience' }).click()
  await expect(page.getByTestId('picked-contacts')).toContainText('1')
  await page.getByRole('button', { name: 'Step 4: Review & send' }).click()
  const checks = page.getByTestId('readiness')
  await expect(checks.locator('[data-check="registration"]')).toContainText('10DLC')
  await expect(checks.locator('[data-check="consent"]')).toContainText('TCPA')
  await expect(checks.locator('[data-check="dlt_template"]')).toHaveCount(0)
  await page.goto(`/apps/${appId}/sms`)
  await expect(page.getByTestId('sms-setup')).toContainText('10DLC')
  await expect(page.getByTestId('sms-setup')).not.toContainText('DLT entity')
})
