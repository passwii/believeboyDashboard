import { expect, test } from '@playwright/test'
import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

test.describe('发货规划页面', () => {
  test.use({ storageState: { cookies: [], origins: [] } })
  test.beforeEach(async ({ context }) => {
    await addBLF611FixtureAuth(context)
  })

  test('桌面端显示预测页面和必要数据边界', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/dashboard/operations/shipping-plan?gProject=all&gCountry=ALL')
    await expect(page.getByRole('heading', { name: '发货规划' })).toBeVisible()
    await expect(page.getByText('请先选择项目和单一站点')).toBeVisible()
    const width = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }))
    expect(width.document - width.viewport).toBeLessThanOrEqual(2)
  })

  test('移动端站点筛选和页面主体不发生整体横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/dashboard/operations/shipping-plan?gProject=all&gCountry=ALL')
    await expect(page.getByRole('heading', { name: '发货规划' })).toBeVisible()
    const strip = page.getByTestId('mobile-filter-strip')
    await expect(strip).toBeVisible()
    await expect(strip.getByRole('button', { name: '切换页面筛选' })).toBeVisible()
    const width = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }))
    expect(width.document - width.viewport).toBeLessThanOrEqual(2)
  })
})
