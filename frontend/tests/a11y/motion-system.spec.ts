import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

/**
 * Motion-system a11y regression.
 *
 * Runs axe-core against the two motion-heavy entry points:
 *   - /dashboard         (PageTransition + stagger + spotlight)
 *   - /dashboard/ai-chat (chat bubbles / streaming indicator)
 *
 * Only critical/serious violations are treated as blocking. axe will
 * routinely flag minor best-practice issues (e.g. region landmarks in
 * partial renders) which we don't want to fail the suite on.
 *
 * When a blocking violation is found we log the full report so a human
 * reviewer can triage; the test itself fails via the `expect` below.
 */
test.describe('motion system a11y', () => {
  test('dashboard has no wcag2 critical/serious violations', async ({ page }) => {
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()

    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )
    if (blocking.length > 0) {
      // Surface the report for triage; the assertion below still fails.
      console.log('A11y violations:', JSON.stringify(blocking, null, 2))
    }
    expect(blocking).toEqual([])
  })

  test('ai-chat has no wcag2 critical/serious violations', async ({ page }) => {
    await page.goto('/dashboard/ai-chat')
    await page.waitForLoadState('networkidle')

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze()

    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )
    expect(blocking).toEqual([])
  })
})
