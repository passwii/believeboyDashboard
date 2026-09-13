import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  aggregateWindow,
  briefWindows,
  mtdWindows,
  pickLatestSalesDate,
  ppChange,
  rowsInWindow,
  useSevenDayBrief,
  type SummaryRow,
} from './use-seven-day-brief'

import { pctChange } from '@/components/dashboard-v2/v2-stats'

describe('aggregateWindow（BLF-950，复用 Dashboard 首页 computeStats 模式）', () => {
  const rows: SummaryRow[] = [
    { date: '2026-09-01', sales_amount: 1200.5, order_qty: 10, pending_order_qty: 2, ad_spend: 40, ad_orders: 3 },
    { date: '2026-09-02', sales_amount: '800', order_qty: '5', pending_order_qty: '3', ad_spend: '60', ad_orders: 2 },
  ]

  it('求和 GMV / 订单 / 广告字段，Pending 取最新日（2026-09-02）', () => {
    const result = aggregateWindow(rows)
    expect(result.gmv).toBeCloseTo(2000.5)
    expect(result.orders).toBe(15)
    // Pending 取最新日期行（2026-09-02）的值
    expect(result.pending).toBe(3)
    expect(result.adSpend).toBeCloseTo(100)
    expect(result.adOrders).toBe(5)
  })

  it('空行 / 非法值按 0 处理，不产生 NaN', () => {
    const result = aggregateWindow([
      { sales_amount: null, order_qty: undefined, pending_order_qty: 'abc' },
      {},
    ])
    expect(result).toEqual({ gmv: 0, orders: 0, pending: 0, adSpend: 0, adOrders: 0 })
  })

  it('Pending 取最新日期行的值（日期降序输入时仍取最新日）', () => {
    const result = aggregateWindow([
      { date: '2026-09-03', sales_amount: 100, order_qty: 1, pending_order_qty: 5 },
      { date: '2026-09-02', sales_amount: 100, order_qty: 1, pending_order_qty: 3 },
      { date: '2026-09-01', sales_amount: 100, order_qty: 1, pending_order_qty: 2 },
    ])
    expect(result.pending).toBe(5)
  })

  it('Pending 仅最新日期行：某行无 pending 值时不覆盖', () => {
    const result = aggregateWindow([
      { date: '2026-09-02', sales_amount: 100, order_qty: 1 },
      { date: '2026-09-01', sales_amount: 100, order_qty: 1, pending_order_qty: 2 },
    ])
    expect(result.pending).toBe(2)
  })

  it('广告字段求和（ad_spend / ad_orders），含字符串与非法值', () => {
    const result = aggregateWindow([
      { ad_spend: 80, ad_orders: 5 },
      { ad_spend: '20.5', ad_orders: '2' },
      { ad_spend: null, ad_orders: 'abc' },
      {},
    ])
    expect(result.adSpend).toBeCloseTo(100.5)
    expect(result.adOrders).toBe(7)
  })
})

describe('pickLatestSalesDate（BLF-921 Stage 2 原逻辑，7 天快报复用）', () => {
  it('从 available_dates.sales_report 取最新销售数据日期', () => {
    expect(
      pickLatestSalesDate({ sales_report: ['2026-08-30'], inventory_report: ['2026-08-29'] })
    ).toBe('2026-08-30')
  })

  it('缺 sales_report / 空数组 / null → null（频道降级隐藏）', () => {
    expect(pickLatestSalesDate({ inventory_report: ['2026-08-29'] })).toBeNull()
    expect(pickLatestSalesDate({ sales_report: [] })).toBeNull()
    expect(pickLatestSalesDate(undefined)).toBeNull()
  })
})

describe('pctChange 复用 Dashboard 首页函数（v2-stats）', () => {
  it('上涨：当前 1200 vs 基期 1000 → +20%', () => {
    expect(pctChange(1200, 1000)).toBeCloseTo(20)
  })

  it('下跌：当前 800 vs 基期 1000 → -20%', () => {
    expect(pctChange(800, 1000)).toBeCloseTo(-20)
  })

  it('基数为 0 时返回 0（与 Dashboard 首页 computeStats 一致）', () => {
    expect(pctChange(1200, 0)).toBe(0)
  })
})

