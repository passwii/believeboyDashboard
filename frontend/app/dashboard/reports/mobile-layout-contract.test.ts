import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SIDEBAR_TOP_GROUPS } from '@/lib/sidebar-config'

const routeStyles = [
  ['auto-upload', 'auto-upload/auto-upload-warm.module.css'],
  ['monthly-report/display', 'monthly-report/display/display-warm.module.css'],
  ['monthly-report/generate', 'monthly-report/generate/generate-warm.module.css'],
  ['monthly-report/reconcile', 'monthly-report/reconcile/reconcile-warm.module.css'],
  ['monthly-report-tabs', 'monthly-report/monthly-report-warm.module.css'],
  ['order-info', 'order-info/order-info-warm.module.css'],
  ['pricing-calculation', 'pricing-calculation/pricing-calculation-warm.module.css'],
  ['product-analysis', 'product-analysis/product-analysis-warm.module.css'],
  ['scheduled-reports', 'scheduled-reports/scheduled-reports-warm.module.css'],
] as const

const scopedRoutes = [
  '/dashboard/reports/auto-upload',
  '/dashboard/reports/monthly-report/display',
  '/dashboard/reports/monthly-report/generate',
  '/dashboard/reports/monthly-report/reconcile',
  '/dashboard/reports/order-info',
  '/dashboard/reports/pricing-calculation',
  '/dashboard/reports/pricing-calculation/new-product',
  '/dashboard/reports/pricing-calculation/shop-calculation',
  '/dashboard/reports/product-analysis',
  '/dashboard/reports/report-reconciliation',
  '/dashboard/reports/scheduled-reports',
  '/dashboard/reports/scheduled-reports/ledger',
  '/dashboard/reports/scheduled-reports/subscriptions',
] as const

describe('V4 reports phone layout contract (Stage 4)', () => {
  it.each(routeStyles)('%s includes phone media queries', (_route, stylesheet) => {
    const css = readFileSync(join(__dirname, stylesheet), 'utf8')
    expect(css).toMatch(/@media\s*\(max-width:\s*(?:640|460|380)px\)/)
  })

  it.each(
    routeStyles.filter(([route]) => route !== 'monthly-report-tabs')
  )('%s keeps wide data in a route-local scroller', (_route, stylesheet) => {
    const css = readFileSync(join(__dirname, stylesheet), 'utf8')
    expect(css).toMatch(/\.tableScroll\s*\{[^}]*overflow(?:-x)?:\s*auto/s)
    expect(css).toContain('-webkit-overflow-scrolling: touch')
  })

  it('covers all 13 scoped report routes in the sidebar navigation or route prefixes', () => {
    const reportsGroup = SIDEBAR_TOP_GROUPS.find((group) => group.id === 'reports')
    expect(reportsGroup).toBeDefined()

    const items = reportsGroup?.items ?? []
    for (const route of scopedRoutes) {
      const isCovered = items.some((item) => {
        if (item.url === route) return true
        if (item.matchPrefixes?.some((prefix) => route.startsWith(prefix))) return true
        // report-reconciliation redirects to monthly-report/reconcile
        if (route === '/dashboard/reports/report-reconciliation') {
          return item.matchPrefixes?.some((prefix) => prefix === '/dashboard/reports/monthly-report')
        }
        // pricing-calculation redirects to pricing-calculation/new-product
        if (route === '/dashboard/reports/pricing-calculation') {
          return item.matchPrefixes?.some((prefix) => prefix.startsWith('/dashboard/reports/pricing-calculation'))
        }
        return false
      })
      expect(isCovered, `route ${route} should be covered by sidebar-config`).toBe(true)
    }
  })

  it.each([
    ['auto-upload', 'auto-upload/auto-upload-warm.module.css'],
    ['monthly-report/display', 'monthly-report/display/display-warm.module.css'],
    ['monthly-report/reconcile', 'monthly-report/reconcile/reconcile-warm.module.css'],
    ['pricing-calculation', 'pricing-calculation/pricing-calculation-warm.module.css'],
    ['product-analysis', 'product-analysis/product-analysis-warm.module.css'],
    ['scheduled-reports', 'scheduled-reports/scheduled-reports-warm.module.css'],
  ])('%s ensures mobile controls meet touch target standards', (_route, stylesheet) => {
    const css = readFileSync(join(__dirname, stylesheet), 'utf8')
    expect(css).toContain('var(--warm-ledger-control-target-touch)')
  })
})
