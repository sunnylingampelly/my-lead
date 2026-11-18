import { expect, test } from '@playwright/test'
import { createOrgAndApp, navTo, registerAndVerify, uniqueEmail } from './helpers'

// Set SHOTS=<dir> to save screenshots of the main voice screens for visual review.
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true })
}

function wav(seconds: number) {
  const rate = 8000
  const n = rate * seconds
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 2, 40)
  return b
}

test('India voice: caller ID, audio library, campaign, outcomes, call log and press-9 opt-out', async ({ page, browser }) => {
  test.setTimeout(150_000)
  const tag = String(Date.now()).slice(-5)
  await registerAndVerify(page, 'Vani Voice', uniqueEmail('voice'))
  await createOrgAndApp(page, 'Chai Calls', 'Chai Voice')

  // Contacts with consent to calls: one answers, one never answers, one presses 9.
  const priya = `+9198765${tag}`
  await navTo(page, 'Import')
  const csv = ['Name,Phone', `Priya Nair,${priya}`, 'Arun Das,+919876500000', 'Meera Iyer,+919876599999'].join('\n')
  await page.getByTestId('import-file').setInputFiles({ name: 'phones.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await page.getByRole('button', { name: /Validate/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('checkbox', { name: 'Voice calls', exact: true }).check()
  await page.getByLabel('Where was consent collected?').fill('Loyalty sign-up desk')
  await page.getByLabel('Consent evidence').fill('Signed loyalty forms')
  await page.getByRole('checkbox', { name: /I confirm/ }).check()
  await page.getByRole('button', { name: 'Start import' }).click()
  await expect(page.getByTestId('import-status')).toHaveText('Import complete', { timeout: 30_000 })

  // Quiet hours away from "now" (India time) so calls go out immediately.
  const now = new Date()
  const istHour = (now.getUTCHours() + 5 + (now.getUTCMinutes() + 30 >= 60 ? 1 : 0)) % 24
  const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`
  await navTo(page, 'Settings')
  await page.getByRole('tab', { name: 'Delivery' }).click()
  await page.getByLabel('Quiet hours start').fill(hh(istHour + 3))
  await page.getByLabel('Quiet hours end').fill(hh(istHour + 4))
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled()

  // India requires a DLT entity registration.
  await navTo(page, 'DLT & 10DLC')
  await page.getByLabel('Principal Entity ID').fill('1101456789012345678')
  await page.getByRole('checkbox', { name: 'Confirm registration' }).check()
  await page.getByRole('button', { name: 'Save registration' }).click()
  await expect(page.getByTestId('registration-confirmed')).toBeVisible()

  // Caller ID: a normal mobile is refused; a 160-series number is added and confirmed.
  await navTo(page, 'Voice')
  await expect(page.getByTestId('voice-setup')).toBeVisible()
  await navTo(page, 'Caller IDs')
  await page.getByRole('button', { name: 'Add caller ID' }).first().click()
  await page.getByLabel('Number type').selectOption('series_160')
  await page.getByLabel('Number', { exact: true }).fill('+919876543210')
  await page.getByRole('dialog').getByRole('button', { name: 'Add caller ID' }).click()
  await expect(page.getByRole('dialog')).toContainText('160-series number')
  await page.getByLabel('Number', { exact: true }).fill('+911601234567')
  await page.getByRole('dialog').getByRole('button', { name: 'Add caller ID' }).click()
  await page.getByRole('button', { name: 'Confirm ownership' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'I confirm' }).click()
  await expect(page.getByText(/^Approved/)).toBeVisible()

  // Audio library: upload a recording and write a text-to-speech message.
  await navTo(page, 'Audio library')
  await page.getByTestId('audio-file').setInputFiles({ name: 'welcome.wav', mimeType: 'audio/wav', buffer: wav(2) })
  await expect(page.getByText('Recording · WAV · 2s')).toBeVisible()
  await page.getByRole('button', { name: 'Text to speech' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel('Name').fill('Order update')
  await dlg.getByLabel('What should the call say?').fill('Namaste {{first_name}}, your Chai order has shipped and arrives tomorrow.')
  await dlg.getByRole('button', { name: 'Save message' }).click()
  await expect(page.getByText('Order update')).toBeVisible()
  await shot(page, 'v1-library')

  // Campaign from the message.
  await page.getByRole('button', { name: 'Use' }).first().click()
  await page.getByRole('radio', { name: 'Transactional', exact: true }).click()
  await expect(page.getByText('+911601234567')).toBeVisible()
  await page.getByRole('button', { name: /Next: Message/ }).click()
  await expect(page.getByTestId('script-preview')).toContainText('Namaste Asha, your Chai order has shipped')
  await expect(page.getByTestId('script-preview')).toContainText('To stop receiving these calls, press 9.')
  await shot(page, 'v2-message')
  await page.getByRole('button', { name: /Next: Audience/ }).click()
  await page.getByText('All reachable contacts').click()
  await expect(page.getByTestId('eligible-count')).toHaveText('3')
  await page.getByRole('button', { name: /Next: Review/ }).click()
  await expect(page.getByTestId('cost-estimate')).toContainText('₹1.80')
  await expect(page.getByTestId('launch')).toBeEnabled()
  await page.getByTestId('launch').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Start calling' }).click()

  // Report: one answered, one opted out, one waiting for a retry.
  await expect(page.getByRole('heading', { name: 'Order update', level: 1 })).toBeVisible()
  await expect(page.getByText('Simulation mode.')).toBeVisible()
  await expect(page.getByTestId('outcomes')).toContainText('Answered', { timeout: 20_000 })
  await expect(page.getByTestId('report-kpis')).toContainText('Opted out1')
  await expect(page.getByTestId('waiting-banner')).toContainText('1 call will be retried')
  await expect(page.getByText('Pressed 9')).toBeVisible()
  await shot(page, 'v3-report')

  // The simulated calls are in the development call log.
  const log = await browser.newPage()
  await log.goto('/dev/calls')
  await expect(log.getByTestId('call-log')).toContainText('Namaste Priya, your Chai order has shipped')
  await log.close()
})