describe('ppChange（百分点差值，BLF-950 ACOAS 环比）', () => {
  it('当前 14.5pp vs 基期 12.3pp → +2.2pp', () => {
    expect(ppChange(14.5, 12.3)).toBeCloseTo(2.2)
  })

  it('当前 12.3pp vs 基期 14.5pp → -2.2pp', () => {
    expect(ppChange(12.3, 14.5)).toBeCloseTo(-2.2)
  })

  it('相同时返回 0', () => {
    expect(ppChange(12.3, 12.3)).toBe(0)
  })

  it('非有限值返回 0（防 NaN 传播）', () => {
    expect(ppChange(NaN, 12.3)).toBe(0)
    expect(ppChange(12.3, Infinity)).toBe(0)
  })
})

describe('ACOAS 计算（adSpend / gmv × 100，百分点差值环比）', () => {
  it('当前窗口 ACOAS = 100/2000 × 100 = 5.0%，上一周期 80/1600 × 100 = 5.0%，delta = 0pp', () => {
    const cur = aggregateWindow([
      { date: '2026-09-01', sales_amount: 1000, ad_spend: 50 },
      { date: '2026-09-02', sales_amount: 1000, ad_spend: 50 },
    ])
    const prev = aggregateWindow([
      { date: '2026-08-25', sales_amount: 800, ad_spend: 40 },
      { date: '2026-08-26', sales_amount: 800, ad_spend: 40 },
    ])
    const curAcoas = Math.round((cur.adSpend / cur.gmv) * 1000) / 10
    const prevAcoas = Math.round((prev.adSpend / prev.gmv) * 1000) / 10
    expect(curAcoas).toBeCloseTo(5.0)
    expect(prevAcoas).toBeCloseTo(5.0)
    expect(Math.round(ppChange(curAcoas, prevAcoas) * 10) / 10).toBe(0)
  })

  it('当前 ACOAS 10% vs 上一周期 5% → +5.0pp（上升=花得更多=反向着色标红）', () => {
    const curAcoas = 10.0
    const prevAcoas = 5.0
    const delta = Math.round(ppChange(curAcoas, prevAcoas) * 10) / 10
    expect(delta).toBeCloseTo(5.0)
  })

  it('当前 ACOAS 3% vs 上一周期 8% → -5.0pp（下降=花得少=反向着色标绿）', () => {
    const curAcoas = 3.0
    const prevAcoas = 8.0
    const delta = Math.round(ppChange(curAcoas, prevAcoas) * 10) / 10
    expect(delta).toBeCloseTo(-5.0)
  })

  it('GMV 为 0 时 ACOAS 返回 null（分母为零防 NaN）', () => {
    const result = aggregateWindow([
      { sales_amount: 0, ad_spend: 100 },
    ])
    expect(result.gmv).toBe(0)
    expect(result.adSpend).toBe(100)
    // computeAcoas(gmv=0) → null
    const acoas = result.gmv <= 0 ? null : Math.round((result.adSpend / result.gmv) * 1000) / 10
    expect(acoas).toBeNull()
  })
})

