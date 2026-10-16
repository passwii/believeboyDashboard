import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  filter: { ready: true, projectId: '42', country: 'US', dateFrom: '', dateTo: '' },
  notify: vi.fn(),
  refresh: vi.fn(),
  slotNode: null as ReactNode,
  selectOnValueChange: null as ((value: string) => void) | null,
}))

vi.mock('@/components/terminal/global-filter-context', () => ({
  useTerminalGlobalFilter: () => mocks.filter,
}))
vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: mocks.notify }),
}))
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
  useHeaderSlot: (node: ReactNode) => { mocks.slotNode = node; return null },
  useMobileFilterStrip: () => null,
}))
vi.mock('recharts', () => ({
  Bar: () => null,
  BarChart: ({ children }: { children: ReactNode }) => <div data-testid="bar-chart">{children}</div>,
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
  Select: ({ children, onValueChange }: { children: ReactNode; onValueChange?: (value: string) => void }) => {
    mocks.selectOnValueChange = onValueChange ?? null
    return <div>{children}</div>
  },
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => <button type="button" role="option" aria-selected="false" onClick={() => mocks.selectOnValueChange?.(value)}>{children}</button>,
  SelectTrigger: ({ children, ...props }: React.HTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  SelectValue: ({ placeholder }: { placeholder: string }) => <span>{placeholder}</span>,
}))

import ShippingPlanClient from './shipping-plan-client'

function response(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
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
  mocks.selectOnValueChange = null
  mocks.notify.mockReset()
  mocks.refresh.mockReset()
  let allocationRemoved = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/skus?')) return response({ items: [sku], total: 1, page: 1, page_size: 200, valid_forecast_sku_count: 1, missing_forecast_sku_count: 0, known_confirmed_sales_upper_bound: 170, known_planned_sales_upper_bound: 180 })
    if (url.includes('/shipment-history?')) return response({ project_id: 42, country: 'US', etd_from: '2025-10-08', etd_to: '2026-10-08', months: [{ month: '2026-09', shipment_count: 2, quantity: 40 }], missing_etd_shipment_count: 1, missing_etd_quantity: 7, included_statuses: ['in_transit', 'completed'], date_basis: 'ETD 作为 V1 计划发运日期代理，不代表实际离港日' })
    if (url.includes('/batches?')) return response({ items: [{ id: 1, name: 'OCT-PLAN', expected_arrival_date: '2026-11-01', status: 'active', remark: null, items: [{ id: 11, sku: 'SKU-001', quantity: 12, allocated_quantity: allocationRemoved ? 0 : 4, remaining_quantity: allocationRemoved ? 12 : 8, allocations: allocationRemoved ? [] : [{ id: 8, plan_item_id: 11, shipment_schedule_id: 90, sku: 'SKU-001', quantity: 4 }] }] }] })
    if (url.includes('/shipment-schedules?')) return response({ items: url.includes('shipment_status=in_transit') ? [] : [{ id: 91, shipment_no: 'FBA-DRAFT-91', shipment_status: 'draft', etd_date: null, eta_date: '2026-11-01' }], has_next: false })
    if (url.includes('/shipment-schedules/91')) return response({ id: 91, shipment_no: 'FBA-DRAFT-91', shipment_status: 'draft', etd_date: null, eta_date: '2026-11-01', items: [{ sku: 'SKU-001', quantity: 10 }] })
    if (url.includes('/allocations/8?') && init?.method === 'DELETE') {
      allocationRemoved = true
      return response({})
    }
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
    expect(await screen.findByText('销量与库存预测')).toBeInTheDocument()
    expect(await screen.findByText('OCT-PLAN')).toBeInTheDocument()
    expect(screen.getByText('计划 12 · 已关联 4 · 余额 8')).toBeInTheDocument()
    expect(screen.getByTestId('shipment-history-chart')).toBeInTheDocument()
    expect(screen.getByText(/缺少 ETD：1 件货/)).toBeInTheDocument()
    expect(screen.getByText(/预测从预计到仓日当天计入库存/)).toBeInTheDocument()
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

  it('offers only matching formal shipment candidates and submits the chosen quantity', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<ShippingPlanClient />)
    await screen.findByText('OCT-PLAN')
    fireEvent.click(screen.getByRole('button', { name: '关联正式货件' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/shipment-schedules?'),
      expect.any(Object)
    ))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/shipment-schedules/91'),
      expect.any(Object)
    ))
    const select = screen.getByLabelText('选择正式货件')
    fireEvent.click(select)
    const candidateOptions = await screen.findAllByRole('option', { name: /FBA-DRAFT-91.*可关联 10/ })
    expect(candidateOptions.length).toBeGreaterThan(0)
    expect(screen.queryByText(/FBA-OTHER-SKU/)).not.toBeInTheDocument()
    fireEvent.click(candidateOptions[0]!)
    fireEvent.change(screen.getByLabelText('关联数量'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/batches/1/allocations?'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ plan_item_id: 11, shipment_schedule_id: 91, quantity: 5 }),
      })
    ))
  })

  it('rejects a quantity above the plan balance before submitting an allocation', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<ShippingPlanClient />)
    await screen.findByText('OCT-PLAN')
    fireEvent.click(screen.getByRole('button', { name: '关联正式货件' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/shipment-schedules/91'), expect.any(Object)))
    fireEvent.click(screen.getByLabelText('选择正式货件'))
    fireEvent.click((await screen.findAllByRole('option', { name: /FBA-DRAFT-91.*可关联 10/ }))[0]!)
    fireEvent.change(screen.getByLabelText('关联数量'), { target: { value: '9' } })
    fireEvent.submit(screen.getByLabelText('关联数量').closest('form')!)
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      title: '关联信息不完整',
      message: '请选择正式货件，并输入不超过计划余额和货件可分配量的正整数。',
    })))
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/batches/1/allocations?'), expect.any(Object))
  })

  it('prevents duplicate allocation submissions while the first request is pending', async () => {
    const fetchMock = vi.mocked(fetch)
    const pending = deferred<Response>()
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/batches/1/allocations?')) return pending.promise
      if (url.includes('/shipment-schedules/91')) return response({ id: 91, shipment_no: 'FBA-DRAFT-91', shipment_status: 'draft', etd_date: null, eta_date: '2026-11-01', items: [{ sku: 'SKU-001', quantity: 10 }] })
      if (url.includes('/shipment-schedules?')) return response({ items: [{ id: 91, shipment_no: 'FBA-DRAFT-91', shipment_status: 'draft', etd_date: null, eta_date: '2026-11-01' }], has_next: false })
      if (url.includes('/skus?')) return response({ items: [sku], total: 1, page: 1, page_size: 200, valid_forecast_sku_count: 1, missing_forecast_sku_count: 0, known_confirmed_sales_upper_bound: '170', known_planned_sales_upper_bound: '180' })
      if (url.includes('/shipment-history?')) return response({ project_id: 42, country: 'US', etd_from: '2025-10-08', etd_to: '2026-10-08', months: [], missing_etd_shipment_count: 0, missing_etd_quantity: 0, included_statuses: [], date_basis: 'ETD' })
      if (url.includes('/batches?')) return response({ items: [{ id: 1, name: 'OCT-PLAN', expected_arrival_date: '2026-11-01', status: 'active', remark: null, items: [{ id: 11, sku: 'SKU-001', quantity: 12, allocated_quantity: 4, remaining_quantity: 8, allocations: [{ id: 8, plan_item_id: 11, shipment_schedule_id: 90, sku: 'SKU-001', quantity: 4 }] }] }] })
      if (url.includes('/forecast?')) return response({ project_id: 42, country: 'US', sku: 'SKU-001', as_of_date: '2026-10-08', forecast_start_date: '2026-10-09', forecast_end_date: '2027-04-06', inventory_snapshot_date: '2026-10-07', sales_baseline_start_date: '2026-09-09', sales_baseline_end_date: '2026-10-08', base_dms: '1.25', growth_factor: '1.1', demand_source: 'manual', data_quality: [], daily_points: [], confirmed_180d_sales_upper_bound: '170', planned_180d_sales_upper_bound: '180', unverified_completed_quantity: 0, overdue_shipment_quantity: 0, overdue_plan_quantity: 0, arrivals: [] })
      return response({})
    })
    render(<ShippingPlanClient />)
    await screen.findByText('OCT-PLAN')
    fireEvent.click(screen.getByRole('button', { name: '关联正式货件' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/shipment-schedules/91'), expect.any(Object)))
    fireEvent.click(screen.getByLabelText('选择正式货件'))
    fireEvent.click((await screen.findAllByRole('option', { name: /FBA-DRAFT-91.*可关联 10/ }))[0]!)
    const form = screen.getByLabelText('关联数量').closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/batches/1/allocations?'))).toHaveLength(1))
    pending.resolve(response({}))
  })

  it('restores the plan balance after removing a formal-shipment allocation', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<ShippingPlanClient />)
    await screen.findByText('计划 12 · 已关联 4 · 余额 8')
    fireEvent.click(screen.getByRole('button', { name: '解除货件 #90 关联' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/allocations/8?'),
      expect.objectContaining({ method: 'DELETE' })
    ))
    expect(await screen.findByText('计划 12 · 已关联 0 · 余额 12')).toBeInTheDocument()
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

  it('keeps the growth-factor draft after a failed save', async () => {
    const fetchMock = vi.mocked(fetch)
    const defaultFetch = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/skus/SKU-001/growth-factor')) {
        return { ok: false, status: 422, json: async () => ({ detail: [{ loc: ['body', 'growth_factor'], msg: '输入不符合要求' }] }) } as Response
      }
      return defaultFetch(input, init)
    })
    render(<ShippingPlanClient />)
    const input = await screen.findByLabelText('SKU 增长系数')
    fireEvent.change(input, { target: { value: '1.7' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      title: '保存失败',
      message: 'growth_factor: 输入不符合要求',
    })))
    expect(input).toHaveValue(1.7)
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
