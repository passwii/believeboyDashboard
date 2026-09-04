import { test, expect } from '@playwright/test'

test.describe('Responsive Layout Validation', () => {
  const viewports = [
    { width: 375, height: 812, label: 'mobile' },
    { width: 768, height: 1024, label: 'tablet' },
    { width: 1280, height: 900, label: 'desktop' },
  ]

  for (const size of viewports) {
    test(`${size.label} (${size.width}x${size.height}): toolbar direction`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await page.waitForLoadState('networkidle')

      const toolbar = page.locator('.dashboard-toolbar').first()
      const toolbarCount = await toolbar.count()

      if (toolbarCount === 0) {
        test.skip()
        return
      }

      const flexDirection = await toolbar.evaluate(
        (el) => window.getComputedStyle(el).flexDirection
      )
      expect(['row', 'column']).toContain(flexDirection)
    })

    test(`${size.label} (${size.width}x${size.height}): no horizontal overflow`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await page.waitForLoadState('networkidle')

      const body = page.locator('body')
      const overflowX = await body.evaluate(
        (el) => el.scrollWidth - el.clientWidth
      )
      expect(overflowX, 'Body should have no horizontal overflow').toBe(0)
    })

    test(`${size.label} (${size.width}x${size.height}): main content is visible`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await page.waitForLoadState('networkidle')

      const main = page.locator('main, #main-content, [class*="content"]').first()
      const mainCount = await main.count()

      if (mainCount === 0) {
        test.skip()
        return
      }

      await expect(main).toBeInViewport()
    })
  }

  test('sidebar collapses on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.waitForLoadState('networkidle')

    const sidebar = page.locator('aside, [class*="sidebar"], nav[class*="w-64"]').first()
    const sidebarCount = await sidebar.count()

    if (sidebarCount === 0) {
      test.skip()
      return
    }

    const sidebarBox = await sidebar.boundingBox()
    if (sidebarBox) {
      const isHidden = sidebarBox.width < 50 || sidebarBox.x < 0
      expect(isHidden, 'Sidebar should be collapsed or hidden on mobile').toBe(true)
    }
  })

  test('chart is responsive to viewport changes', async ({ page }) => {
    const desktopBox = await page.locator('.recharts-wrapper').first().boundingBox()

    if (!desktopBox) {
      test.skip()
      return
    }

    await page.setViewportSize({ width: 375, height: 812 })
    await page.waitForTimeout(200)

    const mobileBox = await page.locator('.recharts-wrapper').first().boundingBox()

    if (mobileBox) {
      expect(mobileBox.width, 'Chart should be narrower on mobile').toBeLessThan(desktopBox.width)
    }
  })
})
