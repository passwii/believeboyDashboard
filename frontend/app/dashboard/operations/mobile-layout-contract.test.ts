import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SIDEBAR_TOP_GROUPS } from '@/lib/sidebar-config'

const routeStyles = [
  ['daily-analysis', 'daily-analysis/daily-analysis-warm.module.css'],
  ['inventory-analysis', 'inventory-analysis/inventory-analysis-warm.module.css'],
  ['portfolio-overview', 'portfolio-overview/portfolio-overview-warm.module.css'],
  ['weekly-product-analysis', 'weekly-product-analysis/weekly-product-analysis-warm.module.css'],
  ['return-analysis', 'return-analysis/return-analysis-warm.module.css'],
  ['project-goals', 'project-goals/project-goals-warm.module.css'],
  ['research-analysis', 'research-analysis/research-analysis-warm.module.css'],
  ['platform-inspection', 'platform-inspection/platform-inspection-warm.module.css'],
  ['review-tracking', 'review-tracking/review-tracking-warm.module.css'],
] as const

const expectedOperationsRoutes = routeStyles.map(
  ([route]) => `/dashboard/operations/${route}`
)

describe('V4 operations phone layout contract', () => {
  it.each(routeStyles)('%s keeps wide data in a route-local scroller', (_route, stylesheet) => {
    const css = readFileSync(join(__dirname, stylesheet), 'utf8')

    expect(css).toMatch(/@media\s*\(max-width:\s*(?:640|460)px\)/)
    expect(css).toMatch(/\.tableScroll\s*\{[^}]*overflow(?:-x)?:\s*auto/s)
  })

  it('keeps all nine scoped routes in the operations navigation source', () => {
    const operations = SIDEBAR_TOP_GROUPS.find((group) => group.id === 'operations')
    const configuredRoutes = operations?.items.map((item) => item.url) ?? []

    expect(configuredRoutes).toEqual(expect.arrayContaining(expectedOperationsRoutes))
  })
})
