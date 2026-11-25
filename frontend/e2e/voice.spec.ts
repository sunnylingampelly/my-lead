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

test('India voice: managed numbers, audio library, campaign, outcomes, call log, press-9 opt-out and an AI agent', async ({ page, browser }) => {
  test.setTimeout(240_000)
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

  // India requires a DLT entity registration (shared by voice; SMS itself is coming soon).
  await page.goto(`/apps/${page.url().match(/\/apps\/([^/?#]+)/)![1]}/voice/registration`)
  await page.getByLabel('Principal Entity ID').fill('1101456789012345678')
  await page.getByRole('checkbox', { name: 'Confirm registration' }).check()
  await page.getByRole('button', { name: 'Save registration' }).click()
  await expect(page.getByTestId('registration-confirmed')).toBeVisible()

  // Phone numbers are Signalcraft's job: nothing to get, choose or pay for, and no page for it.
  await navTo(page, 'Voice')
  await expect(page.getByTestId('voice-setup')).not.toContainText('phone number')
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Phone numbers' })).toHaveCount(0)
  const appId = page.url().match(/\/apps\/([^/?#]+)/)![1]
  await page.goto(`/apps/${appId}/voice/numbers`)
  await expect(page).toHaveURL(new RegExp(`/apps/${appId}/voice$`))

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
  await expect(page.getByTestId('managed-number-note')).toBeVisible()
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

  // ---------------------------------------------------------------- AI agent
  // Create from a template, test it in the browser (simulated without an API key), teach it a rule.
  await navTo(page, 'AI agents')
  await page.getByTestId('new-agent').click()
  const na = page.getByRole('dialog')
  await expect(na.getByRole('radio', { name: /Lead qualification/ })).toHaveAttribute('aria-checked', 'true')
  await na.getByLabel('Agent name').fill('Maya')
  await na.getByTestId('create-agent').click()
  await expect(page.getByRole('heading', { name: 'Maya', exact: true })).toBeVisible()
  await expect(page.getByTestId('agent-status')).toHaveText('Draft')
  const chat = page.getByTestId('chat')
  await expect(chat.getByTestId('chat-agent').first()).toContainText('this is Maya calling from')
  await expect(page.getByTestId('simulated-badge')).toBeVisible()
  await page.getByLabel('Your reply').fill('Hi, who is this?')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(chat.getByTestId('chat-agent')).toHaveCount(2)
  await expect(chat.getByTestId('chat-user')).toHaveText('Hi, who is this?')
  await page.getByLabel('Your reply').fill("Yes, I'm interested. Call me back tomorrow.")
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(chat.getByTestId('chat-agent')).toHaveCount(3)
  await page.getByTestId('evaluate').click()
  await expect(page.getByTestId('evaluation')).toContainText('Simulated summary')
  await expect(page.getByTestId('evaluation')).toContainText('Interest: Hot')
  await expect(page.getByTestId('evaluation')).toContainText('Timeline')
  await page.getByLabel('Add this as a rule').fill('Always offer a free tasting at our store.')
  await page.getByTestId('add-rule-button').click()
  await expect(page.getByLabel('Instructions')).toHaveValue(/- Always offer a free tasting at our store\.$/)
  await page.getByTestId('save-agent').click()
  await expect(page.getByTestId('save-agent')).toBeDisabled()
  await page.getByRole('button', { name: 'Restart conversation' }).click()
  await expect(chat.getByTestId('chat-agent')).toHaveCount(1)
  await page.getByTestId('toggle-agent').click()
  await expect(page.getByTestId('agent-status')).toHaveText('Active')

  // A campaign where the AI agent holds the conversation.
  await navTo(page, 'Calls')
  await page.getByRole('button', { name: 'New voice campaign' }).first().click()
  await expect(page.getByLabel('Campaign name')).toBeVisible()
  await page.getByLabel('Campaign name').fill('Chai AI follow-up')
  await page.getByRole('radio', { name: 'Transactional', exact: true }).click()
  await expect(page.getByTestId('managed-number-note')).toBeVisible()
  await page.getByRole('button', { name: /Next: Message/ }).click()
  await page.getByTestId('message-type-ai_agent').click()
  await page.getByRole('radio', { name: 'Maya' }).check()
  await expect(page.getByTestId('ai-price')).toContainText('₹6.00 per started minute')
  await expect(page.getByTestId('script-preview')).toContainText('this is Maya calling from')
  await page.getByRole('button', { name: /Next: Audience/ }).click()
  await page.getByText('All reachable contacts').click()
  await page.getByRole('button', { name: /Next: Review/ }).click()
  await expect(page.getByTestId('cost-estimate')).toContainText('AI rate')
  await expect(page.getByTestId('launch')).toBeEnabled()
  await page.getByTestId('launch').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Start calling' }).click()

  // The call log: open an AI call and read the transcript, summary and captured fields.
  await expect(page.getByRole('heading', { name: 'Chai AI follow-up', level: 1 })).toBeVisible()
  const aiCall = page.getByTestId('view-call').filter({ hasText: 'Simulated summary' }).first()
  await expect(aiCall).toBeVisible({ timeout: 30_000 })
  await aiCall.click()
  const detail = page.getByTestId('call-detail')
  await expect(detail.getByTestId('transcript')).toContainText('this is Maya calling from')
  await expect(detail.getByTestId('call-summary')).toContainText('Simulated summary')
  await expect(detail).toContainText('Captured')
  await shot(page, 'v4-ai-call')
  // The contact's CRM timeline has the AI call with a link back to it.
  await detail.getByRole('link', { name: 'Open contact' }).click()
  await page.getByRole('tab', { name: /CRM|Activity/ }).first().click()
  await expect(page.getByTestId('timeline-ai-call').first()).toContainText('Simulated summary')
  await expect(page.getByTestId('timeline-ai-call').first().getByRole('link', { name: 'View call' })).toBeVisible()
})
