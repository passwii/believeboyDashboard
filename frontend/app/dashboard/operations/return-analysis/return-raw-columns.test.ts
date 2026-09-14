import { describe, expect, it } from 'vitest'

import { RAW_DISPLAY_LIMIT, RETURN_RAW_COLUMNS } from './return-raw-columns'

/** spec §1.2 的 17 列表头（顺序即契约：原值列后紧跟中文翻译列）。 */
const EXPECTED_LABELS = [
  '退货日期（站点时区）',
  '原始退货时间',
  '订单号',
  'SKU',
  'ASIN',
  'FNSKU',
  '产品名称',
  '数量',
  '运营中心',
  '商品状态',
  '商品状态（中文）',
  '退货原因',
  '退货原因（中文）',
  '库存属性',
  '库存属性（中文）',
  'LPN',
  '顾客评论',
]

describe('退货原始数据列配置', () => {
  it('17 列，key 与表头均唯一', () => {
    expect(RETURN_RAW_COLUMNS).toHaveLength(17)
    expect(new Set(RETURN_RAW_COLUMNS.map((c) => c.key)).size).toBe(17)
    expect(new Set(RETURN_RAW_COLUMNS.map((c) => c.label)).size).toBe(17)
  })

  it('列顺序与 spec §1.2 一致', () => {
    expect(RETURN_RAW_COLUMNS.map((c) => c.label)).toEqual(EXPECTED_LABELS)
  })

  it('每列都有正数列宽与页面最小宽度（Excel 与 Tab 共用同一份配置）', () => {
    for (const column of RETURN_RAW_COLUMNS) {
      expect(column.width).toBeGreaterThan(0)
      expect(column.minWidth).toMatch(/^min-w-\[/)
    }
  })

  it('页内渲染上限为正整数', () => {
    expect(Number.isInteger(RAW_DISPLAY_LIMIT)).toBe(true)
    expect(RAW_DISPLAY_LIMIT).toBeGreaterThan(0)
  })
})
