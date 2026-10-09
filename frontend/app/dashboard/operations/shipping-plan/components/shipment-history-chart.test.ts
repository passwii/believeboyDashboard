import { createElement, type ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildShipmentHistoryPoints, type ShipmentHistory } from './shipment-history-data'
import { ShipmentHistoryChart } from './shipment-history-chart'

const chartState = vi.hoisted(() => ({
  data: [] as Array<{
    month: string
    shipment_count: number
    quantity: number
    sales_quantity: number | null
    covered: boolean
    gap: number | null
  }>,
}))

vi.mock('recharts', async () => {
  const React = await import('react')
  return {
    Bar: () => null,
    CartesianGrid: () => null,
    Legend: () => null,
    ComposedChart: ({ children, data }: { children?: ReactNode; data: typeof chartState.data }) => {
      chartState.data = data
      return React.createElement(
        'div',
        { 'data-testid': 'composed-chart' },
        React.createElement('pre', { 'data-testid': 'chart-data' }, JSON.stringify(data)),
        children
      )
    },
    Line: ({ connectNulls }: { connectNulls: boolean }) =>
      React.createElement('div', {
        'data-testid': 'sales-line',
        'data-connect-nulls': String(connectNulls),
      }),
    ResponsiveContainer: ({ children }: { children?: ReactNode }) =>
      React.createElement('div', null, children),
    Tooltip: ({
      content,
    }: {
      content: (props: {
        active: boolean
        payload: Array<{ payload: (typeof chartState.data)[number] }>
      }) => ReactNode
    }) =>
      React.createElement(
        'div',
        { 'data-testid': 'tooltip' },
        content({
          active: true,
          payload: chartState.data.length ? [{ payload: chartState.data[0] }] : [],
        })
      ),
    XAxis: () => null,
    YAxis: () => null,
  }
})

afterEach(() => {
  cleanup()
  chartState.data = []
})

const history: ShipmentHistory = {
  project_id: 42,
  country: 'US',
  etd_from: '2025-10-15',
  etd_to: '2026-10-09',
  months: [
    { month: '2025-10', shipment_count: 1, quantity: 12 },
    { month: '2026-09', shipment_count: 2, quantity: 40 },
  ],
  missing_etd_shipment_count: 0,
  missing_etd_quantity: 0,
  included_statuses: ['in_transit', 'completed'],
  date_basis: 'ETD',
  sales_basis: 'sales report coverage',
}

describe('buildShipmentHistoryPoints', () => {
  it('returns every calendar month in range, filling missing months with zero', () => {
    const points = buildShipmentHistoryPoints(history)

    expect(points).toHaveLength(13)
    expect(points[0]).toMatchObject({
      month: '2025-10',
      shipment_count: 1,
      quantity: 12,
      sales_quantity: null,
      covered: false,
      gap: null,
    })
    expect(points[1]).toMatchObject({ month: '2025-11', shipment_count: 0, quantity: 0 })
    expect(points[11]).toMatchObject({ month: '2026-09', shipment_count: 2, quantity: 40 })
    expect(points[12]).toMatchObject({ month: '2026-10', shipment_count: 0, quantity: 0 })
  })

  it('uses sales months as the aligned timeline and preserves uncovered values as null', () => {
    const points = buildShipmentHistoryPoints({
      ...history,
      sales_months: [
        { month: '2025-10', sales_quantity: null, covered: false },
        { month: '2025-11', sales_quantity: 0, covered: true },
      ],
    })

    expect(points).toEqual([
      {
        month: '2025-10',
        shipment_count: 1,
        quantity: 12,
        sales_quantity: null,
        covered: false,
        gap: null,
      },
      {
        month: '2025-11',
        shipment_count: 0,
        quantity: 0,
        sales_quantity: 0,
        covered: true,
        gap: 0,
      },
    ])
  })

  it('calculates covered-month gaps in both directions', () => {
    const points = buildShipmentHistoryPoints({
      ...history,
      sales_months: [
        { month: '2025-10', sales_quantity: 10, covered: true },
        { month: '2026-09', sales_quantity: 50, covered: true },
      ],
    })

    expect(points.map(({ gap }) => gap)).toEqual([-2, 10])
  })

  it('falls back to returned rows when the date range is invalid', () => {
    expect(buildShipmentHistoryPoints({ ...history, etd_from: 'invalid' })).toEqual(
      history.months.map((shipment) => ({
        ...shipment,
        sales_quantity: null,
        covered: false,
        gap: null,
      }))
    )
  })
})

describe('ShipmentHistoryChart', () => {
  it('does not draw uncovered sales points or turn them into NaN, and labels the tooltip待核实', () => {
    render(
      createElement(ShipmentHistoryChart, {
        history: {
          ...history,
          sales_months: [
            { month: '2025-10', sales_quantity: null, covered: false },
            { month: '2026-09', sales_quantity: 50, covered: true },
          ],
        },
      })
    )

    const chartData = screen.getByTestId('chart-data').textContent ?? ''
    expect(chartData).not.toContain('NaN')
    expect(JSON.parse(chartData)[0].sales_quantity).toBeNull()
    expect(screen.getByTestId('sales-line').getAttribute('data-connect-nulls')).toBe('false')
    expect(screen.getByTestId('tooltip').textContent).toContain('待核实')
  })

  it('omits the sales series and shows cumulative values as待核实 when every month is uncovered', () => {
    render(
      createElement(ShipmentHistoryChart, {
        history: {
          ...history,
          sales_months: [
            { month: '2025-10', sales_quantity: null, covered: false },
            { month: '2026-09', sales_quantity: null, covered: false },
          ],
        },
      })
    )

    expect(screen.queryByTestId('sales-line')).toBeNull()
    expect(screen.getByText(/已覆盖 0\/2 个月/).textContent).toBe(
      '已覆盖 0/2 个月：发运待核实 · 销量待核实 · 差待核实 · 2 个月待核实'
    )
  })

  it('totals shipment, sales, and gap over covered months only when coverage is mixed', () => {
    render(
      createElement(ShipmentHistoryChart, {
        history: {
          ...history,
          months: [
            { month: '2025-10', shipment_count: 1, quantity: 12 },
            { month: '2025-11', shipment_count: 1, quantity: 7 },
            { month: '2025-12', shipment_count: 1, quantity: 100 },
          ],
          sales_months: [
            { month: '2025-10', sales_quantity: 10, covered: true },
            { month: '2025-11', sales_quantity: 12, covered: true },
            { month: '2025-12', sales_quantity: null, covered: false },
          ],
        },
      })
    )

    expect(screen.getByText(/已覆盖 2\/3 个月/).textContent).toBe(
      '已覆盖 2/3 个月：发运 19 件 · 销量 22 件 · 差 +3 件 · 1 个月待核实'
    )
  })

  it('renders legacy responses without sales months using the zero-filled shipment timeline', () => {
    render(createElement(ShipmentHistoryChart, { history }))

    const points = JSON.parse(screen.getByTestId('chart-data').textContent ?? '[]')
    expect(points).toHaveLength(13)
    expect(points[1]).toMatchObject({ quantity: 0, sales_quantity: null, covered: false, gap: null })
    expect(screen.queryByTestId('sales-line')).toBeNull()
  })
})
