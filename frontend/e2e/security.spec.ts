import { createHmac } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createOrgAndApp, navTo, PASSWORD, registerAndVerify, uniqueEmail } from './helpers'

// ------------------------------------------------------------------ RFC 6238 (TOTP), no dependency

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = input.replace(/[\s=]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch)
    if (idx < 0) throw new Error(`invalid base32 character ${ch}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** The 6-digit code for `secret` at `atMs` (HMAC-SHA1, 30 s steps), as authenticator apps compute it. */
function totp(secret: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30)
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return String(code).padStart(6, '0')
}

test('RFC 6238 helper matches the published test vector', () => {
  // Secret "12345678901234567890" at T=59s → 94287082 (8 digits) → 287082 (6 digits).
  expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082')
})

async function signOut(page: Page) {
  await page.getByTestId('profile-menu').click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
}

async function signInWithPassword(page: Page, email: string) {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('turn on two-factor, sign out and back in with a code, then erase a contact', async ({ page }) => {
  test.setTimeout(120_000)
  const email = uniqueEmail('mfa')
  await registerAndVerify(page, 'Tara Twofactor', email)
  await createOrgAndApp(page, 'Secure Org', 'Secure App')

  // Account → Security: scan (read the key), confirm a code, see 10 recovery codes once.
  await page.getByTestId('profile-menu').click()
  await page.getByRole('menuitem', { name: 'Account and security' }).click()
  await page.getByRole('button', { name: 'Set up two-factor authentication' }).click()
  const setup = page.getByTestId('mfa-setup')
  await expect(setup.getByRole('img', { name: /QR code/ })).toBeVisible()
  const secret = (await page.getByTestId('mfa-secret').getAttribute('data-secret'))!
  expect(secret).toMatch(/^[A-Z2-7]{32}$/)
  await setup.getByLabel('6-digit code').fill(totp(secret))
  await setup.getByRole('button', { name: 'Turn on' }).click()
  await expect(page.getByTestId('recovery-code')).toHaveCount(10)
  const recovery = await page.getByTestId('recovery-code').allTextContents()
  await page.getByRole('button', { name: 'I saved them' }).click()
  await expect(page.locator('#two-factor').getByText('On', { exact: true })).toBeVisible()

  // Sign out; the password alone is not enough any more.
  await signOut(page)
  await signInWithPassword(page, email)
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible()
  await page.getByLabel('Authentication code').fill('000000' === totp(secret) ? '111111' : '000000')
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('alert')).toContainText('not valid')
  // The code used to turn 2FA on can't be replayed: use the next time step (accepted within ±1 step).
  await page.getByLabel('Authentication code').fill(totp(secret, Date.now() + 30_000))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByTestId('app-switcher')).toContainText('Secure App')

  // A recovery code also works, once.
  await signOut(page)
  await signInWithPassword(page, email)
  await page.getByRole('button', { name: 'Use a recovery code' }).click()
  await page.getByLabel('Recovery code').fill(recovery[0])
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByTestId('app-switcher')).toContainText('Secure App')

  // Erase a contact from its profile.
  await navTo(page, 'All contacts')
  await page.getByRole('button', { name: 'Add contact' }).first().click()
  const form = page.getByRole('dialog')
  await form.getByLabel('First name').fill('Esha')
  await form.getByLabel('Last name').fill('Eraseme')
  const contactEmail = uniqueEmail('erase')
  await form.locator('#c-email').fill(contactEmail)
  await form.getByRole('button', { name: 'Add contact' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await page.getByText('Esha Eraseme').first().click()
  await expect(page.getByRole('heading', { name: 'Esha Eraseme', level: 1 })).toBeVisible()

  await page.getByTestId('privacy-menu').click()
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: 'Download all data' }).click()
  expect((await download).suggestedFilename()).toMatch(/^contact-data-.*\.zip$/)

  // The menu closes after the download; reopen it once it has.
  await expect(page.getByRole('menu')).toBeHidden()
  await page.getByTestId('privacy-menu').click()
  await page.getByRole('menuitem', { name: 'Erase this contact' }).click()
  const dialog = page.getByRole('alertdialog')
  const confirm = dialog.getByRole('button', { name: 'Erase permanently' })
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel('Type "ERASE" to confirm').fill('ERASE')
  await confirm.click()
  await expect(page.getByText('Contact erased')).toBeVisible()
  await expect(page).toHaveURL(/\/audience\/contacts$/)
  await expect(page.getByText('Esha Eraseme')).toHaveCount(0)

  // The organization's data-request log shows both, without the person's details.
  const orgs = await page.evaluate(async () => {
    const r = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })
    const token = ((await r.json()) as { access_token: string }).access_token
    const o = await fetch('/api/v1/organizations', { headers: { Authorization: `Bearer ${token}` } })
    return (await o.json()) as { id: string }[]
  })
  await page.goto(`/orgs/${orgs[0].id}/settings`)
  const log = page.getByTestId('data-requests')
  await expect(log).toContainText('Erasure')
  await expect(log).toContainText('Data export')
  await expect(log).not.toContainText(contactEmail)
  await expect(log).toContainText('Tara Twofactor')
})
