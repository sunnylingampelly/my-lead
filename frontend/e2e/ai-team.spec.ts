import { expect, test, type Page } from '@playwright/test'
import { createOrgAndApp, registerAndVerify, uniqueEmail } from './helpers'

/**
 * AI Team in simulation mode (no OPENAI_API_KEY, no Slack app configured): the assistant panel (Ctrl+J), a read
 * answer with deep links, a confirmed write (task), an agent from the "Daily performance report" template posting
 * to the simulated Slack log, the approval flow, and the panel at 390px.
 */

async function apiToken(page: Page): Promise<string> {
  const r = await page.request.post('/api/v1/auth/refresh')
  expect(r.ok()).toBeTruthy()
  return ((await r.json()) as { access_token: string }).access_token
}

function appIdFrom(page: Page): string {
  const m = /\/apps\/([0-9a-f-]{36})/.exec(page.url())
  expect(m).toBeTruthy()
  return m![1]!
}

async function ask(page: Page, text: string) {
  const input = page.getByTestId('ai-input')
  await input.fill(text)
  await input.press('Enter')
}

test('AI Team: assistant answers and confirms, agents report to Slack, approvals', async ({ page }) => {
  test.setTimeout(180_000)
  await registerAndVerify(page, 'Asha Rao', uniqueEmail('aiteam'))
  await createOrgAndApp(page, 'AI Co', 'AI Desk')
  const appId = appIdFrom(page)
  const token = await apiToken(page)
  const headers = { Authorization: `Bearer ${token}` }
  const c = await page.request.post(`/api/v1/apps/${appId}/contacts`, { headers, data: { first_name: 'Priya', last_name: 'Nair', email: 'priya@nair-industries.example' } })
  expect(c.status()).toBe(201)

  // The assistant opens with Ctrl+J, in simulation mode.
  await page.keyboard.press('Control+j')
  const panel = page.getByTestId('ai-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('ai-simulated')).toBeVisible()
  // Simulation mode is free, and says so.
  await expect(panel.getByTestId('ai-price-hint')).toContainText('free')
  await expect(page.getByTestId('ai-input')).toBeFocused()

  // A read question: an answer with deep links.
  await ask(page, 'show my stale deals')
  const answer = panel.getByTestId('ai-message').last()
  await expect(answer).toContainText(/stale deal/i)
  await expect(answer.getByTestId('ai-link').first()).toBeVisible()
  await expect(panel.getByTestId('ai-usage')).toContainText('1/200')
  await expect(answer.getByTestId('ai-charge')).toHaveText(/Simulated, no charge/i)

  // A write: an action card that only runs on Confirm.
  await ask(page, 'create a task to call Priya tomorrow')
  const card = panel.getByTestId('action-card').last()
  await expect(card).toHaveAttribute('data-status', 'pending')
  await expect(card).toContainText('Create task: Call Priya')
  await expect(card).toContainText('Priya Nair')
  let tasks = await page.request.get(`/api/v1/apps/${appId}/crm/tasks?status=open`, { headers: { Authorization: `Bearer ${await apiToken(page)}` } })
  expect(((await tasks.json()) as { total: number }).total).toBe(0)
  await card.getByTestId('action-confirm').click()
  await expect(card).toHaveAttribute('data-status', 'executed')
  await expect(card.getByRole('link', { name: 'Open task' })).toBeVisible()
  tasks = await page.request.get(`/api/v1/apps/${appId}/crm/tasks?status=open`, { headers: { Authorization: `Bearer ${await apiToken(page)}` } })
  const body = (await tasks.json()) as { items: { title: string }[] }
  expect(body.items.map((t) => t.title)).toContain('Call Priya')
  await panel.getByRole('button', { name: 'Close assistant' }).click()
  await expect(panel).toBeHidden()

  // Simulated Slack connection.
  await page.goto(`/apps/${appId}/ai/integrations`)
  await page.getByTestId('slack-simulate').click()
  await expect(page.getByTestId('slack-card')).toContainText('Simulated Slack')

  // An agent from the "Daily performance report" template, posting to #general.
  await page.goto(`/apps/${appId}/ai/agents`)
  await page.getByTestId('use-template-daily_report').click()
  const editor = page.getByTestId('agent-editor')
  await expect(editor.getByTestId('agent-name')).toHaveValue('Daily performance report')
  await editor.getByTestId('slack-channel-general').click()
  await editor.getByTestId('agent-save').click()
  await expect(page.getByRole('heading', { name: 'Daily performance report' })).toBeVisible()
  await page.getByTestId('agent-detail-toggle').click()
  await expect(page.getByTestId('agent-detail-toggle')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('agent-run-now').click()
  const log = page.getByTestId('run-detail')
  await expect(log).toContainText('Completed')
  await expect(log.getByTestId('run-cost')).toContainText('Simulated, no charge')
  await expect(log.getByTestId('run-step').first()).toContainText('Analytics summary')
  await expect(log.locator('[data-kind="deliver"]')).toContainText('Posted to Slack #general')

  // Approval flow: the chat follow-up drafter (approval mode) proposes a draft email for the newest lead.
  await page.goto(`/apps/${appId}/ai/agents`)
  await page.getByTestId('use-template-chat_followup').click()
  await page.getByTestId('agent-editor').getByTestId('slack-channel-sales').click()
  await page.getByTestId('agent-editor').getByTestId('agent-save').click()
  await expect(page.getByRole('heading', { name: 'Chat follow-up drafter' })).toBeVisible()
  await page.getByTestId('agent-run-now').click()
  await expect(page.getByTestId('run-detail').locator('[data-kind="proposed"]')).toContainText('Approval needed')
  await expect(page.getByTestId('approvals-badge')).toHaveText('1')
  await page.goto(`/apps/${appId}/ai/approvals`)
  const approval = page.getByTestId('action-card').first()
  await expect(approval).toContainText('Create draft email')
  await approval.getByTestId('action-confirm').click()
  await expect(approval).toHaveAttribute('data-status', 'executed')
  await expect(approval.getByRole('link', { name: 'Review draft' })).toBeVisible()

  // The simulated Slack log has the report and the approval request (now marked approved).
  // Simulation charged nothing: no AI transactions in billing.
  const txs = await page.request.get(`/api/v1/apps/${appId}/billing/transactions`, { headers })
  const txBody = (await txs.json()) as { items: { channel: string | null }[] }
  expect(txBody.items.filter((t) => t.channel === 'ai')).toHaveLength(0)

  await page.goto('/dev/slack')
  const items = page.getByTestId('slack-log-item')
  await expect(items.filter({ hasText: 'Daily performance report' }).first()).toBeVisible()
  await expect(items.filter({ hasText: 'Approved by Asha Rao' }).first()).toBeVisible()
})

test('AI assistant panel works at 390px', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await registerAndVerify(page, 'Mobile Mira', uniqueEmail('aimobile'))
  await createOrgAndApp(page, 'Mobile Co', 'Mobile Desk')
  await page.getByTestId('ai-fab').click()
  const panel = page.getByTestId('ai-panel')
  await expect(panel).toBeVisible()
  const box = await panel.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(388)
  await expect(panel.getByTestId('ai-empty')).toBeVisible()
  await panel.getByRole('button', { name: 'How did we do this week?' }).first().click()
  await expect(panel.getByTestId('ai-message').last()).toContainText(/Emails sent/)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})
