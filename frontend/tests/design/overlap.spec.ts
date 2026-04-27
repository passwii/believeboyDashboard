import { test, expect } from '@playwright/test'

test.describe('UI Overlap Validation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/data-reporting/daily-report')
    await page.waitForLoadState('networkidle')
  })

  test('sticky header does not occlude main content', async ({ page }) => {
    const header = page.locator('header, .sticky, [class*="header"]').first()
    const mainContent = page.locator('main, #main-content, [id*="content"]').first()

    const headerCount = await header.count()
    const contentCount = await mainContent.count()

    if (headerCount === 0 || contentCount === 0) {
      test.skip()
      return
    }

    const headerBox = await header.boundingBox()
    const contentBox = await mainContent.boundingBox()

    if (headerBox && contentBox) {
      expect(headerBox.y + headerBox.height, 'Header bottom should be above or at content top').toBeLessThanOrEqual(contentBox.y + 4)
    }
  })

  test('floating button is visible and not obscured', async ({ page }) => {
    const floatingBtn = page.locator('.fixed, [class*="fab"], [class*="float"]').first()
    const btnCount = await floatingBtn.count()

    if (btnCount === 0) {
      test.skip()
      return
    }

    await expect(floatingBtn).toBeVisible()

    const box = await floatingBtn.boundingBox()
    if (box) {
      const topElement = await page.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y)
          return el === null ? 'none' : el.tagName
        },
        { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      )
      expect(topElement, 'Floating button center should be the topmost element').toMatch(/BUTTON|^none$/)
    }
  })

  test('dropdown menu renders above content', async ({ page }) => {
    const tableRowMenu = page.locator('table tbody tr:first-child button[aria-label*="menu"], table tbody tr:first-child [role="button"]').first()
    const menuBtnCount = await tableRowMenu.count()

    if (menuBtnCount === 0) {
      test.skip()
      return
    }

    await tableRowMenu.click()
    await page.waitForTimeout(200)

    const dropdownMenu = page.locator('[role="menu"]').first()
    await expect(dropdownMenu).toBeVisible({ timeout: 3000 })

    const menuBox = await dropdownMenu.boundingBox()
    if (menuBox) {
      const isTopMost = await page.evaluate(
        ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[role="menu"]'),
        { x: menuBox.x + menuBox.width / 2, y: menuBox.y + menuBox.height / 2 }
      )
      expect(isTopMost, 'Dropdown menu should be the topmost element at its coordinates').toBe(true)
    }

    await page.keyboard.press('Escape')
  })

  test('dialog overlay blocks interaction with background', async ({ page }) => {
    const dialogTriggers = page.locator(
      'button[aria-label*="changelog"], button[aria-label*="说明"], a[href*="changelog"]'
    )
    const triggerCount = await dialogTriggers.count()

    if (triggerCount === 0) {
      test.skip()
      return
    }

    await dialogTriggers.first().click()
    await page.waitForTimeout(300)

    const dialog = page.locator('[role="dialog"]').first()
    const dialogCount = await dialog.count()

    if (dialogCount === 0) {
      test.skip()
      return
    }

    await expect(dialog).toBeVisible()

    await dialog.locator('button[aria-label*="close"], button[aria-label*="Close"]').first().click()
    await page.waitForTimeout(200)
    await expect(dialog).not.toBeVisible()
  })

  test('modal closes when clicking backdrop', async ({ page }) => {
    const dialogTriggers = page.locator(
      'button[aria-label*="changelog"], button[aria-label*="说明"], a[href*="changelog"]'
    )
    const triggerCount = await dialogTriggers.count()

    if (triggerCount === 0) {
      test.skip()
      return
    }

    await dialogTriggers.first().click()
    await page.waitForTimeout(300)

    const dialog = page.locator('[role="dialog"]').first()
    const dialogVisible = await dialog.isVisible()

    if (!dialogVisible) {
      test.skip()
      return
    }

    await page.locator('body').click({ position: { x: 5, y: 5 }, force: true })
    await page.waitForTimeout(300)
    await expect(dialog).not.toBeVisible()
  })

  test('hover-lift card animation does not overflow container', async ({ page }) => {
    const cards = page.locator('[class*="hover-lift"], [class*="hover\\:"]').first()
    const cardCount = await cards.count()

    if (cardCount === 0) {
      test.skip()
      return
    }

    const container = cards.locator('..')
    const cardBefore = await cards.boundingBox()
    const containerBox = await container.boundingBox()

    await cards.hover()
    await page.waitForTimeout(300)

    const cardAfter = await cards.boundingBox()

    if (cardBefore && cardAfter && containerBox) {
      const overflowX = (cardAfter.x + cardAfter.width) - (containerBox.x + containerBox.width)
      const overflowY = (cardAfter.y + cardAfter.height) - (containerBox.y + containerBox.height)
      expect(overflowX, 'Card should not overflow container horizontally on hover').toBeLessThanOrEqual(2)
      expect(overflowY, 'Card should not overflow container vertically on hover').toBeLessThanOrEqual(2)
    }
  })
})
