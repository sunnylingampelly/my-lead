import { expect, test } from '@playwright/test'
import { createOrgAndApp, linkFromMailbox, navTo, registerAndVerify, uniqueEmail } from './helpers'

test('sender, campaign from a starter, send, report, open tracking and unsubscribe', async ({ page, browser }) => {
  test.setTimeout(150_000)
  const tag = Date.now()
  await registerAndVerify(page, 'Esha Email', uniqueEmail('mail'))
  await createOrgAndApp(page, 'Chai Co', 'Chai Online')

  // Sender: add and confirm through the emailed link.
  await navTo(page, 'Senders')
  await page.getByRole('button', { name: 'Add sender' }).first().click()
  const senderEmail = `offers.${tag}@chai.example`
  await page.getByLabel('From name').fill('Chai Offers')
  await page.getByLabel('From email').fill(senderEmail)
  await page.getByRole('button', { name: 'Add and send confirmation' }).click()
  await expect(page.getByText('Awaiting confirmation')).toBeVisible()
  const verify = await browser.newPage()
  await verify.goto(await linkFromMailbox(verify, senderEmail, '/verify-sender'))
  await expect(verify.getByTestId('sender-verified')).toContainText(senderEmail)
  await verify.close()
  await page.reload()
  await expect(page.getByText('Verified', { exact: true })).toBeVisible()

  // Domain authentication: the card checks SPF / DKIM / DMARC for the sender's domain and can check again.
  // (chai.example has no DNS records, or DNS checks are off on this server: either way the card renders.)
  const dnsCard = page.getByTestId('domain-auth-card')
  await expect(dnsCard).toContainText('Domain authentication')
  await expect(dnsCard).toContainText('chai.example')
  await expect(dnsCard.getByTestId('domain-auth-status')).toBeVisible()
  await dnsCard.getByRole('button', { name: 'Check again' }).click()
  await expect(dnsCard.getByTestId('domain-auth-status')).toHaveText(/Not authenticated|Partly set up|Could not check|Checks off|Authenticated/)

  // Contacts with email consent.
  await navTo(page, 'Import')
  const a = `priya.${tag}@example.in`
  const b = `arun.${tag}@example.in`
  const csv = ['Name,Email,City', `Priya Nair,${a},Kochi`, `Arun Das,${b},Kolkata`].join('\n')
  await page.getByTestId('import-file').setInputFiles({ name: 'subs.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await page.getByRole('button', { name: /Validate/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('checkbox', { name: 'Email', exact: true }).check()
  await page.getByLabel('Where was consent collected?').fill('Newsletter sign-up')
  await page.getByRole('checkbox', { name: /I confirm/ }).check()
  await page.getByRole('button', { name: 'Start import' }).click()
  await expect(page.getByTestId('import-status')).toHaveText('Import complete', { timeout: 30_000 })

  // Campaign wizard.
  await navTo(page, 'Campaigns')
  await page.getByRole('button', { name: 'New campaign' }).first().click()
  await expect(page.getByLabel('From')).toHaveValue(/.+/)
  await page.getByLabel('Campaign name').fill('Monsoon offer')
  await page.getByLabel('Subject line').fill('{{first_name}}, monsoon chai is here')
  await expect(page.getByTestId('save-state')).toContainText('All changes saved')
  await page.getByRole('button', { name: /Next: Content/ }).click()
  await page.getByTestId('starter-promotion').click()
  await expect(page.locator('.gjs-editor')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.getByTestId('preview-subject')).toHaveText('Asha, monsoon chai is here')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Next: Audience/ }).click()
  await page.getByText('All reachable contacts').click()
  await expect(page.getByTestId('eligible-count')).toHaveText('2')
  await page.getByRole('button', { name: /Next: Review/ }).click()
  // Seven checks, plus a sender-domain warning when DNS checks are on (it never blocks sending).
  await expect(page.getByTestId('readiness').locator('li:not([data-check="domain_auth"])')).toHaveCount(7)
  await page.getByTestId('launch').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Send now' }).click()

  // Report.
  await expect(page.getByRole('heading', { name: 'Monsoon offer', level: 1 })).toBeVisible()
  await expect(page.getByText('Simulation mode.')).toBeVisible()
  await expect(page.getByTestId('report-kpis')).toContainText('Accepted by the provider')
  await expect(page.getByTestId('report-kpis').getByText('100.0%').first()).toBeVisible({ timeout: 20_000 })

  // Viewing the email in the dev mailbox loads the tracking pixel: a real open.
  const inbox = await browser.newPage()
  await inbox.goto(`/dev/mailbox?to=${encodeURIComponent(a)}`)
  await expect(inbox.getByText('Priya, monsoon chai is here').first()).toBeVisible()
  await inbox.waitForTimeout(1500)
  const html = await inbox.request.get(`/api/v1/dev/mailbox?to=${encodeURIComponent(a)}`).then((r) => r.json())
  const unsub = (html.items[0].html as string).match(/\/unsubscribe\?t=[^"&]+/)![0]
  await inbox.goto(unsub)
  await inbox.getByRole('button', { name: 'Unsubscribe' }).click()
  await expect(inbox.getByTestId('unsubscribed')).toContainText('will no longer receive')
  await inbox.close()

  await page.reload()
  await expect(page.getByTestId('report-kpis')).toContainText('1 unique')
  await page.getByRole('button', { name: 'Unsubscribed', exact: true }).click()
  await expect(page.getByRole('cell', { name: a })).toBeVisible()
})
