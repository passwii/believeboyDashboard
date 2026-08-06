import { describe, expect, it } from 'vitest'

import {
  computeTopProjects,
  type V2ProjectBreakdownEntry,
  type V2ProjectOption,
} from './v2-top-projects'

const projects: V2ProjectOption[] = [
  { id: 1, name: '项目A' },
  { id: 2, name: '项目B' },
  { id: 3, name: '项目C' },
]

const breakdown: Record<number, V2ProjectBreakdownEntry> = {
  1: {
    project_name: '项目A',
    summary_rows: [
      { date: '2026-07-31', order_qty: 10, sales_amount: 100, ad_spend: 20, ad_orders: 5 },
      { date: '2026-08-01', order_qty: 20, sales_amount: 300, ad_spend: 40, ad_orders: 8 },
    ],
  },
  2: {
    project_name: '项目B',
    summary_rows: [
      { date: '2026-07-31', order_qty: 5, sales_amount: 80, ad_spend: 70, ad_orders: 3 },
    ],
  },
}

const compareBreakdown: Record<number, V2ProjectBreakdownEntry> = {
  1: {
    project_name: '项目A',
    summary_rows: [
      { date: '2026-07-24', order_qty: 10, sales_amount: 200, ad_spend: 20, ad_orders: 4 },
    ],
  },
}

describe('computeTopProjects', () => {
  it('按销售额汇总排序，销售额 = 400、广告花费 = 60', () => {
    const rows = computeTopProjects(breakdown, undefined, projects, 'sales')
    expect(rows[0].projectName).toBe('项目A')
    expect(rows[0].totalSales).toBe(400)
    expect(rows[0].totalAdSpend).toBe(60)
    expect(rows[0].totalOrders).toBe(30)
    expect(rows[1].projectName).toBe('项目B')
  })

  it('按广告花费排序时项目B 排第一', () => {
    const rows = computeTopProjects(breakdown, undefined, projects, 'ad_spend')
    expect(rows[0].projectName).toBe('项目B')
    expect(rows[0].totalAdSpend).toBe(70)
  })

  it('环比 = (当期-上期)/上期；上一周期缺失时为 null', () => {
    const rows = computeTopProjects(breakdown, compareBreakdown, projects, 'sales')
    // 项目A：400 vs 200 → +100%
    expect(rows.find((r) => r.projectId === 1)?.change).toBeCloseTo(100, 5)
    // 项目B：无上一周期 → null
    expect(rows.find((r) => r.projectId === 2)?.change).toBeNull()
  })

  it('无 project_breakdown 条目或无项目列表时为空数组', () => {
    expect(computeTopProjects({}, undefined, projects, 'sales')).toEqual([])
    expect(computeTopProjects(breakdown, undefined, [], 'sales')).toEqual([])
  })
})