describe('mtdWindows（BLF-967：本月至今 vs 上月同期）', () => {
  it('月中：end=2026-09-02（T-1）→ 本月 09-01~09-02，上月同期 08-01~08-02', () => {
    expect(mtdWindows('2026-09-02')).toEqual({
      mtdStart: '2026-09-01',
      mtdEnd: '2026-09-02',
      prevStart: '2026-08-01',
      prevEnd: '2026-08-02',
    })
  })

  it('月初：end=2026-09-01 → 本月仅 1 天，上月同期 08-01 单日', () => {
    expect(mtdWindows('2026-09-01')).toEqual({
      mtdStart: '2026-09-01',
      mtdEnd: '2026-09-01',
      prevStart: '2026-08-01',
      prevEnd: '2026-08-01',
    })
  })

  it('跨年：end=2026-01-05 → 本月 01-01~01-05，上月同期 2025-12-01~12-05', () => {
    expect(mtdWindows('2026-01-05')).toEqual({
      mtdStart: '2026-01-01',
      mtdEnd: '2026-01-05',
      prevStart: '2025-12-01',
      prevEnd: '2025-12-05',
    })
  })

  it('上月天数不足时钳制：end=2026-03-31 → 上月同期 02-01~02-28（2026 非闰年）', () => {
    expect(mtdWindows('2026-03-31')).toEqual({
      mtdStart: '2026-03-01',
      mtdEnd: '2026-03-31',
      prevStart: '2026-02-01',
      prevEnd: '2026-02-28',
    })
  })

  it('闰年 2 月：end=2024-03-30 → 上月同期 02-01~02-29（28 天钳制到 29 天）', () => {
    expect(mtdWindows('2024-03-30')).toEqual({
      mtdStart: '2024-03-01',
      mtdEnd: '2024-03-30',
      prevStart: '2024-02-01',
      prevEnd: '2024-02-29',
    })
  })
})
describe('briefWindows（BLF-1038：并集窗口覆盖 4 个统计窗口）', () => {
  /** 与实现同口径的日期平移（测试内独立实现，避免自证） */
  function shift(ymd: string, days: number): string {
    const [y, m, d] = ymd.split('-').map(Number)
    return new Date(Date.UTC(y!, m! - 1, d!) + days * 86_400_000).toISOString().slice(0, 10)
  }

  function listDays(start: string, end: string): string[] {
    const days: string[] = []
    for (let day = start; day <= end; day = shift(day, 1)) days.push(day)
    return days
  }

  const cases = ['2026-09-02', '2026-09-01', '2026-09-20', '2026-03-31', '2026-01-05', '2024-03-30']

  it.each(cases)('%s：union 覆盖 current / previous / mtd / prevMtd 全部窗口', (endDate: string) => {
    const w = briefWindows(endDate)
    for (const win of [w.current, w.previous, w.mtd, w.prevMtd]) {
      expect(w.unionStart <= win.start).toBe(true)
      expect(w.unionEnd >= win.end).toBe(true)
    }
  })

  it.each(cases)('%s：union 起点 = 上月 1 日（早于近 7 天窗口起点）', (endDate: string) => {
    const w = briefWindows(endDate)
    expect(w.unionStart).toBe(mtdWindows(endDate).prevStart)
    expect(w.unionEnd).toBe(endDate)
  })

  it('月中：end=2026-09-20 → 并集 08-01~09-20，窗口按 E 派生', () => {
    expect(briefWindows('2026-09-20')).toEqual({
      unionStart: '2026-08-01',
      unionEnd: '2026-09-20',
      current: { start: '2026-09-14', end: '2026-09-20' },
      previous: { start: '2026-09-07', end: '2026-09-13' },
      mtd: { start: '2026-09-01', end: '2026-09-20' },
      prevMtd: { start: '2026-08-01', end: '2026-08-20' },
    })
  })

  it('月初：end=2026-09-05 → 窗口跨越上月（近 7 天 08-30~09-05）', () => {
    expect(briefWindows('2026-09-05')).toEqual({
      unionStart: '2026-08-01',
      unionEnd: '2026-09-05',
      current: { start: '2026-08-30', end: '2026-09-05' },
      previous: { start: '2026-08-23', end: '2026-08-29' },
      mtd: { start: '2026-09-01', end: '2026-09-05' },
      prevMtd: { start: '2026-08-01', end: '2026-08-05' },
    })
  })

  it('跨年：end=2026-01-05 → union 起点 2025-12-01', () => {
    expect(briefWindows('2026-01-05').unionStart).toBe('2025-12-01')
  })

  it('窗口天数为并集天数的子集：current 7 天恒 ≤ union 天数', () => {
    const w = briefWindows('2026-09-20')
    expect(listDays(w.current.start, w.current.end)).toHaveLength(7)
    expect(listDays(w.unionStart, w.unionEnd).length).toBeGreaterThanOrEqual(7)
  })
})

