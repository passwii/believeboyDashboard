import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { reduceHeaderKpis, useHeaderKpis } from './use-header-kpis'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reduceHeaderKpis', () => {
  it('求和 sales_amount / order_qty / pending_order_qty', () => {
    expect(
      reduceHeaderKpis([
        { sales_amount: 100, order_qty: 3, pending_order_qty: 1 },
        { sales_amount: '50.5', order_qty: '2', pending_order_qty: null },
      ])
    ).toEqual({ gmv: 150.5, orders: 5, pending: 1 })
  })

  it('空数组返回零值', () => {
    expect(reduceHeaderKpis([])).toEqual({ gmv: 0, orders: 0, pending: 0 })
  })
})

describe('useHeaderKpis', () => {
  it('成功拉取后返回 KPI 数值', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            summary_rows: [{ sales_amount: 88, order_qty: 4, pending_order_qty: 2 }],
          }),
      })
    )
    const { result } = renderHook(() => useHeaderKpis())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.kpis).toEqual({ gmv: 88, orders: 4, pending: 2 })
  })

  it('请求失败时保持 null 占位且不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const { result } = renderHook(() => useHeaderKpis())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.kpis.gmv).toBeNull()
  })
})
