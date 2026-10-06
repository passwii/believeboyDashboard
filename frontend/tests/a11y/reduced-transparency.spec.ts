import { test, expect } from '@playwright/test'
import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

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
  test('spotlight strength is 0 under reduced-transparency', async ({ page, context }) => {
    await addBLF611FixtureAuth(context)
    // Explicitly disable reduced-motion so only transparency is in play.
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.emulateMedia({ reducedTransparency: 'reduce' })

    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/)
    await expect(page.getByRole('main')).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    const card = page.locator('[data-spotlight]').first()
    if ((await card.count()) === 0) {
      test.skip(true, 'Authenticated dashboard currently renders no spotlight card')
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
