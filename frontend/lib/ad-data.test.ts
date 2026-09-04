import { describe, it, expect } from 'vitest'

import {
  AD_DATA_REPORT_TYPES,
  aggregateAdDataRows,
  buildAdDataCsv,
  formatAdDataValue,
  getAdDataReportType,
  getAggregateColumns,
  isNumericFormat,
} from './ad-data'

describe('formatAdDataValue', () => {
  it('空值返回占位符', () => {
    expect(formatAdDataValue(null, 'money')).toBe('-')
    expect(formatAdDataValue(undefined, 'int')).toBe('-')
    expect(formatAdDataValue('', 'text')).toBe('-')
  })

  it('money 加 $ 并保留两位小数', () => {
    expect(formatAdDataValue(24.9, 'money')).toBe('$24.90')
    expect(formatAdDataValue(0, 'money')).toBe('$0.00')
  })

  it('percent 把 ratio 转成 %', () => {
    expect(formatAdDataValue(0.14652, 'percent')).toBe('14.65%')
    expect(formatAdDataValue(0, 'percent')).toBe('0.00%')
  })

  it('int 千分位', () => {
    expect(formatAdDataValue(2087, 'int')).toBe('2,087')
  })

  it('ratio 保留两位小数', () => {
    expect(formatAdDataValue(6.82, 'ratio')).toBe('6.82')
  })

  it('text / date 原样输出', () => {
    expect(formatAdDataValue('ENABLED', 'text')).toBe('ENABLED')
    expect(formatAdDataValue('2026-07-08', 'date')).toBe('2026-07-08')
  })
})

describe('isNumericFormat', () => {
  it('text / date 非数值', () => {
    expect(isNumericFormat('text')).toBe(false)
    expect(isNumericFormat('date')).toBe(false)
  })
  it('int / money / percent / ratio 数值', () => {
    expect(isNumericFormat('int')).toBe(true)
    expect(isNumericFormat('money')).toBe(true)
    expect(isNumericFormat('percent')).toBe(true)
    expect(isNumericFormat('ratio')).toBe(true)
  })
})

describe('getAdDataReportType', () => {
  it('10 种报表类型齐全', () => {
    expect(AD_DATA_REPORT_TYPES).toHaveLength(10)
  })

  it('按 reportType 查到配置且 endpoint 非空', () => {
    const cfg = getAdDataReportType('ad_campaign_report')
    expect(cfg).toBeDefined()
    expect(cfg?.endpoint).toBe('campaigns')
    expect(cfg?.columns.length).toBeGreaterThan(0)
  })

  it('未知类型返回 undefined', () => {
    expect(getAdDataReportType('nope')).toBeUndefined()
  })
})

describe('buildAdDataCsv', () => {
  const columns = [
    { key: 'name', label: '名称', format: 'text' as const },
    { key: 'spend', label: '花费', format: 'money' as const },
    { key: 'ctr', label: '点击率', format: 'percent' as const },
  ]
  const rows = [
    { name: 'A, B', spend: 10, ctr: 0.05 },
    { name: 'Normal', spend: 20, ctr: 0.1 },
  ]

  it('构造中文列头 + 格式化行', () => {
    const csv = buildAdDataCsv(rows, columns)
    const lines = csv.split('\n')
    expect(lines[0]).toBe('名称,花费,点击率')
    expect(lines[1]).toBe('"A, B",$10.00,5.00%')
    expect(lines[2]).toBe('Normal,$20.00,10.00%')
  })

  it('含逗号的值被引号包裹', () => {
    const csv = buildAdDataCsv(rows, columns)
    expect(csv).toContain('"A, B"')
  })
})

describe('getAggregateColumns', () => {
  it('returns group keys + dates + additive + ratio columns (campaign)', () => {
    const cfg = getAdDataReportType('ad_campaign_report')!
    const keys = getAggregateColumns(cfg).map((c) => c.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        'report_start_date',
        'report_end_date',
        'campaign_name',
      ]),
    )
    expect(keys).toEqual(
      expect.arrayContaining([
        'impressions',
        'clicks',
        'spend',
        'sales_7d',
        'orders_7d',
      ]),
    )
    expect(keys).toEqual(expect.arrayContaining(['ctr', 'cpc', 'acos', 'roas']))
    expect(keys).not.toContain('portfolio_name')
    expect(keys).not.toContain('budget')
  })
})

