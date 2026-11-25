import { expect, test } from '@playwright/test'
import { createOrgAndApp, navTo, registerAndVerify, uniqueEmail } from './helpers'

const CITIES = ['Hyderabad', 'Bengaluru', 'Mumbai', 'Chennai', 'Pune', 'Delhi']

function csv5000(): Buffer {
  const lines = ['Name,Email Address,Mobile,City']
  for (let i = 0; i < 5000; i++) {
    lines.push(`Person ${i} Rao,person${i}@example.com,9${String(700000000 + i).padStart(9, '0')},${CITIES[i % CITIES.length]}`)
  }
  lines.push('Broken Row,not-an-email,12345,Pune')
  return Buffer.from(lines.join('\n'), 'utf-8')
}

const nav = navTo

test('import 5,000 contacts, build the Hyderabad segment, and see it on the dashboard', async ({ page }) => {
  test.setTimeout(300_000)
  await registerAndVerify(page, 'Imran Import', uniqueEmail('aud'))
  await createOrgAndApp(page, 'Deccan Foods', 'Deccan Retail')

  // Import wizard
  await nav(page, 'Import')
  await page.getByTestId('import-file').setInputFiles({ name: 'customers.csv', mimeType: 'text/csv', buffer: csv5000() })
  await expect(page.getByRole('heading', { name: 'Map columns to contact fields' })).toBeVisible()
  await expect(page.getByLabel('Map Email Address')).toHaveValue('email')
  await expect(page.getByLabel('Map Mobile')).toHaveValue('phone')
  await page.getByRole('button', { name: /Validate/ }).click()
  await expect(page.getByTestId('v-Valid')).toHaveText('5,000')
  await expect(page.getByTestId('v-Invalid')).toHaveText('1')
  await page.getByRole('button', { name: 'Continue' }).click()

  await page.getByLabel('Add imported contacts to a list').selectOption('new')
  await page.getByLabel('New list name').fill('Festive 2026')
  await page.getByLabel('Tags to add').fill('imported')
  await page.getByRole('checkbox', { name: 'Email', exact: true }).check()
  await page.getByLabel('Where was consent collected?').fill('Loyalty programme sign-up form')
  await page.getByRole('checkbox', { name: /I confirm every contact/ }).check()
  await page.getByRole('button', { name: 'Start import' }).click()
  await expect(page.getByTestId('import-status')).toHaveText('Import complete', { timeout: 180_000 })
  await expect(page.getByTestId('s-Created')).toHaveText('5,000')
  await expect(page.getByTestId('s-Invalid')).toHaveText('1')
  await expect(page.getByRole('button', { name: /Download report/ })).toBeVisible()

  // Contacts table
  await nav(page, 'All contacts')
  await expect(page.getByText(/of 5,000/)).toBeVisible()
  await page.getByLabel('Search contacts').fill('person42@example.com')
  await expect(page.getByRole('cell', { name: 'person42@example.com' })).toBeVisible()
  await expect(page.getByText(/1–1 of 1/)).toBeVisible()

  // Segment builder
  await nav(page, 'Segments')
  await page.getByRole('button', { name: 'New segment' }).first().click()
  await page.getByLabel('Segment name').fill('Hyderabad Customers')
  await page.getByLabel('Value').first().fill('Hyderabad')
  await page.getByRole('button', { name: 'Add condition', exact: true }).click()
  const second = page.getByTestId('condition').nth(1)
  await second.getByLabel('Field').selectOption('email')
  await second.getByLabel('Operator').selectOption('is_not_empty')
  await expect(page.getByTestId('segment-count')).toHaveText('834')
  await page.getByRole('button', { name: 'Save segment' }).click()
  await expect(page.getByRole('main').getByRole('link', { name: 'Hyderabad Customers' }).first()).toBeVisible()
  await expect(page.getByRole('cell', { name: '834' })).toBeVisible()

  // Dashboard reflects real data
  await nav(page, 'Overview')
  await expect(page.getByTestId('kpis')).toContainText('5,000')
  await expect(page.getByText('Audience growth')).toBeVisible()
})

test('US contact: phone normalised, written consent required for SMS, profile shows TCPA rules', async ({ page }) => {
  await registerAndVerify(page, 'Uma US', uniqueEmail('us'))
  await createOrgAndApp(page, 'Lone Star Co', 'Texas Store', 'US')

  await nav(page, 'All contacts')
  await page.getByRole('button', { name: 'Add contact' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('First name').fill('Jordan')
  await dialog.getByLabel('Phone country').selectOption('US')
  await dialog.getByLabel('Phone', { exact: true }).fill('(512) 555-0147')
  await dialog.getByLabel('Country', { exact: true }).selectOption('US')
  await dialog.getByLabel('State').selectOption('TX')
  await dialog.getByRole('checkbox', { name: 'SMS marketing consent' }).check()
  await dialog.getByLabel('Where was consent collected?').fill('Checkout opt-in')
  await expect(dialog.getByText('Written consent evidence (required for US numbers)')).toBeVisible()
  await dialog.getByRole('button', { name: 'Add contact' }).click()
  await expect(dialog.getByRole('alert')).toContainText('written consent')

  await dialog.getByLabel(/Written consent evidence/).fill('Signed SMS terms checkbox on 2026-11-01, stored in CRM')
  await dialog.getByRole('button', { name: 'Add contact' }).click()
  await expect(page.getByRole('heading', { name: 'Jordan', level: 1 })).toBeVisible()
  await expect(page.getByText('United States · TCPA & CAN-SPAM')).toBeVisible()
  await expect(page.getByText('(512) 555-0147')).toBeVisible()
  await expect(page.getByTestId('reach-sms')).toContainText('Reachable')
  await expect(page.getByText(/8:00–21:00 in America\/Chicago/)).toBeVisible()

  await page.getByRole('tab', { name: 'Consent history' }).click()
  await expect(page.getByText('Evidence: Signed SMS terms checkbox')).toBeVisible()

  // Unsubscribe moves the number to the suppression list.
  await page.getByRole('tab', { name: 'Overview' }).click()
  await page.getByTestId('reach-sms').getByRole('button', { name: 'Unsubscribe' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Unsubscribe' }).click()
  await expect(page.getByTestId('reach-sms')).toContainText('Not reachable')
  await nav(page, 'Suppression')
  await expect(page.getByRole('cell', { name: /^\+15/ })).toBeVisible()
})

test('India app compliance tab lists DLT and quiet hours', async ({ page }) => {
  await registerAndVerify(page, 'Divya Dlt', uniqueEmail('in'))
  await createOrgAndApp(page, 'Chennai Silks', 'Silks Online')
  await nav(page, 'Settings')
  await page.getByRole('tab', { name: 'Compliance' }).click()
  await expect(page.getByText('India rules')).toBeVisible()
  await expect(page.getByText('TRAI TCCCPR 2018 (DLT)')).toBeVisible()
  await expect(page.getByText(/Promotional window 09:00–21:00/)).toBeVisible()
  await expect(page.getByTestId('check-quiet_hours')).toBeVisible()
})
