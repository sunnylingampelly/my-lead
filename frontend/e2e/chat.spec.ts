import { expect, test, type Page } from '@playwright/test'
import { createOrgAndApp, registerAndVerify, uniqueEmail } from './helpers'

// Set SHOTS=<dir> to save screenshots of the chat screens for visual review.
const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true })
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
}

test('website chatbot: create from a template, train, test, chat as a visitor, hand over to a person, close, CRM', async ({ page, browser }) => {
  test.setTimeout(240_000)
  await registerAndVerify(page, 'Olivia Owner', uniqueEmail('chat'))
  await createOrgAndApp(page, 'Chai Co', 'Chai Web')
  const appId = new URL(page.url()).pathname.split('/')[2]!
  const base = `/apps/${appId}`

  // Create a bot from a template.
  await page.goto(`${base}/chat/bots`)
  await page.getByTestId('new-bot').click()
  await page.getByRole('radio', { name: /Website assistant/ }).click()
  await page.getByLabel('Name').fill('Chai Helper')
  // The website is required: the chat only runs on the sites you list.
  await page.getByTestId('create-bot').click()
  await expect(page.getByRole('dialog')).toContainText('Add the website where this chat will appear')
  await page.getByLabel('Website').fill('https://www.ChaiAndCo.in/contact')
  await page.getByTestId('create-bot').click()
  await expect(page.getByRole('heading', { name: 'Chai Helper' })).toBeVisible()

  // Train it with a FAQ.
  await page.getByLabel('Question').fill('What are your opening hours?')
  await page.getByLabel('Answer').fill("We're open 9 to 6, Monday to Friday.")
  await page.getByTestId('add-faq').click()
  await expect(page.getByTestId('sources').getByText('What are your opening hours?')).toBeVisible()

  // Test chat answers from the FAQ.
  await page.getByTestId('test-input').fill('What are your opening hours?')
  await page.getByTestId('test-input').press('Enter')
  await expect(page.getByTestId('test-reply').first()).toContainText('9 to 6', { timeout: 60_000 })

  // Ask for contact details after the first visitor message, then publish.
  await page.getByRole('tab', { name: 'Lead capture' }).click()
  await page.getByLabel('When to ask for contact details').selectOption('after')
  await page.getByLabel('After this many visitor messages').fill('1')
  await page.getByRole('button', { name: 'Save lead capture' }).click()
  await expect(page.getByText('Saved').first()).toBeVisible()
  await page.getByTestId('publish-bot').click()
  await expect(page.getByTestId('bot-status')).toHaveText('Live')
  await page.getByRole('tab', { name: 'Install' }).click()
  // The website typed at creation, cleaned up; another can be added, and a live bot keeps at least one.
  const sites = page.getByTestId('websites-card')
  await expect(sites.getByTestId('website-chip')).toHaveText(['www.chaiandco.in'])
  await expect(sites.getByRole('button', { name: 'Remove www.chaiandco.in' })).toBeDisabled()
  await sites.getByLabel('Add a website').fill('not a website')
  await sites.getByRole('button', { name: 'Add website' }).click()
  await expect(sites).toContainText('Enter a website like example.com')
  await sites.getByLabel('Add a website').fill('*.chaiandco.in')
  await sites.getByRole('button', { name: 'Add website' }).click()
  await expect(sites.getByTestId('website-chip')).toHaveText(['www.chaiandco.in', '*.chaiandco.in'])
  const snippet = await page.getByTestId('snippet').textContent()
  const key = /data-bot="([^"]+)"/.exec(snippet ?? '')![1]!
  await shot(page, 'chat-bot-editor')

  // The team member goes online in the inbox.
  await page.goto(`${base}/chat/inbox`)
  await page.getByTestId('presence').selectOption('online')

  // A visitor chats on the widget page (as served inside the iframe).
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const visitor = await ctx.newPage()
  await visitor.goto(`/embed/chat/${key}`)
  const input = visitor.getByRole('textbox', { name: 'Message' })
  await input.fill('What are your opening hours?')
  await input.press('Enter')
  await expect(visitor.getByRole('log', { name: 'Chat messages' })).toContainText('9 to 6', { timeout: 60_000 })
  // The lead form follows the first message.
  const form = visitor.getByRole('form', { name: 'Your contact details' })
  await form.getByRole('textbox', { name: /Name/ }).fill('Asha Rao')
  await form.getByRole('textbox', { name: /Email/ }).fill('asha.chat@example.com')
  await form.getByRole('checkbox').check()
  await form.getByRole('button', { name: 'Send' }).click()
  await expect(visitor.getByRole('log', { name: 'Chat messages' }).getByText(/Thanks, Asha!/)).toBeVisible()
  await visitor.getByRole('button', { name: 'Talk to a human' }).last().click()
  await expect(visitor.getByRole('log', { name: 'Chat messages' }).getByText(/Connecting you with a team member/)).toBeVisible()
  await noHorizontalScroll(visitor)
  await shot(visitor, 'chat-widget-390')

  // The agent takes over and replies; the visitor sees it.
  await expect(page.getByTestId('conversation-row').filter({ hasText: 'Asha' })).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('conversation-row').filter({ hasText: 'Asha' }).click()
  await page.getByTestId('take-over').click()
  await page.getByTestId('reply-input').fill('Hi Asha, Olivia here. How can I help?')
  await page.getByTestId('reply-send').click()
  await expect(visitor.getByRole('note').filter({ hasText: 'Olivia joined the chat.' })).toBeVisible({ timeout: 15_000 })
  await expect(visitor.getByRole('log', { name: 'Chat messages' }).getByText('Hi Asha, Olivia here. How can I help?', { exact: true })).toBeVisible()
  await visitor.getByRole('textbox', { name: 'Message' }).fill('Thanks!')
  await visitor.getByRole('textbox', { name: 'Message' }).press('Enter')
  await expect(page.getByTestId('transcript')).toContainText('Thanks!', { timeout: 15_000 })
  await shot(page, 'chat-inbox')

  // Close: the AI summary appears.
  await page.getByTestId('close-chat').click()
  await expect(page.getByTestId('ai-summary')).toBeVisible({ timeout: 20_000 })
  await expect(visitor.getByText('How was this chat?')).toBeVisible({ timeout: 15_000 })

  // The contact exists with the chat on its timeline.
  await page.getByTestId('open-contact').click()
  await expect(page.getByText('asha.chat@example.com').first()).toBeVisible()
  const crmTab = page.getByRole('tab', { name: 'CRM & activity' })
  if (await crmTab.isVisible()) await crmTab.click()
  await expect(page.getByTestId('timeline-chat')).toBeVisible({ timeout: 15_000 })

  // Analytics and the inbox work at 390px.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${base}/chat`)
  await expect(page.getByText('Leads captured')).toBeVisible()
  await noHorizontalScroll(page)
  await page.goto(`${base}/chat/inbox`)
  await expect(page.getByTestId('conversation-list')).toBeVisible()
  await noHorizontalScroll(page)
  await ctx.close()
})
