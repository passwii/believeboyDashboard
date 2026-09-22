import { describe, expect, it } from 'vitest'
import {
  buildSkuScopeKey,
  filterRowsBySkuScope,
  isDailyAnalysisExportBusy,
  shouldAcceptSkuOptions,
} from './daily-analysis-sku-scope'

type TestRow = { sku: string; value: number }

describe('daily-analysis SKU scope', () => {
  it('builds a stable project/country scope and omits ALL-country scope', () => {
    expect(buildSkuScopeKey('18', 'us')).toBe('18:US')
    expect(buildSkuScopeKey(18, ' US ')).toBe('18:US')
    expect(buildSkuScopeKey('', 'US')).toBeNull()
    expect(buildSkuScopeKey('18', 'ALL')).toBeNull()
  })

  it('does not apply a stale SKU list to rows from another scope', () => {
    const rows: TestRow[] = [
      { sku: 'CURRENT-A', value: 1 },
      { sku: 'CURRENT-B', value: 2 },
    ]

    expect(
      filterRowsBySkuScope(rows, [{ sku: 'OLD-A' }], '1:US', '18:US')
    ).toEqual(rows)
  })

  it('filters only when the SKU list belongs to the current scope', () => {
    const rows: TestRow[] = [
      { sku: 'ACTIVE-A', value: 1 },
      { sku: 'INACTIVE-B', value: 2 },
    ]

    expect(
      filterRowsBySkuScope(rows, [{ sku: 'ACTIVE-A' }], '18:US', '18:US')
    ).toEqual([{ sku: 'ACTIVE-A', value: 1 }])
  })

  it('keeps all rows while the current scope has no loaded SKU list', () => {
    const rows: TestRow[] = [{ sku: 'A', value: 1 }]

    expect(filterRowsBySkuScope(rows, [], null, '18:US')).toEqual(rows)
  })

  it('rejects an old SKU request after the scope changes', () => {
    expect(shouldAcceptSkuOptions(4, 5, '1:US', '18:US')).toBe(false)
    expect(shouldAcceptSkuOptions(5, 5, '18:US', '18:US')).toBe(true)
  })

  it('blocks export while report or SKU data is still loading', () => {
    expect(
      isDailyAnalysisExportBusy({ exporting: false, loading: true, skuLoading: false, hasData: true })
    ).toBe(true)
    expect(
      isDailyAnalysisExportBusy({ exporting: false, loading: false, skuLoading: true, hasData: true })
    ).toBe(true)
    expect(
      isDailyAnalysisExportBusy({ exporting: false, loading: false, skuLoading: false, hasData: true })
    ).toBe(false)
  })
})
