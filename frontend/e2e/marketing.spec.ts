import { expect, test } from '@playwright/test'

/** The public marketing site: home, nine product pages, pricing. Visitors are signed out. */

const PRODUCTS = ['lead-forms', 'chatbot', 'email', 'sms', 'voice', 'crm', 'automation', 'analytics', 'ai-team']

test('home: hero, bento links to product pages, FAQ', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Capture every lead')
  await expect(page).toHaveTitle(/Signalcraft/)
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /Lead forms/)

  // The animated product story has four tabs.
  await expect(page.getByRole('tab')).toHaveCount(4)
  await page.getByRole('tab', { name: /Close/ }).click()
  await expect(page.getByTestId('demo-crm')).toBeVisible()

  // A bento card opens its product page.
  const bento = page.locator('#products')
  await bento.scrollIntoViewIfNeeded()
  await bento.getByRole('link', { name: /Email campaigns/ }).click()
  await expect(page).toHaveURL(/\/products\/email$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  // FAQ accordion.
  await page.goto('/#faq')
  await page.getByRole('button', { name: 'Do I need my own phone number for calls?' }).click()
  await expect(page.getByText(/places calls from numbers it manages/)).toBeVisible()
})

for (const slug of PRODUCTS) {
  test(`product page ${slug}: h1, demo, live pricing, FAQ`, async ({ page }) => {
    await page.goto(`/products/${slug}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByTestId(`demo-${slug}`)).toBeVisible()
    await expect(page).toHaveTitle(/Signalcraft/)
    await expect(page.getByTestId('product-pricing')).toBeAttached()
  })
}

test('unknown product shows a friendly 404 inside the site', async ({ page }) => {
  await page.goto('/products/does-not-exist')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('couldn’t find that product')
  await expect(page.getByRole('button', { name: 'Products' })).toBeVisible()
})

test('Products mega-menu opens and navigates (desktop)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/pricing')
  const trigger = page.getByRole('button', { name: 'Products' })
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  const menu = page.getByRole('navigation', { name: 'Products menu' })
  await expect(menu.getByRole('link')).toHaveCount(9)
  await menu.getByRole('link', { name: /^CRM/ }).click()
  await expect(page).toHaveURL(/\/products\/crm$/)

  // Keyboard: ArrowDown opens and focuses the first item, Escape closes.
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('navigation', { name: 'Products menu' }).getByRole('link').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('mobile menu works at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  const sheet = page.getByRole('dialog', { name: 'Menu' })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('link', { name: /^SMS/ }).click()
  await expect(page).toHaveURL(/\/products\/sms$/)
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Pricing', exact: true }).click()
  await expect(page).toHaveURL(/\/pricing$/)
})

test('pricing: live plan prices, comparison, rate card, calculator', async ({ page }) => {
  await page.goto('/pricing')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Simple pricing')

  // INR: ₹2,999 + GST, fractional rates keep their decimals.
  await page.getByRole('radio', { name: '₹ INR' }).click()
  await expect(page.getByTestId('plan-pro')).toContainText('₹2,999')
  await expect(page.getByTestId('plan-pro')).toContainText('+ GST')
  await expect(page.getByTestId('rate-card')).toContainText('₹1.50')
  await expect(page.getByTestId('calculator')).toContainText('GST on top-ups')

  // USD: $49, no GST.
  await page.getByRole('radio', { name: '$ USD' }).click()
  await expect(page.getByTestId('plan-pro')).toContainText('$49')
  await expect(page.getByTestId('plan-pro')).not.toContainText('GST')

  // Comparison table.
  const table = page.getByTestId('comparison-table')
  await expect(table).toBeVisible()
  await expect(table).toContainText('AI calling agents')
  await expect(table).toContainText('Unlimited')

  // Calculator: Starter is cheaper at low volume; Pro wins at high volume.
  const result = page.getByTestId('calc-result')
  await result.scrollIntoViewIfNeeded()
  await expect(result).toHaveAttribute('data-cheaper', 'starter')
  const starterTotal = page.getByTestId('calc-starter-total')
  const before = await starterTotal.getAttribute('data-value')
  await page.getByLabel('Emails per month, exact number').fill('20000')
  await expect(starterTotal).not.toHaveAttribute('data-value', before ?? '')
  await page.getByRole('button', { name: 'Scaling' }).click()
  await expect(result).toHaveAttribute('data-cheaper', 'pro')
  await expect(page.getByTestId('calc-cheaper-pro')).toBeVisible()
  await expect(page.getByTestId('calc-break-even')).toContainText('Pro pays for itself')

  // The slider recomputes too.
  await page.getByRole('button', { name: 'Just starting' }).click()
  await expect(result).toHaveAttribute('data-cheaper', 'starter')
  await page.getByRole('slider', { name: 'AI calling minutes' }).fill('10000')
  await expect(result).toHaveAttribute('data-cheaper', 'pro')
})

test('SMS is coming soon: product page, menu, bento, rate card and calculator', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // Product page: a "Coming soon" badge, no live price and no "Start free" pitch.
  await page.goto('/products/sms')
  await expect(page.getByTestId('product-coming-soon')).toBeVisible()
  await expect(page.getByTestId('product-coming-soon')).toContainText('Coming soon')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('coming soon')
  const hero = page.locator('section[aria-labelledby="product-title"]')
  await expect(hero.getByRole('link', { name: 'Start free' })).toHaveCount(0)
  const pricing = page.getByTestId('product-pricing')
  await expect(pricing).toContainText('Coming soon')
  await expect(pricing.locator('table')).toHaveCount(0)

  // Mega-menu and bento card carry a "Soon" tag.
  await page.getByRole('button', { name: 'Products' }).click()
  const menu = page.getByRole('navigation', { name: 'Products menu' })
  await expect(menu.getByRole('link', { name: /^SMS/ }).getByTestId('soon-tag')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.goto('/')
  const bento = page.locator('#products')
  await bento.scrollIntoViewIfNeeded()
  await expect(bento.getByRole('link', { name: /^SMS/ }).getByTestId('soon-tag')).toBeVisible()
  await expect(page.getByText(/email and AI voice calls, a CRM and automation in one workspace \(SMS coming soon\)/)).toBeVisible()

  // Pricing: SMS has no price in any currency, and the calculator has no SMS slider.
  await page.goto('/pricing')
  for (const currency of ['₹ INR', 'AED', '$ USD']) {
    await page.getByRole('radio', { name: currency }).click()
    await expect(page.getByTestId('rate-sms-soon')).toContainText('Coming soon')
    await expect(page.getByTestId('rate-card')).not.toContainText('per message part')
  }
  await expect(page.getByTestId('calculator')).not.toContainText('SMS per month')
  await expect(page.getByRole('slider', { name: /SMS/ })).toHaveCount(0)
})

test('pricing in AED: toggle, Pro at AED 179 and the UAE note', async ({ page }) => {
  await page.goto('/pricing')
  await page.getByRole('radio', { name: 'AED' }).click()
  await expect(page.getByRole('radio', { name: 'AED' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('plan-pro')).toContainText(/AED\s179/)
  await expect(page.getByTestId('plan-pro')).not.toContainText('GST')
  await expect(page.getByTestId('uae-pricing-note')).toContainText('reverse charge')
  await expect(page.getByTestId('uae-pricing-note')).toContainText('TRN')
})

test('no horizontal scroll at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const path of ['/', '/products/voice', '/pricing']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const sw = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(sw, path).toBeLessThanOrEqual(391)
  }
})

test('renders with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Capture every lead')
  await expect(page.getByTestId('demo-lead-forms')).toBeVisible()
  await page.goto('/products/automation')
  await expect(page.getByTestId('demo-automation')).toBeVisible()
  await page.goto('/pricing')
  await expect(page.getByTestId('plan-pro')).toBeVisible()
})

test('start free opens sign-up', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: /Start free/ }).first().click()
  await expect(page).toHaveURL(/\/register$/)
})
