import { describe, expect, it } from 'vitest'

import { buildMonthlyForecastPoints, calculateInventoryGap, type ForecastChartPoint } from './forecast-chart'

function dailyPoints(start: string, count: number): ForecastChartPoint[] {
  const first = new Date(`${start}T00:00:00Z`)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(first)
    date.setUTCDate(date.getUTCDate() + index)
    return {
      forecast_date: date.toISOString().slice(0, 10),
      demand: '2.5',
      confirmed_sales: '2.5',
      planned_sales: '2.5',
      confirmed_closing_inventory: '10.0',
      planned_closing_inventory: '12.0',
      historical_order_sales: 0,
    }
  })
}

describe('buildMonthlyForecastPoints', () => {
  it('aggregates the full forecast by month and keeps empty months visible', () => {
    const points = dailyPoints('2026-10-09', 180)
    const monthly = buildMonthlyForecastPoints(points)

    expect(monthly.map((point) => point.label)).toEqual([
      '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04',
    ])
    expect(monthly[0]?.demand).toBe(57.5)
    expect(monthly[3]?.demand).toBe(77.5)
    expect(monthly[3]?.confirmed_closing_inventory).toBe('10.0')
    expect(monthly[3]?.confirmed_gap).toBe(0)
  })

  it('leaves monthly historical sales unknown when any day lacks report coverage', () => {
    const points = dailyPoints('2026-10-09', 180)
    points[100] = { ...points[100]!, historical_order_sales: null }

    const january = buildMonthlyForecastPoints(points).find((point) => point.label === '2027-01')

    expect(january?.historical_order_sales).toBeNull()
    expect(january?.demand).toBe(77.5)
  })

  it('includes empty calendar months between disjoint forecast points', () => {
    const points = [dailyPoints('2026-10-09', 1)[0]!, dailyPoints('2026-12-10', 1)[0]!]

    expect(buildMonthlyForecastPoints(points).map((point) => [point.label, point.demand])).toEqual([
      ['2026-10', 2.5], ['2026-11', null], ['2026-12', 2.5],
    ])
  })

  it('calculates unmet demand by scenario and leaves incomplete data unknown', () => {
    const points = dailyPoints('2026-10-09', 3)
    points[0] = { ...points[0]!, confirmed_sales: 0.5, planned_sales: 1.5 }

    expect(calculateInventoryGap(points, 'confirmed_sales')).toEqual({ complete: true, quantity: 2, firstDate: '2026-10-09' })
    expect(calculateInventoryGap(points, 'planned_sales')).toEqual({ complete: true, quantity: 1, firstDate: '2026-10-09' })

    points[1] = { ...points[1]!, confirmed_sales: null }
    expect(calculateInventoryGap(points, 'confirmed_sales')).toEqual({ complete: false, quantity: null, firstDate: null })
  })
})
