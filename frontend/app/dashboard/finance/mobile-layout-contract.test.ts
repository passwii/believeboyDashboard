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

  it('ensures specific finance table row and input actions satisfy >= 44px touch targets on mobile', () => {
    const exchangeRateCss = readFileSync(
      join(__dirname, 'exchange-rate/exchange-rate-warm.module.css'),
      'utf8'
    )
    expect(exchangeRateCss).toMatch(
      /\.rowAction\s*\{[^}]*min-height:\s*var\(--warm-ledger-control-target-touch(?:,\s*44px)?\)/s
    )
    expect(exchangeRateCss).toMatch(
      /\.rowAction\s*\{[^}]*min-width:\s*var\(--warm-ledger-control-target-touch(?:,\s*44px)?\)/s
    )
    expect(exchangeRateCss).not.toMatch(/\.rowAction\s*\{[^}]*min-height:\s*40px/s)

    const platformRevenueCss = readFileSync(
      join(__dirname, 'platform-revenue/platform-revenue-warm.module.css'),
      'utf8'
    )
    expect(platformRevenueCss).toMatch(
      /\.rowAction\s*\{[^}]*min-height:\s*var\(--warm-ledger-control-target-touch(?:,\s*44px)?\)/s
    )
    expect(platformRevenueCss).toMatch(
      /\.rowAction\s*\{[^}]*min-width:\s*var\(--warm-ledger-control-target-touch(?:,\s*44px)?\)/s
    )
    expect(platformRevenueCss).not.toMatch(/\.rowAction\s*\{[^}]*min-height:\s*40px/s)

    const vatInvoiceCss = readFileSync(
      join(__dirname, 'vat-invoice/vat-invoice-warm.module.css'),
      'utf8'
    )
    expect(vatInvoiceCss).toMatch(
      /\.tableAction\s*\{[^}]*min-height:\s*var\(--warm-ledger-control-target-touch(?:,\s*44px)?\)\s*!important/s
    )
    expect(vatInvoiceCss).toMatch(
      /\.tableAction\s*\{[^}]*min-width:\s*var\(--warm-ledger-control-target-touch(?:,\s*44px)?\)\s*!important/s
    )
    expect(vatInvoiceCss).not.toMatch(/\.tableAction\s*\{[^}]*min-height:\s*40px/s)

    const commissionCss = readFileSync(
      join(__dirname, 'commission-management/commission-management-warm.module.css'),
      'utf8'
    )
    expect(commissionCss).toMatch(
      /\.tableInput\s*\{[^}]*min-height:\s*var\(--warm-ledger-control-target-touch(?:,\s*44px)?\)/s
    )
    expect(commissionCss).toMatch(
      /\.paymentStatus\s+:global\(\.warm-ledger__select\)\s*\{[^}]*min-height:\s*var\(--warm-ledger-control-target-touch(?:,\s*44px)?\)/s
    )
    expect(commissionCss).not.toMatch(/\.tableInput\s*\{[^}]*min-height:\s*38px/s)
    expect(commissionCss).not.toMatch(/\.paymentStatus\s+:global\(\.warm-ledger__select\)\s*\{[^}]*min-height:\s*38px/s)
  })

  it('ensures finance pages consume MobileFilterStrip with variant="warm-ledger"', () => {
    const commissionPage = readFileSync(
      join(__dirname, 'commission-management/page.tsx'),
      'utf8'
    )
    const exchangeRatePage = readFileSync(
      join(__dirname, 'exchange-rate/page.tsx'),
      'utf8'
    )
    const platformRevenuePage = readFileSync(
      join(__dirname, 'platform-revenue/page.tsx'),
      'utf8'
    )

    expect(commissionPage).toContain('variant="warm-ledger"')
    expect(exchangeRatePage).toContain('variant="warm-ledger"')
    expect(platformRevenuePage).toContain('variant="warm-ledger"')
  })
})
