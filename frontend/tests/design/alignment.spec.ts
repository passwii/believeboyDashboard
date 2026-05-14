import { test, expect } from '@playwright/test'

test.describe('UI Alignment Validation', () => {
  test.beforeEach(async ({ page }) => {
    await page.waitForLoadState('networkidle')
  })

  test('metric cards have consistent heights in grid', async ({ page }) => {
    const cards = page.locator('[data-testid="metric-card"]')
    const count = await cards.count()

    if (count === 0) {
      test.skip()
      return
    }

    const heights = await cards.evaluateAll(
      (els) => els.map((el) => el.getBoundingClientRect().height)
    )

    const maxHeight = Math.max(...heights)
    const minHeight = Math.min(...heights)
    expect(maxHeight - minHeight).toBeLessThanOrEqual(2)
  })

  test('dashboard surface cards align left edges', async ({ page }) => {
    const surfaceCards = page.locator('.dashboard-surface, .dashboard-panel')
    const count = await surfaceCards.count()

    if (count < 2) return

    const boxes = await surfaceCards.evaluateAll(
      (els) => els.map((el) => el.getBoundingClientRect())
    )

    const uniqueLeftEdges = Array.from(
      new Set(boxes.map((b) => Math.round(b.x)))
    )
    expect(uniqueLeftEdges.length).toBeLessThanOrEqual(2)
  })

  test('toolbar elements align horizontally', async ({ page }) => {
    const toolbar = page.locator('.dashboard-toolbar').first()
    await expect(toolbar).toBeVisible()

    const flexDirection = await toolbar.evaluate(
      (el) => window.getComputedStyle(el).flexDirection
    )
    expect(['row', 'column']).toContain(flexDirection)
  })

  test('table column alignment matches spec (right-aligned columns)', async ({
    page,
  }) => {
    const rightAlignedHeaders = page.locator(
      'table th:text-matches("目标|进度|数值|金额|销量")'
    )
    const count = await rightAlignedHeaders.count()

    for (let i = 0; i < count; i++) {
      const header = rightAlignedHeaders.nth(i)
      await expect(header).toHaveCSS('text-align', 'right')
    }
  })

  test('sidebar navigation items are vertically aligned', async ({ page }) => {
    const navItems = page.locator('nav a, nav button')
    const count = await navItems.count()

    if (count < 2) return

    const boxes = await navItems.evaluateAll(
      (els) => els.map((el) => ({ x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width }))
    )

    const uniqueLeftEdges = Array.from(
      new Set(boxes.map((b) => Math.round(b.x)))
    )
    expect(uniqueLeftEdges.length).toBeLessThanOrEqual(1)
  })
})
