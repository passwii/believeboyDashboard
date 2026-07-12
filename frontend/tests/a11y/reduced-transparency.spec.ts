import { test, expect } from '@playwright/test'

/**
 * Reduced-transparency fallback regression.
 *
 * Under `prefers-reduced-transparency: reduce`, `useSpotlight` short-
 * circuits and `globals.css` sets `--spotlight-strength: 0` on every
 * `[data-spotlight]` element. The visual effect is gone; only the
 * attribute remains.
 *
 * Note: Playwright's `emulateMedia({ reducedTransparency })` is the only
 * way to set this media feature — `contextOptions.reducedTransparency`
 * is not a supported key, unlike `reducedMotion`.
 */
test.describe('reduced-transparency fallback', () => {
  test('spotlight strength is 0 under reduced-transparency', async ({ page }) => {
    // Explicitly disable reduced-motion so only transparency is in play.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.emulateMedia({ reducedTransparency: 'reduce' })

    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    const card = page.locator('[data-spotlight]').first()
    const exists = (await card.count()) > 0
    if (!exists) {
      test.skip(true, 'No spotlight card present on this page')
      return
    }

    const strength = await card
      .first()
      .evaluate((el) =>
        getComputedStyle(el).getPropertyValue('--spotlight-strength').trim(),
      )
    expect(strength).toBe('0')
  })
})
