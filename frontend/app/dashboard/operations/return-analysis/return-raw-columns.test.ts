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

/**
 * 与后端 `ReturnRawRowItem`（backend/app/schemas/return_analysis.py）的 17 个字段
 * 一一对应，顺序即后端 schema 顺序 —— 这是列配置的核心契约：
 * key 决定取哪一列数据，label 只是表头，两者必须成对绑定。
 * 后端 counterpart：backend/tests/api/test_return_analysis_raw_rows.py。
 */
const EXPECTED_KEYS = [
  'return_date',
  'original_return_datetime',
  'order_id',
  'sku',
  'asin',
  'fnsku',
  'product_name',
  'quantity',
  'fulfillment_center_id',
  'detailed_disposition',
  'disposition_display',
  'reason',
  'reason_display',
  'status',
  'status_display',
  'license_plate_number',
  'customer_comment',
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

  it('key 顺序与后端 ReturnRawRowItem 字段一致', () => {
    expect(RETURN_RAW_COLUMNS.map((c) => c.key)).toEqual(EXPECTED_KEYS)
  })

  it('key 与 label 成对绑定，互换任一 key 即失败', () => {
    expect(RETURN_RAW_COLUMNS.map((c) => [c.key, c.label])).toEqual(
      EXPECTED_KEYS.map((key, index) => [key, EXPECTED_LABELS[index]]),
    )
  })

  it('每列都有正数列宽与页面最小宽度（Excel 与 Tab 共用同一份配置）', () => {
    for (const column of RETURN_RAW_COLUMNS) {
      expect(column.width).toBeGreaterThan(0)
      expect(column.minWidth).toMatch(/^min-w-\[\d+px\]$/)
    }
  })

  it('页内渲染上限为 200 的正整数', () => {
    expect(Number.isInteger(RAW_DISPLAY_LIMIT)).toBe(true)
    expect(RAW_DISPLAY_LIMIT).toBeGreaterThan(0)
    expect(RAW_DISPLAY_LIMIT).toBe(200)
  })
})
