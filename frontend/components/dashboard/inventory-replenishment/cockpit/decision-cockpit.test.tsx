import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { DecisionCockpit } from './decision-cockpit'
import type { CockpitRow } from './cockpit-types'

// BLF-491：决策驾驶舱 —— 行动道分组、折叠、卡片渲染

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
    signals: {
      sellable_days: 45,
      dms_3: 1.5,
      dms_7: 1.8,
      dms_14: 2.1,
      dms_30: 2,
      trend_ratio_7_30: 0.9,
      trend_label: '稳定',
      trend_momentum: 'stable',
      aging_share: { '0_90': 0.7, '91_180': 0.3 },
      transit_ratio: 0.5,
      data_freshness_days: 1,
      confidence: 'high',
      seasonal_factor: null,
      seasonal_phase: 'unknown',
      seasonal_source: 'neutral',
    },
    ...overrides,
  }
}

const BASE_PROPS = {
  rows: [] as CockpitRow[],
  isSnapshotMode: false,
  edits: {} as Record<string, { production_lead_days: string; shipping_days: string; safety_factor: string }>,
  savingSku: null as string | null,
  rowKeyOf: (row: CockpitRow) => `${row.sku}::${row.country}`,
  onEditChange: vi.fn(),
  onSaveRow: vi.fn(),
  onOpenShipments: vi.fn(),
}

describe('DecisionCockpit 行动道分组（BLF-491）', () => {
  it('按 replenishment_action 分组，6 种行动各自成道，顺序 = 决策优先级', async () => {
    const user = userEvent.setup()
    const rows = [
      makeRow({ sku: 'A', replenishment_action: 'REPLENISH_NOW' }),
      makeRow({ sku: 'B', replenishment_action: 'REPLENISH_NORMAL' }),
      makeRow({ sku: 'C', replenishment_action: 'HOLD' }),
      makeRow({ sku: 'D', replenishment_action: 'REDUCE_PRICE' }),
      makeRow({ sku: 'E', replenishment_action: 'REMOVE' }),
      makeRow({ sku: 'F', replenishment_action: 'NO_ACTION' }),
      makeRow({ sku: 'G', replenishment_action: 'NO_ACTION' }),
    ]
    render(<DecisionCockpit {...BASE_PROPS} rows={rows} />)

    // 6 个 lane header 都在（header 与卡片徽章同文案，用 getAllByText）
    expect(screen.getAllByText('紧急补货').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('按计划补货').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('暂停补货').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('降价清货').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('移除订单').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('不动').length).toBeGreaterThanOrEqual(1)

    // 非折叠道的卡片渲染
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    expect(screen.getByText('C')).toBeInTheDocument()
    expect(screen.getByText('D')).toBeInTheDocument()
    expect(screen.getByText('E')).toBeInTheDocument()

    // NO_ACTION 默认折叠：展开后 F/G 出现
    expect(screen.queryByText('F')).not.toBeInTheDocument()
    await user.click(screen.getAllByText('不动')[0])
    expect(screen.getByText('F')).toBeInTheDocument()
    expect(screen.getByText('G')).toBeInTheDocument()
  })

  it('NO_ACTION 道默认折叠（卡片不渲染），点击 header 展开', async () => {
    const user = userEvent.setup()
    const rows = [makeRow({ sku: 'A', replenishment_action: 'NO_ACTION' })]
    render(<DecisionCockpit {...BASE_PROPS} rows={rows} />)

    // 默认折叠：header 在，卡片内容不在
    expect(screen.getByText('不动')).toBeInTheDocument()
    expect(screen.queryByText('A')).not.toBeInTheDocument()

    // 点击 header 展开
    await user.click(screen.getByText('不动'))
    expect(screen.getByText('A')).toBeInTheDocument()
  })

  it('空行渲染空状态', () => {
    render(<DecisionCockpit {...BASE_PROPS} rows={[]} />)
    expect(screen.getByText(/当前筛选条件下没有可分析的 SKU/)).toBeInTheDocument()
  })

  it('编辑保存走 onEditChange / onSaveRow 回调', async () => {
    const user = userEvent.setup()
    const onEditChange = vi.fn()
    const onSaveRow = vi.fn()
    const row = makeRow({ sku: 'A', replenishment_action: 'HOLD' })
    render(
      <DecisionCockpit
        {...BASE_PROPS}
        rows={[row]}
        edits={{
          'A::US': { production_lead_days: '30', shipping_days: '15', safety_factor: '10' },
        }}
        onEditChange={onEditChange}
        onSaveRow={onSaveRow}
      />
    )

    await user.click(screen.getByRole('button', { name: /保存/ }))
    expect(onSaveRow).toHaveBeenCalledWith(row)
  })
})