describe('aggregateAdDataRows', () => {
  it('empty input → []', () => {
    const cfg = getAdDataReportType('ad_campaign_report')!
    expect(aggregateAdDataRows([], cfg)).toEqual([])
  })

  it('groups by groupBy key and sums additive metrics', () => {
    const cfg = getAdDataReportType('ad_campaign_report')!
    const rows = [
      { campaign_name: 'A', impressions: 100, clicks: 10, spend: 5, sales_7d: 20, report_start_date: '2026-07-01', report_end_date: '2026-07-01' },
      { campaign_name: 'A', impressions: 200, clicks: 20, spend: 8, sales_7d: 40, report_start_date: '2026-07-02', report_end_date: '2026-07-02' },
      { campaign_name: 'B', impressions: 50, clicks: 5, spend: 2, sales_7d: 10, report_start_date: '2026-07-01', report_end_date: '2026-07-01' },
    ]
    const agg = aggregateAdDataRows(rows, cfg)
    expect(agg).toHaveLength(2)
    const a = agg.find((r) => r.campaign_name === 'A') as Record<string, number>
    expect(a.impressions).toBe(300)
    expect(a.clicks).toBe(30)
    expect(a.spend).toBe(13)
    expect(a.sales_7d).toBe(60)
    const b = agg.find((r) => r.campaign_name === 'B') as Record<string, number>
    expect(b.impressions).toBe(50)
  })

  it('recomputes CTR/CPC/ACOS/ROAS from summed bases', () => {
    const cfg = getAdDataReportType('ad_campaign_report')!
    const rows = [
      { campaign_name: 'A', impressions: 100, clicks: 10, spend: 10, sales_7d: 50, report_start_date: '2026-07-01', report_end_date: '2026-07-01' },
      { campaign_name: 'A', impressions: 300, clicks: 30, spend: 30, sales_7d: 150, report_start_date: '2026-07-02', report_end_date: '2026-07-02' },
    ]
    const agg = aggregateAdDataRows(rows, cfg)
    expect(agg).toHaveLength(1)
    const a = agg[0] as Record<string, number>
    expect(a.ctr).toBeCloseTo(0.1, 5)
    expect(a.cpc).toBeCloseTo(1.0, 5)
    expect(a.acos).toBeCloseTo(0.2, 5)
    expect(a.roas).toBeCloseTo(5, 5)
  })

  it('stitches period as min start ~ max end', () => {
    const cfg = getAdDataReportType('ad_campaign_report')!
    const rows = [
      { campaign_name: 'A', impressions: 1, clicks: 0, spend: 0, sales_7d: 0, report_start_date: '2026-07-02', report_end_date: '2026-07-02' },
      { campaign_name: 'A', impressions: 1, clicks: 0, spend: 0, sales_7d: 0, report_start_date: '2026-07-01', report_end_date: '2026-07-01' },
      { campaign_name: 'A', impressions: 1, clicks: 0, spend: 0, sales_7d: 0, report_start_date: '2026-07-05', report_end_date: '2026-07-05' },
    ]
    const [a] = aggregateAdDataRows(rows, cfg)
    expect(a.report_start_date).toBe('2026-07-01')
    expect(a.report_end_date).toBe('2026-07-05')
  })

  it('div-by-zero in ratio → 0', () => {
    const cfg = getAdDataReportType('ad_campaign_report')!
    const rows = [
      { campaign_name: 'A', impressions: 0, clicks: 0, spend: 0, sales_7d: 0, report_start_date: '2026-07-01', report_end_date: '2026-07-01' },
    ]
    const [a] = aggregateAdDataRows(rows, cfg)
    expect(a.ctr).toBe(0)
    expect(a.cpc).toBe(0)
    expect(a.acos).toBe(0)
    expect(a.roas).toBe(0)
  })
})
