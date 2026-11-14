import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const redirectMock = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}))

import PricingCalculationPage from './page'

function read(name: string) {
  return readFileSync(join(__dirname, name), 'utf8')
}

describe('定价核算 Warm Ledger contract', () => {
  it('keeps the pricing-calculation parent route redirecting to new-product', () => {
    PricingCalculationPage()

    expect(redirectMock).toHaveBeenCalledWith('/dashboard/reports/pricing-calculation/new-product')
  })

  it('marks the new-product and shop-calculation surfaces', () => {
    expect(read('new-product/new-product-client.tsx')).toContain(
      'data-warm-pricing-new-product="true"'
    )
    expect(read('shop-calculation/shop-calculation-client.tsx')).toContain(
      'data-warm-pricing-shop-calculation="true"'
    )
  })

  it('keeps export, tab, calculation, and snapshot workflows in place', () => {
    const newProduct = read('new-product/new-product-client.tsx')
    const shop = read('shop-calculation/shop-calculation-client.tsx')

    expect(newProduct).toContain('测算对比矩阵')
    expect(newProduct).toContain('导出 Excel')
    expect(newProduct).toContain('requestPricingCalculation')
    expect(shop).toContain('PricingSnapshotSelector')
    expect(shop).toContain('handleExport')
    expect(shop).toContain('ShopCalculationUsSection')
  })

  it('uses Warm tokens without Terminal aliases or new page breakpoints', () => {
    for (const source of [
      read('new-product/new-product-client.tsx'),
      read('shop-calculation/shop-calculation-client.tsx'),
    ]) {
      expect(source).not.toContain('rounded-none')
      expect(source).not.toMatch(/\b(?:bg|border|text|divide)-term-/)
    }

    const css = read('pricing-calculation-warm.module.css')
    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).toContain('overflow-x: auto')
    expect(css).not.toContain('--term-')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)/)
    expect(css).toMatch(/\.tableScroll\s*\{[^}]*overflow(?:-x)?:\s*auto/s)
  })

  it('keeps financial values fully visible and error copy in the sans stack', () => {
    const css = read('pricing-calculation-warm.module.css')
    const block = (selector: string) =>
      css.match(new RegExp(`\\.${selector}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? ''
    const metricValue = block('runMetricValue')
    const runEmpty = block('runEmpty')
    const errorBanner = block('errorBanner')

    expect(metricValue).toContain('overflow-wrap: anywhere;')
    expect(metricValue).toContain('white-space: normal;')
    expect(runEmpty).toContain('font-family: var(--warm-ledger-font-sans);')
    expect(errorBanner).toContain('font-family: var(--warm-ledger-font-sans);')
  })

  it('uses page-local Warm header controls instead of HeaderFilterSuite', () => {
    for (const source of [
      read('new-product/new-product-client.tsx'),
      read('shop-calculation/shop-calculation-client.tsx'),
    ]) {
      expect(source).toContain('data-warm-header-filters="true"')
      expect(source).not.toContain('HeaderFilterControls')
      expect(source).not.toContain('HeaderSlotInput')
      expect(source).not.toContain('HeaderSlotSelect')
    }
  })
})
