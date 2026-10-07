import { test, expect } from '@playwright/test'
import { addBLF611FixtureAuth } from '../setup/blf611-fixture'

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

  test('route switch has no transform under reduced-motion', async ({ page, context }) => {
    await addBLF611FixtureAuth(context)
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/)
    await page.waitForLoadState('networkidle')

    // Navigate to a second dashboard route and ensure auth did not silently redirect to /login.
    await page.goto('/dashboard/advertising/ad-analysis/overview')
    await expect(page).toHaveURL(/\/dashboard\/advertising\/ad-analysis\/overview(?:\?.*)?$/)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(800)

    const motionDiv = page.getByTestId('page-transition-motion')
    await motionDiv.waitFor({ state: 'attached', timeout: 15_000 })

    const transform = await motionDiv.evaluate((el) => getComputedStyle(el).transform)
    // framer-motion 在 reduce 模式下使用 `transform: 'none'` 或 `matrix(1, 0, 0, 1, 0, 0)`
    // 任一都表示未应用动画
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(transform)
  })
})
