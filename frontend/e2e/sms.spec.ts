import { expect, test } from '@playwright/test'
import { createOrgAndApp, navTo, registerAndVerify, uniqueEmail } from './helpers'

// Set SHOTS=<dir> to save screenshots of the main SMS screens for visual review.
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true })
}

test('India SMS: DLT registration, header, template, campaign, report, outbox and STOP reply', async ({ page, browser }) => {
  test.setTimeout(150_000)
  const tag = String(Date.now()).slice(-5)
  await registerAndVerify(page, 'Sana SMS', uniqueEmail('sms'))
  await createOrgAndApp(page, 'Chai Texts', 'Chai SMS')

  // Contacts with SMS consent: one normal number, one that simulates an undelivered text.
  const priya = `+9198765${tag}`
  const arun = '+919876500000'
  await navTo(page, 'Import')
  const csv = ['Name,Phone,City', `Priya Nair,${priya},Kochi`, `Arun Das,${arun},Kolkata`].join('\n')
  await page.getByTestId('import-file').setInputFiles({ name: 'phones.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await page.getByRole('button', { name: /Validate/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('checkbox', { name: 'SMS', exact: true }).check()
  await page.getByLabel('Where was consent collected?').fill('In-store loyalty form')
  await page.getByLabel('Consent evidence').fill('Signed loyalty forms, kept at head office')
  await page.getByRole('checkbox', { name: /I confirm/ }).check()
  await page.getByRole('button', { name: 'Start import' }).click()
  await expect(page.getByTestId('import-status')).toHaveText('Import complete', { timeout: 30_000 })

  // Put the quiet-hours window away from "now" (India time) so promotional texts go out immediately.
  const istHour = (new Date().getUTCHours() + 5 + (new Date().getUTCMinutes() + 30 >= 60 ? 1 : 0)) % 24
  const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`
  await navTo(page, 'Settings')
  await page.getByRole('tab', { name: 'Delivery' }).click()
  await page.getByLabel('Quiet hours start').fill(hh(istHour + 3))
  await page.getByLabel('Quiet hours end').fill(hh(istHour + 4))
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled()

  // The SMS overview asks for setup first.
  await navTo(page, 'SMS')
  await expect(page.getByTestId('sms-setup')).toBeVisible()

  // DLT entity registration.
  await navTo(page, 'DLT & 10DLC')
  await page.getByLabel('Principal Entity ID').fill('1101456789012345678')
  await page.getByLabel('Registered entity name').fill('Chai Texts Pvt Ltd')
  await page.getByRole('checkbox', { name: 'Confirm registration' }).check()
  await page.getByRole('button', { name: 'Save registration' }).click()
  await expect(page.getByTestId('registration-confirmed')).toContainText('Confirmed by Sana SMS')

  // Header: wrong format is explained, then a valid one is added and confirmed.
  await navTo(page, 'Sender IDs')
  await page.getByRole('button', { name: 'Add sender ID' }).first().click()
  await page.getByLabel('Header', { exact: true }).fill('CHAIIN')
  await page.getByRole('dialog').getByRole('button', { name: 'Add sender ID' }).click()
  await expect(page.getByRole('dialog')).toContainText('exactly 6 digits')
  await page.getByLabel('Header', { exact: true }).fill('561234')
  await page.getByRole('dialog').getByRole('button', { name: 'Add sender ID' }).click()
  await page.getByRole('button', { name: 'Confirm registration' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'I confirm' }).click()
  await expect(page.getByText(/^Approved/)).toBeVisible()

  // DLT template with live match feedback.
  await navTo(page, 'Templates')
  await page.getByRole('button', { name: 'New template' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel('Name').fill('Monsoon offer')
  await dlg.getByLabel('Message', { exact: true }).fill('Hi {{first_name}}, monsoon chai offer is live. Order now!')
  await expect(dlg.getByTestId('segment-meter')).toContainText('1 SMS')
  await dlg.getByLabel('DLT template ID').fill('1107160000000012345')
  await dlg.getByLabel('Registered text').fill('Hi {#var#}, monsoon offer is live. Order now!')
  await expect(dlg.getByTestId('template-dlt-match')).toContainText('Doesn’t match')
  await dlg.getByLabel('Registered text').fill('Hi {#var#}, monsoon chai offer is live. Order now!')
  await expect(dlg.getByTestId('template-dlt-match')).toContainText('matches the registered text')
  await shot(page, '1-template')
  await dlg.getByRole('button', { name: 'Create template' }).click()
  await expect(page.getByText('DLT', { exact: true })).toBeVisible()

  // Campaign from the template.
  await page.getByRole('button', { name: 'Use' }).click()
  await expect(page.getByText('561234')).toBeVisible()
  await expect(page.getByTestId('save-state')).toBeVisible()
  await page.getByRole('button', { name: /Next: Message/ }).click()
  await expect(page.getByTestId('dlt-match')).toContainText('Matches the registered DLT template')
  await expect(page.getByTestId('phone-preview')).toContainText('Hi Asha, monsoon chai offer is live.')
  await shot(page, '2-message')
  await page.getByRole('button', { name: /Next: Audience/ }).click()
  await page.getByText('All reachable contacts').click()
  await expect(page.getByTestId('eligible-count')).toHaveText('2')
  await page.getByRole('button', { name: /Next: Review/ }).click()
  await expect(page.getByTestId('cost-estimate')).toContainText('₹0.50')
  await expect(page.getByTestId('launch')).toBeEnabled()
  await shot(page, '3-review')
  await page.getByTestId('launch').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Send now' }).click()

  // Report.
  await expect(page.getByRole('heading', { name: 'Monsoon offer', level: 1 })).toBeVisible()
  await expect(page.getByText('Simulation mode.')).toBeVisible()
  await expect(page.getByTestId('report-kpis')).toContainText('50.0%', { timeout: 20_000 })
  await expect(page.getByTestId('report-kpis')).toContainText('₹0.50')
  await expect(page.getByRole('cell', { name: 'undelivered' })).toBeVisible()
  await shot(page, '4-report')

  // The simulated text is in the development outbox.
  const outbox = await browser.newPage()
  await outbox.goto('/dev/sms')
  await expect(outbox.getByTestId('sms-outbox')).toContainText('Hi Priya, monsoon chai offer is live. Order now!')
  await outbox.close()

  // A STOP reply opts the contact out.
  await navTo(page, 'Replies')
  await page.getByRole('button', { name: 'Simulate a reply' }).click()
  await page.getByLabel('From (contact’s number)').fill(priya)
  await page.getByRole('dialog').getByRole('button', { name: 'Send reply' }).click()
  await expect(page.getByText('STOP processed · 1 contact(s) updated')).toBeVisible()
  await expect(page.getByText('Opted out · 1')).toBeVisible()
})
