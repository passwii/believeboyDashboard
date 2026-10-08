import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  filter: { ready: true, projectId: '42', country: 'US', dateFrom: '', dateTo: '' },
  notify: vi.fn(),
  refresh: vi.fn(),
  slotNode: null as ReactNode,
}))

vi.mock('@/components/terminal/global-filter-context', () => ({
  useTerminalGlobalFilter: () => mocks.filter,
}))
vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: mocks.notify }),
}))
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderSlot: (node: ReactNode) => { mocks.slotNode = node; return null },
  useMobileFilterStrip: () => null,
}))
vi.mock('recharts', () => ({
  CartesianGrid: () => null,
  ComposedChart: ({ children }: { children: ReactNode }) => <div data-testid="chart">{children}</div>,
  Legend: () => null,
  Line: () => null,
  ReferenceLine: () => null,
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: React.HTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  SelectValue: ({ placeholder }: { placeholder: string }) => <span>{placeholder}</span>,
}))

import ShippingPlanClient from './shipping-plan-client'

function response(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response
}

const sku = {
  sku: 'SKU-001', asin: 'B0TEST', product_name: '测试商品',
  available_inventory: 20, inventory_snapshot_date: '2026-10-07', base_dms: 1.25,
  growth_factor: 1.1, demand_source: 'manual', in_transit_quantity: 40, draft_quantity: 5,
  active_plan_remaining_quantity: 8,
  confirmed_180d_sales_upper_bound: 170, planned_180d_sales_upper_bound: 180,
  data_quality: [],
}

beforeEach(() => {
  mocks.filter = { ready: true, projectId: '42', country: 'US', dateFrom: '', dateTo: '' }
  mocks.notify.mockReset()
  mocks.refresh.mockReset()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/skus?')) return response({ items: [sku], total: 1, page: 1, page_size: 200, valid_forecast_sku_count: 1, missing_forecast_sku_count: 0, known_confirmed_sales_upper_bound: 170, known_planned_sales_upper_bound: 180 })
    if (url.includes('/shipment-history?')) return response({ project_id: 42, country: 'US', etd_from: '2025-10-08', etd_to: '2026-10-08', months: [{ month: '2026-09', shipment_count: 2, quantity: 40 }], missing_etd_shipment_count: 1, missing_etd_quantity: 7, included_statuses: ['in_transit', 'completed'], date_basis: 'ETD 作为 V1 计划发运日期代理，不代表实际离港日' })
    if (url.includes('/batches?')) return response({ items: [{ id: 1, name: 'OCT-PLAN', expected_arrival_date: '2026-11-01', status: 'active', remark: null, items: [{ id: 11, sku: 'SKU-001', quantity: 12, allocated_quantity: 4, remaining_quantity: 8, allocations: [{ id: 8, plan_item_id: 11, shipment_schedule_id: 90, sku: 'SKU-001', quantity: 4 }] }] }] })
    if (url.includes('/forecast?')) return response({ project_id: 42, country: 'US', sku: 'SKU-001', as_of_date: '2026-10-08', forecast_start_date: '2026-10-09', forecast_end_date: '2027-04-06', inventory_snapshot_date: '2026-10-07', sales_baseline_start_date: '2026-09-09', sales_baseline_end_date: '2026-10-08', base_dms: 1.25, growth_factor: 1.1, demand_source: 'manual', data_quality: [], daily_points: [{ forecast_date: '2026-10-09', demand: 1.375, confirmed_sales: 1.375, planned_sales: 1.375, confirmed_closing_inventory: 18.625, planned_closing_inventory: 18.625, historical_order_sales: null }], confirmed_180d_sales_upper_bound: 170, planned_180d_sales_upper_bound: 180, unverified_completed_quantity: 0, overdue_shipment_quantity: 0, overdue_plan_quantity: 0, arrivals: [] })
    return response({})
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ShippingPlanClient', () => {
  it('shows plan projections, shipment history and partial allocation balance', async () => {
    render(<ShippingPlanClient />)
    expect(await screen.findByText('180 天 SKU 销售上限')).toBeInTheDocument()
    expect(await screen.findByText('OCT-PLAN')).toBeInTheDocument()
    expect(screen.getByText('计划 12 · 已关联 4 · 余额 8')).toBeInTheDocument()
    expect(screen.getByText('2026-09')).toBeInTheDocument()
    expect(screen.getByText(/缺 ETD：1 件/)).toBeInTheDocument()
    expect(screen.getByText(/V1 假设货件到仓日当天可售/)).toBeInTheDocument()
  })

  it('requires a single site instead of aggregating ALL sites', () => {
    mocks.filter = { ready: true, projectId: '42', country: 'ALL', dateFrom: '', dateTo: '' }
    render(<ShippingPlanClient />)
    expect(screen.getByText('请先选择项目和单一站点')).toBeInTheDocument()
    expect(screen.queryByTestId('shipping-plan-forecast-chart')).not.toBeInTheDocument()
  })

  it('creates a multi-SKU plan batch with normalized positive integer quantities', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<ShippingPlanClient />)
    await screen.findByText('OCT-PLAN')
    fireEvent.change(screen.getByLabelText('计划批次名称'), { target: { value: 'NOV-PLAN' } })
    fireEvent.change(screen.getByLabelText('预计到仓日期'), { target: { value: '2026-11-20' } })
    fireEvent.change(screen.getByLabelText('计划 SKU 1'), { target: { value: 'SKU-001' } })
    fireEvent.change(screen.getByLabelText('计划数量 1'), { target: { value: '18' } })
    fireEvent.click(screen.getByRole('button', { name: '创建多 SKU 计划' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/batches'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          project_id: 42,
          country: 'US',
          name: 'NOV-PLAN',
          expected_arrival_date: '2026-11-20',
          items: [{ sku: 'SKU-001', quantity: 18 }],
        }),
      })
    ))
  })

  it('preserves allocated minimum quantity when editing a batch', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<ShippingPlanClient />)
    await screen.findByText('OCT-PLAN')
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('编辑计划批次名称'), { target: { value: 'OCT-UPDATED' } })
    fireEvent.change(screen.getByLabelText('编辑 SKU-001 计划数量'), { target: { value: '14' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/batches/1?'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          name: 'OCT-UPDATED',
          expected_arrival_date: '2026-11-01',
          items: [{ sku: 'SKU-001', quantity: 14 }],
        }),
      })
    ))
  })

  it('cancels a batch only after confirming outstanding plan quantity exits the scenario', async () => {
    const fetchMock = vi.mocked(fetch)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ShippingPlanClient />)
    await screen.findByText('OCT-PLAN')
    fireEvent.click(screen.getByRole('button', { name: '取消计划' }))
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining('未关联的 8 件将退出计划情景')))
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/batches/1/cancel?'),
      expect.objectContaining({ method: 'POST', body: '{}' })
    )
    confirm.mockRestore()
  })

  it('posts a non-negative SKU growth factor and refreshes the data', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<ShippingPlanClient />)
    const input = await screen.findByLabelText('SKU 增长系数')
    fireEvent.change(input, { target: { value: '1.4' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/skus/SKU-001/growth-factor'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ project_id: 42, country: 'US', growth_factor: 1.4 }),
        })
      )
    )
  })
})
