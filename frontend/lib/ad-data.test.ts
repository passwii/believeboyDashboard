import { describe, it, expect } from 'vitest'

import {
  AD_DATA_REPORT_TYPES,
  buildAdDataCsv,
  formatAdDataValue,
  getAdDataReportType,
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
