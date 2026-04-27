import { test as setup, expect } from '@playwright/test'

const E2E_EMAIL = process.env.E2E_TEST_EMAIL || 'admin@believeboy.com'
const E2E_PASSWORD = process.env.E2E_TEST_PASSWORD || 'admin123'

setup('authenticate', async ({ page }) => {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')

  const emailInput = page.locator('input[type="email"], input[name="email"]').first()
  const passwordInput = page.locator('input[type="password"], input[name="password"]').first()

  await expect(emailInput).toBeVisible({ timeout: 10000 })
  await emailInput.fill(E2E_EMAIL)
  await passwordInput.fill(E2E_PASSWORD)

  const submitBtn = page.locator('button[type="submit"]').first()
  await submitBtn.click()

  await page.waitForURL(/\/dashboard/, { timeout: 15000 })

  const storagePath = './tests/.auth/user.json'
  await page.context().storageState({ path: storagePath })
})
