import { test, expect } from '@playwright/test'

// CRM 列表页移动端回归（Phase 4 · 移动端）。
// 校验线索/客户/公海页在窄屏下不出现横向溢出。
test.use({ storageState: './tests/.auth/user.json' })

const pages = [
  { name: '线索', path: '/dashboard/crm/leads' },
  { name: '客户', path: '/dashboard/crm/customers' },
  { name: '公海', path: '/dashboard/crm/sea' },
]

test.describe('CRM 列表页 · 移动端无横向溢出', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }) // iPhone 12/13/14
  })

  for (const p of pages) {
    test(`${p.name}页在 390px 宽下无横向滚动`, async ({ page }) => {
      await page.goto(p.path)
      await expect(page.getByRole('cell').first()).toBeVisible({ timeout: 15000 })
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
      expect(overflow, `${p.name}页出现横向溢出 ${overflow}px`).toBeLessThanOrEqual(1)
    })
  }
})
