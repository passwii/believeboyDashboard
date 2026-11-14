import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SIDEBAR_TOP_GROUPS } from '@/lib/sidebar-config'

const routeStyles = [
  ['commission-management', 'commission-management/commission-management-warm.module.css'],
  ['exchange-rate', 'exchange-rate/exchange-rate-warm.module.css'],
  ['platform-revenue', 'platform-revenue/platform-revenue-warm.module.css'],
  ['vat-invoice', 'vat-invoice/vat-invoice-warm.module.css'],
] as const

const expectedFinanceRoutes = [
  '/dashboard/finance/commission-management',
  '/dashboard/finance/exchange-rate',
  '/dashboard/finance/platform-revenue',
  '/dashboard/finance/vat-invoice',
]

describe('V4 finance phone layout contract (Stage 4)', () => {
  it.each(routeStyles)('%s keeps responsive rules and scrollers', (_route, stylesheet) => {
    const css = readFileSync(join(__dirname, stylesheet), 'utf8')

    expect(css).toMatch(/@media\s*\(max-width:\s*(?:640|460)px\)/)
    expect(css).toMatch(/(?:overflow(?:-x)?:\s*auto|tableScroller|tableRegion|lineItemsScroller)/)
  })

  it('keeps all 4 scoped routes in the finance navigation source', () => {
    const finance = SIDEBAR_TOP_GROUPS.find((group) => group.id === 'finance')
    const configuredRoutes = finance?.items.map((item) => item.url) ?? []

    expect(configuredRoutes).toEqual(expect.arrayContaining(expectedFinanceRoutes))
  })

  it('vat-invoices route redirects to vat-invoice', () => {
    const pageContent = readFileSync(join(__dirname, 'vat-invoices/page.tsx'), 'utf8')
    expect(pageContent).toContain("redirect('/dashboard/finance/vat-invoice')")
  })

  it.each(routeStyles)('%s specifies touch target size for interactive elements on mobile', (_route, stylesheet) => {
    const css = readFileSync(join(__dirname, stylesheet), 'utf8')
    expect(css).toMatch(/var\(--warm-ledger-control-target-touch(?:,\s*44px)?\)/)
  })
})
