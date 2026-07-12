import { test, expect } from '@playwright/test'

/**
 * Reduced-motion fallback regression.
 *
 * Under `prefers-reduced-motion: reduce`, the PageTransition motion.div
 * should NOT animate — framer-motion drops the spring and uses
 * `transition: { duration: 0 }`, which means no inline `transform` is
 * ever applied. The computed `transform` on the motion.div must therefore
 * be `none` after a route switch.
 *
 * Playwright `reducedMotion: 'reduce'` mirrors the OS-level media
 * preference so `useReducedMotion()` and any `@media (prefers-reduced-motion)`
 * CSS both see the same value.
 */
test.describe('reduced-motion fallback', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  // CI: production webServer cold start + 2 个路由切换需要更多时间，默认 30s 不够
  test.setTimeout(60_000)

  test('route switch has no transform under reduced-motion', async ({ page }) => {
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    // Drive a route switch so AnimatePresence actually runs an enter
    await page.goto('/dashboard/data-analysis/ad-analysis/overview')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(800)

    const motionDiv = page.locator('div[class*="will-change-transform"]').first()
    await motionDiv.waitFor({ state: 'attached', timeout: 5000 })

    const transform = await motionDiv.evaluate((el) => getComputedStyle(el).transform)
    expect(transform).toBe('none')
  })
})
