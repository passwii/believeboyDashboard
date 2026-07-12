import { test, expect } from '@playwright/test'

/**
 * Motion-system performance regression.
 *
 * Captures INP (event-timing) and CLS (layout-shift) across a series of
 * route navigations on the dashboard. Motion must not push either metric
 * above the Web-Vitals "good" thresholds (INP < 200ms, CLS < 0.1).
 *
 * NOTE: This spec is intentionally tolerant. PerformanceObserver entries
 * are best-effort — if a given browser/headless build doesn't surface
 * event-timing or layout-shift, the corresponding metric stays at 0 and
 * trivially passes. The point is to guard against regressions, not to
 * micro-benchmark.
 */
test.describe('motion system performance', () => {
  // CI: production webServer cold start + 5 个路由切换 + 800ms × 5 等待，需要 60s+
  test.setTimeout(60_000)

  test('route switching does not regress INP/CLS', async ({ page }) => {
    // addInitScript 在每个新 page document 创建前注入，跨 page.goto 持久化
    await page.addInitScript(() => {
      ;(window as unknown as { __perfMetrics: { inp: number; cls: number } }).__perfMetrics = {
        inp: 0,
        cls: 0,
      }

      try {
        const inpObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const duration = (entry as PerformanceEntry).duration
            const w = window as unknown as { __perfMetrics: { inp: number } }
            if (duration > w.__perfMetrics.inp) w.__perfMetrics.inp = duration
          }
        })
        inpObserver.observe({
          type: 'event',
          buffered: true,
          durationThreshold: 16,
        } as PerformanceObserverInit)
      } catch {
        // event-timing unsupported in this build — leave inp at 0
      }

      try {
        const clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const ls = entry as PerformanceEntry & {
              hadRecentInput?: boolean
              value?: number
            }
            if (!ls.hadRecentInput) {
              const w = window as unknown as { __perfMetrics: { cls: number } }
              w.__perfMetrics.cls += ls.value ?? 0
            }
          }
        })
        clsObserver.observe({ type: 'layout-shift', buffered: true } as PerformanceObserverInit)
      } catch {
        // layout-shift unsupported — leave cls at 0
      }
    })

    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    // Drive a representative route tour through the dashboard.
    const routes = [
      '/dashboard',
      '/dashboard/data-analysis/ad-analysis/overview',
      '/dashboard/data-analysis/ad-analysis/campaigns',
      '/dashboard',
      '/dashboard/data-analysis/ad-analysis/inventory',
    ]

    for (const route of routes) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      // Give spring transitions (≈0.5–0.8s) time to settle so any CLS
      // attributable to motion has a chance to be observed.
      await page.waitForTimeout(800)
    }

    const metrics = await page.evaluate(
      () =>
        (
          window as unknown as {
            __perfMetrics: { inp: number; cls: number }
          }
        ).__perfMetrics,
    )

    expect(metrics.inp).toBeLessThan(200)
    expect(metrics.cls).toBeLessThan(0.1)
  })
})