describe('rowsInWindow（BLF-1038：并集响应按窗口裁剪）', () => {
  const rows: SummaryRow[] = [
    { date: '2026-08-31', sales_amount: 999 },
    { date: '2026-09-01', sales_amount: 1 },
    { date: '2026-09-07', sales_amount: 2 },
    { date: '2026-09-08', sales_amount: 4 },
    { date: '2026-09-15', sales_amount: 888 },
    { sales_amount: 777 },
  ]

  it('闭区间保留端点、丢弃区间外与无 date 的行', () => {
    expect(rowsInWindow(rows, '2026-09-01', '2026-09-08')).toEqual([
      { date: '2026-09-01', sales_amount: 1 },
      { date: '2026-09-07', sales_amount: 2 },
      { date: '2026-09-08', sales_amount: 4 },
    ])
  })

  it('裁剪后各窗口聚合 = 逐窗口分别请求的聚合（并集等价性）', () => {
    const w = briefWindows('2026-09-14')
    const current = aggregateWindow(rowsInWindow(rows, w.current.start, w.current.end))
    const previous = aggregateWindow(rowsInWindow(rows, w.previous.start, w.previous.end))
    // current = 09-08~09-14 → 1 行(4)；previous = 09-01~09-07 → 2 行(1+2=3)
    expect(current.gmv).toBe(4)
    expect(previous.gmv).toBe(3)
  })
})

describe('useSevenDayBrief（BLF-1038：4 窗口合并为 1 次并集请求）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 当前美西日期与数据终点 E（T-1）——与 hook 同口径 */
  function todaysEndDate(): string {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(
      new Date()
    )
    const [y, m, d] = today.split('-').map(Number)
    return new Date(Date.UTC(y!, m! - 1, d!) - 86_400_000).toISOString().slice(0, 10)
  }

  function listDays(start: string, end: string): string[] {
    const days: string[] = []
    for (let day = start; day <= end; ) {
      days.push(day)
      const [y, m, d] = day.split('-').map(Number)
      day = new Date(Date.UTC(y!, m! - 1, d!) + 86_400_000).toISOString().slice(0, 10)
    }
    return days
  }

  /** 并集区间内每天 1 单 1 美元；未裁剪前的区间外塞入巨值行验证被丢弃 */
  function buildRows(w: ReturnType<typeof briefWindows>): SummaryRow[] {
    return [
      ...listDays(w.unionStart, w.unionEnd).map((date) => ({
        date,
        sales_amount: 1,
        order_qty: 1,
        ad_spend: 1,
        ad_orders: 1,
        pending_order_qty: date === w.unionEnd ? 7 : 0,
      })),
      { date: '2000-01-01', sales_amount: 1_000_000, order_qty: 1000 },
    ]
  }

  it('仅 1 次请求（并集区间 + include_detail=false），按窗口裁出各聚合值', async () => {
    const endDate = todaysEndDate()
    const w = briefWindows(endDate)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          summary_rows: buildRows(w),
          available_dates: { sales_report: [endDate] },
        }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useSevenDayBrief())
    await waitFor(() => expect(result.current.status).toBe('ok'))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = String(fetchMock.mock.calls[0]![0])
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('project_ids')).toBe('all')
    expect(params.get('country')).toBe('US')
    expect(params.get('start_date')).toBe(w.unionStart)
    expect(params.get('end_date')).toBe(w.unionEnd)
    expect(params.get('include_detail')).toBe('false')

    const { brief } = result.current
    expect(brief.gmv).toBe(7)
    expect(brief.orders).toBe(7)
    expect(brief.adSpend).toBe(7)
    expect(brief.adOrders).toBe(7)
    // pending 取窗口内最新日（= E）的值
    expect(brief.pending).toBe(7)
    expect(brief.mtdGmv).toBe(listDays(w.mtd.start, w.mtd.end).length)
    expect(brief.gmvDelta).toBeCloseTo(0)
    expect(brief.latestSalesDate).toBe(endDate)
  })

  it('区间外行不影响任何窗口聚合（裁剪生效）', async () => {
    const endDate = todaysEndDate()
    const w = briefWindows(endDate)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ summary_rows: buildRows(w), available_dates: {} }),
      })
    )

    const { result } = renderHook(() => useSevenDayBrief())
    await waitFor(() => expect(result.current.status).toBe('ok'))

    // 巨值行落在窗口外 → GMV 仍等于窗口天数
    expect(result.current.brief.gmv).toBe(7)
    // available_dates 缺失时回退到 E
    expect(result.current.brief.latestSalesDate).toBe(endDate)
  })

  it('请求失败整体降级 error（与合并前 4 路并发语义一致）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const { result } = renderHook(() => useSevenDayBrief())
    await waitFor(() => expect(result.current.status).toBe('error'))
  })
})
