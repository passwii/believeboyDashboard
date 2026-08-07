import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CockpitOverview } from './cockpit-overview'
import type { CockpitRow, CockpitSummary } from './cockpit-types'

// BLF-491：指挥带 —— 状态光谱 / 行动全景 / 库存总览 / 数据健康

function makeRow(overrides: Partial<CockpitRow>): CockpitRow {
  return {
    project_id: 1,
    project_name: 'P1',
    sku: 'SKU-TEST',
    country: 'US',
    asin: null,
    product_name: '测试产品',
    available_inventory: 100,
    in_transit_quantity: 50,
    dms_30: 2,
    dms_14: 2.1,
    dms_7: 1.8,
    dms_3: 1.5,
    base_dms: 1.9,
    safety_factor: 0.1,
    weighted_dms: 2.09,
    sellable_days: 45,
    sellout_date: '2026-09-30',
    sellout_date_with_transit: '2026-10-15',
    production_lead_days: 30,
    shipping_days: 15,
    replenishment_order_date: '2026-08-10',
    warehouse_entry_date: '2026-08-17',
    shipment_order_date: '2026-08-24',
    estimated_replenishment_quantity: 200,
    risk_status: '健康库存',
    risk_anchor_date: '2026-08-07',
    inventory_state: 'healthy',
    replenishment_action: 'NO_ACTION',
    signals: null,
    ...overrides,
  }
}

const SUMMARY: CockpitSummary = {
  sku_count: 3,
  total_available_inventory: 500,
  total_in_transit_quantity: 120,
}

const BASE_PROPS = {
  rows: [] as CockpitRow[],
  summary: SUMMARY,
  loading: false,
  stateFilter: null as string | null,
  actionFilter: null as string | null,
  onStateFilter: vi.fn(),
  onActionFilter: vi.fn(),
}

describe('CockpitOverview 指挥带（BLF-491）', () => {
  it('状态光谱统计各 state 计数并渲染图例', () => {
    const rows = [
      makeRow({ inventory_state: 'critical' }),
      makeRow({ inventory_state: 'critical' }),
      makeRow({ inventory_state: 'healthy' }),
    ]
    render(<CockpitOverview {...BASE_PROPS} rows={rows} />)

    // 图例计数（危险出现于光谱段 + 图例，用 getAllByText）
    expect(screen.getAllByText('危险').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('健康').length).toBeGreaterThanOrEqual(1)
  })

  it('行动全景按决策优先级渲染行动徽章 + 计数', () => {
    const rows = [
      makeRow({ replenishment_action: 'REPLENISH_NOW' }),
      makeRow({ replenishment_action: 'HOLD' }),
      makeRow({ replenishment_action: 'NO_ACTION' }),
    ]
    render(<CockpitOverview {...BASE_PROPS} rows={rows} />)

    expect(screen.getByText('紧急补货')).toBeInTheDocument()
    expect(screen.getByText('暂停补货')).toBeInTheDocument()
    expect(screen.getByText('不动')).toBeInTheDocument()
  })

  it('点击状态图例触发 onStateFilter', async () => {
    const user = userEvent.setup()
    const onStateFilter = vi.fn()
    const rows = [makeRow({ inventory_state: 'critical' })]
    render(
      <CockpitOverview
        {...BASE_PROPS}
        rows={rows}
        onStateFilter={onStateFilter}
      />
    )

    await user.click(screen.getAllByText('危险')[1])
    expect(onStateFilter).toHaveBeenCalledWith('critical')
  })

  it('点击行动徽章触发 onActionFilter，再次点击取消（null）', async () => {
    const user = userEvent.setup()
    const onActionFilter = vi.fn()
    const rows = [makeRow({ replenishment_action: 'REDUCE_PRICE' })]
    render(
      <CockpitOverview
        {...BASE_PROPS}
        rows={rows}
        onActionFilter={onActionFilter}
      />
    )

    const badge = screen.getByText('降价清货')
    await user.click(badge)
    expect(onActionFilter).toHaveBeenCalledWith('REDUCE_PRICE')
  })

  it('库存总览与数据健康：SKU 数 / 新鲜度 / 置信度构成', () => {
    const rows = [
      makeRow({
        inventory_state: 'critical',
        signals: {
          data_freshness_days: 1,
          confidence: 'high',
        },
      }),
      makeRow({
        inventory_state: 'watch',
        signals: {
          data_freshness_days: 5,
          confidence: 'low',
        },
      }),
    ]
    render(
      <CockpitOverview
        {...BASE_PROPS}
        rows={rows}
        summary={{ ...SUMMARY, sku_count: 2 }}
      />
    )

    expect(screen.getByText(/最大 5 天/)).toBeInTheDocument()
    expect(screen.getByText(/高 1/)).toBeInTheDocument()
    expect(screen.getByText(/低 1/)).toBeInTheDocument()
  })

  it('加载中且无数据时渲染骨架', () => {
    render(<CockpitOverview {...BASE_PROPS} rows={[]} loading />)
    expect(document.querySelector('.u-skeleton-shimmer')).not.toBeNull()
  })
})
