import { describe, expect, it } from 'vitest'

import { buildForecastChartPoints, type ForecastChartPoint } from './forecast-chart'

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

describe('buildForecastChartPoints', () => {
  it('keeps the first 90 days daily and clips later natural-month buckets to the forecast interval', () => {
    const chartPoints = buildForecastChartPoints(dailyPoints('2026-10-09', 180))

    expect(chartPoints).toHaveLength(94)
    expect(chartPoints.slice(0, 90).every((point) => !point.monthly)).toBe(true)
    expect(chartPoints.slice(90).map((point) => [point.label, point.rangeStart, point.rangeEnd])).toEqual([
      ['2027-01', '2027-01-07', '2027-01-31'],
      ['2027-02', '2027-02-01', '2027-02-28'],
      ['2027-03', '2027-03-01', '2027-03-31'],
      ['2027-04', '2027-04-01', '2027-04-06'],
    ])
    expect(chartPoints.slice(90).every((point) => !('interval_start' in point) && !('interval_end' in point))).toBe(true)
  })

  it('leaves monthly historical sales unknown when any day lacks report coverage', () => {
    const points = dailyPoints('2026-10-09', 180)
    points[100] = { ...points[100]!, historical_order_sales: null }

    const januaryBucket = buildForecastChartPoints(points).find((point) => point.label === '2027-01')

    expect(januaryBucket?.historical_order_sales).toBeNull()
    expect(januaryBucket?.demand).toBe(62.5)
  })
})
