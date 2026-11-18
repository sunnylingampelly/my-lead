import { expect, test } from '@playwright/test'
import { createOrgAndApp, linkFromMailbox, PASSWORD, registerAndVerify, uniqueEmail } from './helpers'

test('register, verify, create organization and application, land on dashboard', async ({ page }) => {
  const email = uniqueEmail('owner')
  await registerAndVerify(page, 'Olivia Owner', email)
  await createOrgAndApp(page, 'Acme E2E', 'Acme Retail')

  await expect(page.getByTestId('org-switcher')).toContainText('Acme E2E')
  await expect(page.getByTestId('app-switcher')).toContainText('Acme Retail')
  await expect(page.getByText('Getting started')).toBeVisible()
  await expect(page.getByText('created an application')).toBeVisible()

  // Session survives a reload through the httpOnly refresh cookie.
  await page.reload()
  await expect(page.getByTestId('app-switcher')).toContainText('Acme Retail')
})

test('sign out, wrong password, sign in and return to the last application', async ({ page }) => {
  const email = uniqueEmail('login')
  await registerAndVerify(page, 'Lee Login', email)
  await createOrgAndApp(page, 'Login Org', 'Login App')

  await page.getByTestId('profile-menu').click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()

  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('WrongPassword9')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('Incorrect email or password')

  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('app-switcher')).toContainText('Login App')
})

test('switch between applications and organizations', async ({ page }) => {
  await registerAndVerify(page, 'Sam Switch', uniqueEmail('switch'))
  await createOrgAndApp(page, 'First Org', 'Alpha App')

  // Second application in the same organization.
  await page.getByTestId('app-switcher').click()
  await page.getByRole('menuitem', { name: 'New application' }).click()
  await page.getByLabel('Application name').fill('Beta App')
  await page.getByRole('button', { name: 'Create application' }).click()
  await expect(page.getByTestId('app-switcher')).toContainText('Beta App')

  await page.getByTestId('app-switcher').click()
  await page.getByRole('menuitem', { name: 'Alpha App' }).click()
  await expect(page.getByText("Here's what's happening in Alpha App.")).toBeVisible()

  // Second organization.
  await page.getByTestId('org-switcher').click()
  await page.getByRole('menuitem', { name: 'Create organization' }).click()
  await page.getByLabel('Organization name').fill('Second Org')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel('Application name').fill('Gamma App')
  await page.getByRole('button', { name: 'Create application' }).click()
  await expect(page.getByTestId('org-switcher')).toContainText('Second Org')

  await page.getByTestId('org-switcher').click()
  await page.getByRole('menuitem', { name: 'First Org' }).click()
  await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible()
  const main = page.getByRole('main')
  await expect(main.getByRole('link', { name: /Alpha App/ })).toBeVisible()
  await expect(main.getByRole('link', { name: /Beta App/ })).toBeVisible()
  await expect(main.getByRole('link', { name: /Gamma App/ })).toHaveCount(0)
})

test('invite a teammate who joins with access to one application only', async ({ page, browser }) => {
  const ownerEmail = uniqueEmail('lead')
  const mateEmail = uniqueEmail('mate')
  await registerAndVerify(page, 'Lead Owner', ownerEmail)
  await createOrgAndApp(page, 'Team Org', 'Shared App')

  // Second app the teammate must not see.
  await page.getByTestId('app-switcher').click()
  await page.getByRole('menuitem', { name: 'New application' }).click()
  await page.getByLabel('Application name').fill('Private App')
  await page.getByRole('button', { name: 'Create application' }).click()
  await expect(page.getByTestId('app-switcher')).toContainText('Private App')

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Team', exact: true }).click()
  await page.getByRole('button', { name: 'Invite member' }).click()
  await page.getByRole('dialog').getByLabel('Email').fill(mateEmail)
  await page.getByLabel('Role').selectOption('campaign_manager')
  await page.getByRole('dialog').getByLabel('Shared App').check()
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByRole('cell', { name: mateEmail })).toBeVisible()

  const ctx = await browser.newContext()
  const mate = await ctx.newPage()
  await mate.goto(await linkFromMailbox(mate, mateEmail, '/invite'))
  await expect(mate.getByText('Team Org')).toBeVisible()
  await mate.getByRole('link', { name: 'Create account and join' }).click()
  await mate.getByLabel('Full name').fill('Mia Mate')
  await mate.getByLabel('Password').fill(PASSWORD)
  await mate.getByRole('button', { name: 'Create account' }).click()

  await expect(mate.getByTestId('app-switcher')).toContainText('Shared App')
  await mate.getByTestId('app-switcher').click()
  await expect(mate.getByRole('menuitem', { name: 'Shared App' })).toBeVisible()
  await expect(mate.getByRole('menuitem', { name: 'Private App' })).toHaveCount(0)
  await ctx.close()

  await page.reload()
  await expect(page.getByText('Mia Mate', { exact: true })).toBeVisible()
  await expect(page.getByText('No pending invitations')).toBeVisible()
})

test('edit and delete an application with name confirmation', async ({ page }) => {
  await registerAndVerify(page, 'Dee Delete', uniqueEmail('del'))
  await createOrgAndApp(page, 'Delete Org', 'Temp App')

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Description').fill('Short-lived')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Application updated')).toBeVisible()

  await page.getByRole('tab', { name: 'Danger zone' }).click()
  await page.getByRole('button', { name: 'Delete application' }).click()
  const confirm = page.getByRole('alertdialog').getByRole('button', { name: 'Delete application' })
  await expect(confirm).toBeDisabled()
  await page.getByLabel('Application name').fill('Temp App')
  await confirm.click()
  await expect(page.getByText('No applications you can access')).toBeVisible()
})

test('forgot and reset password', async ({ page }) => {
  const email = uniqueEmail('reset')
  await registerAndVerify(page, 'Rae Reset', email)
  await page.getByLabel('Organization name').waitFor()
  await page.context().clearCookies()

  await page.goto('/forgot-password')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()

  await page.goto(await linkFromMailbox(page, email, '/reset-password'))
  await page.getByLabel('New password').fill('ResetPass2024x')
  await page.getByLabel('Confirm password').fill('ResetPass2024x')
  await page.getByRole('button', { name: 'Update password' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()

  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('ResetPass2024x')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Set up your organization' })).toBeVisible()
})
