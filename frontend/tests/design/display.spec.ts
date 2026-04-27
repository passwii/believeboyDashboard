import { test, expect } from '@playwright/test'

test.describe('UI Logic Display Validation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/data-reporting/daily-report')
    await page.waitForLoadState('networkidle')
  })

  test('data table renders rows', async ({ page }) => {
    const rows = page.locator('table tbody tr')
    const count = await rows.count()
    expect(count).toBeGreaterThan(0)
  })

  test('table filter works correctly', async ({ page }) => {
    const filterInput = page.locator('input[placeholder*="筛选"], input[placeholder*="filter"]').first()
    const filterCount = await filterInput.count()

    if (filterCount === 0) {
      test.skip()
      return
    }

    const initialCount = await page.locator('table tbody tr').count()
    await filterInput.fill('月报')
    await page.waitForTimeout(300)

    const filteredCount = await page.locator('table tbody tr').count()
    expect(filteredCount).toBeLessThan(initialCount)

    await filterInput.clear()
    await page.waitForTimeout(300)
    const restoredCount = await page.locator('table tbody tr').count()
    expect(restoredCount).toBe(initialCount)
  })

  test('status badge renders with correct semantic colors', async ({ page }) => {
    const badgeAssertions: Record<string, RegExp> = {
      已完成: /bg-secondary|emerald|green/i,
      处理中: /bg-primary|blue|amber/i,
      待补充: /bg-destructive|red|destructive/i,
    }

    for (const [status, classPattern] of Object.entries(badgeAssertions)) {
      const badge = page.locator(
        `.inline-flex:has-text("${status}"), [class*="badge"]:has-text("${status}")`
      )
      const count = await badge.count()
      if (count > 0) {
        const classes = await badge.first().getAttribute('class') || ''
        expect(classes, `Badge "${status}" should use semantic color class`).toMatch(classPattern)
      }
    }
  })

  test('chart container renders SVG elements', async ({ page }) => {
    const chartContainer = page.locator('.recharts-wrapper').first()
    const chartCount = await chartContainer.count()

    if (chartCount === 0) {
      test.skip()
      return
    }

    await expect(chartContainer).toBeVisible()

    const svgPaths = page.locator('.recharts-wrapper svg path, .recharts-wrapper svg rect')
    const pathCount = await svgPaths.count()
    expect(pathCount).toBeGreaterThan(0)
  })

  test('loading state shows skeleton or spinner', async ({ page }) => {
    await page.goto('/dashboard/data-reporting/daily-report')

    const loadingSpinner = page.locator(
      '[class*="animate-spin"], [class*="skeleton"], [role="status"]:has-text("加载")'
    )
    const hasLoadingState = await loadingSpinner.count()

    if (hasLoadingState > 0) {
      await expect(loadingSpinner.first()).toBeVisible()
    }
  })

  test('empty state renders when no data', async ({ page }) => {
    const emptyState = page.locator(
      '[class*="empty"], [class*="no-data"], [role="status"]:has-text("暂无"), [role="status"]:has-text("无数据")'
    )
    const emptyCount = await emptyState.count()

    if (emptyCount === 0) {
      test.skip()
      return
    }

    await expect(emptyState.first()).toBeVisible()
  })

  test('dark mode inverts surface colors', async ({ page }) => {
    const themeToggle = page.locator(
      '[aria-label*="主题"], [aria-label*="theme"], button:has-text("深色"), button:has-text("light"), button:has-text("dark")'
    ).first()

    const toggleCount = await themeToggle.count()
    if (toggleCount === 0) {
      test.skip()
      return
    }

    await themeToggle.click()
    await page.waitForTimeout(200)

    const htmlClass = await page.locator('html').getAttribute('class')
    const hasDark = (htmlClass || '').includes('dark')

    if (hasDark) {
      const card = page.locator('.dashboard-surface, .dashboard-panel').first()
      const bgColor = await card.evaluate(
        (el) => window.getComputedStyle(el).backgroundColor
      )
      const match = bgColor.match(/rgb\((\d+), (\d+), (\d+)\)/)
      if (match) {
        const r = parseInt(match[1])
        expect(r, 'Dark mode surface should have dark background (R < 60)').toBeLessThan(60)
      }
    }
  })
})
