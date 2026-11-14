import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SIDEBAR_TOP_GROUPS } from '@/lib/sidebar-config'

const adAnalysisRoutes = [
  'ad-analysis/overview/page.tsx',
  'ad-analysis/budget/page.tsx',
  'ad-analysis/campaigns/page.tsx',
  'ad-analysis/placements/page.tsx',
  'ad-analysis/products/page.tsx',
  'ad-analysis/purchased-products/page.tsx',
  'ad-analysis/search-terms/page.tsx',
  'ad-analysis/targets/page.tsx',
  'ad-analysis/time-trend/page.tsx',
  'ad-analysis/traffic-quality/page.tsx',
  'ad-data/page.tsx',
] as const

const metricGridClients = [
  'budget-client.tsx',
  'campaigns-client.tsx',
  'placements-client.tsx',
  'products-client.tsx',
  'search-terms-client.tsx',
  'targets-client.tsx',
  'traffic-quality-client.tsx',
] as const

function read(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), 'utf8')
}

function readMobileBlock(stylesheet: string): string {
  const css = read(stylesheet)
  const marker = '@media (max-width: 640px)'
  const start = css.indexOf(marker)
  if (start === -1) return ''
  const open = css.indexOf('{', start)
  if (open === -1) return ''
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, index)
    }
  }
  return ''
}

describe('V4 advertising phone layout contract (Stage 6)', () => {
  it('ships all 12 scoped ad-analysis and ad-data pages', () => {
    for (const route of adAnalysisRoutes) {
      expect(read(route)).not.toHaveLength(0)
    }
    expect(read('ad-analysis/page.tsx')).toContain(
      "redirect('/dashboard/advertising/ad-analysis/overview')"
    )
  })

  it('keeps the twelve pages reachable from the advertising navigation group', () => {
    const advertisingGroup = SIDEBAR_TOP_GROUPS.find((group) => group.id === 'advertising')
    expect(advertisingGroup).toBeDefined()

    const prefixes = advertisingGroup?.items.map((item) => item.matchPrefixes ?? []) ?? []
    expect(
      prefixes.some((match) => match.includes('/dashboard/advertising/ad-analysis'))
    ).toBe(true)
    expect(
      prefixes.some((match) => match.includes('/dashboard/advertising/ad-data'))
    ).toBe(true)
  })

  it('uses the warm phone filter strip for both advertising surfaces', () => {
    expect(read('../../../components/dashboard/ad-analysis/top-filters.tsx')).toContain(
      'variant="warm-ledger"'
    )
    expect(read('../../../components/dashboard/ad-data/top-filters.tsx')).toContain(
      'variant="warm-ledger"'
    )
  })

  it.each(metricGridClients)('%s starts summary cards at two columns on phones', (client) => {
    const source = read(`../../../components/dashboard/ad-analysis/${client}`)
    expect(source).toMatch(/grid-cols-2[^"']*sm:grid-cols-4/)
    expect(source).not.toMatch(/className="grid grid-cols-4/)
  })

  it('stacks the overview metric strip and charts on phones without changing desktop', () => {
    const source = read('../../../components/dashboard/ad-analysis/overview-client.tsx')
    expect(source).toContain('grid-cols-2 gap-1 sm:grid-cols-8')
    expect(source).toContain('grid-cols-1 gap-1 sm:h-[38vh]')
    expect(source).toContain('h-[240px]')
  })

  it('keeps ad-analysis tables in their own touch scroller with all columns available', () => {
    const mobile = readMobileBlock(
      '../../../components/dashboard/ad-analysis/warm-analysis.module.css'
    )
    expect(mobile).toMatch(/\.tableScroll\s*\{[^}]*overflow-x:\s*auto/)
    expect(mobile).toContain('-webkit-overflow-scrolling: touch')
    expect(mobile).toMatch(/\.table\s*\{[^}]*min-width:\s*900px/)
    expect(mobile).toMatch(/\.table\s*\{[^}]*width:\s*max-content/)
  })

  it('keeps campaign tabs scrollable and touch-sized on phones', () => {
    const mobile = readMobileBlock(
      'ad-analysis/ad-analysis-warm.module.css'
    )
    expect(mobile).toMatch(/\.tabScroller\s*\{[^}]*overflow-x:\s*auto/)
    expect(mobile).toContain('--warm-ledger-control-target-touch')
    expect(mobile).toMatch(/\.mobileControl\s*\{[^}]*height:/)
  })

  it('stacks ad-data controls and pagination for phones', () => {
    const mobile = readMobileBlock(
      '../../../components/dashboard/ad-data/ad-data-explorer.module.css'
    )
    expect(mobile).toMatch(/\.controlRow\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(mobile).toMatch(/\.pagination\s*\{[^}]*flex-direction:\s*column/)
    expect(mobile).toContain('-webkit-overflow-scrolling: touch')
    expect(mobile).toMatch(/\.tableScroller\s*\{[^}]*max-height:/)
  })
})
