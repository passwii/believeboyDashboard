/**
 * 前端侧字段词典契约测试（BLF-431）。
 *
 * 镜像后端 backend/tests/schemas/test_inventory_ledger_field_glossary.py：
 * 锁定 22 summary + 16 detail + 2 technical 键集合、en 镜像结构、
 * 共享列与去重后唯一字段数——任何重命名/删 label 都会红测。
 *
 * 另含列头渲染测试：中文 label 展示 + hover tooltip 显示英文列名。
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import {
  DETAIL_EN,
  DETAIL_LABELS,
  SUMMARY_EN,
  SUMMARY_LABELS,
  TECHNICAL_LABELS,
  detailLabel,
  summaryEn,
  summaryLabel,
} from './ledger-glossary'
import { LedgerDetailTab } from './ledger-detail-tab'
import { LedgerSummaryTab } from './ledger-summary-tab'

// ── 词典键集合（与后端 glossary 测试一一对应） ───────────────────────────────

const SUMMARY_KEYS = [
  'date',
  'fnsku',
  'asin',
  'msku',
  'title',
  'disposition',
  'location',
  'starting_balance',
  'in_transit_between',
  'receipts',
  'customer_shipments',
  'customer_returns',
  'vendor_returns',
  'warehouse_transfer_io',
  'found',
  'lost',
  'damaged',
  'disposed',
  'other_events',
  'ending_balance',
  'unknown_events',
  'store',
]

const DETAIL_KEYS = [
  'date',
  'fnsku',
  'asin',
  'msku',
  'title',
  'event_type',
  'reference_id',
  'quantity',
  'fulfillment_center',
  'disposition',
  'reason',
  'country',
  'reconciled_quantity',
  'unreconciled_quantity',
  'date_and_time',
  'store',
]

const TECHNICAL_KEYS = ['id', 'batch_id']

describe('inventory-ledger 字段词典（BLF-431）', () => {
  it('summary 22 业务字段键集合与后端 glossary 一致', () => {
    expect(Object.keys(SUMMARY_LABELS).sort()).toEqual([...SUMMARY_KEYS].sort())
    expect(Object.keys(SUMMARY_LABELS)).toHaveLength(22)
  })

  it('detail 16 业务字段键集合与后端 glossary 一致', () => {
    expect(Object.keys(DETAIL_LABELS).sort()).toEqual([...DETAIL_KEYS].sort())
    expect(Object.keys(DETAIL_LABELS)).toHaveLength(16)
  })

  it('technical 2 个技术字段（id / batch_id）', () => {
    expect(Object.keys(TECHNICAL_LABELS).sort()).toEqual([...TECHNICAL_KEYS].sort())
  })

  it('en 英文列名与 zh 键集合完全镜像（每个中文 label 都有英文 tooltip）', () => {
    expect(Object.keys(SUMMARY_EN).sort()).toEqual(Object.keys(SUMMARY_LABELS).sort())
    expect(Object.keys(DETAIL_EN).sort()).toEqual(Object.keys(DETAIL_LABELS).sort())
  })

  it('两表共享 7 列、去重后 31 个唯一字段（38 = 22 + 16）', () => {
    const shared = SUMMARY_KEYS.filter((k) => DETAIL_KEYS.includes(k))
    expect(shared).toHaveLength(7)
    const distinct = new Set([...SUMMARY_KEYS, ...DETAIL_KEYS])
    expect(distinct.size).toBe(31)
  })

  it('未知键回退为原键（防崩）', () => {
    expect(summaryLabel('not_a_field')).toBe('not_a_field')
    expect(summaryEn('not_a_field')).toBe('not_a_field')
    expect(detailLabel('not_a_field')).toBe('not_a_field')
  })

  it('标识符字段（fnsku/asin/msku）保持英文不翻译', () => {
    expect(SUMMARY_LABELS.fnsku).toBe('FNSKU')
    expect(SUMMARY_LABELS.asin).toBe('ASIN')
    expect(SUMMARY_LABELS.msku).toBe('MSKU')
    expect(DETAIL_LABELS.fnsku).toBe('FNSKU')
    expect(DETAIL_LABELS.asin).toBe('ASIN')
    expect(DETAIL_LABELS.msku).toBe('MSKU')
  })
})

// ── 列头渲染：中文 label + hover tooltip 英文列名 ─────────────────────────────

const SUMMARY_ROW = {
  id: 1,
  date: '2026-03-02',
  fnsku: 'FN-A',
  asin: 'B-A',
  msku: 'SKU-A',
  title: 'Item A',
  disposition: 'SELLABLE',
  location: 'LAX1',
  starting_balance: 45,
  in_transit_between: 0,
  receipts: 0,
  customer_shipments: -5,
  customer_returns: 0,
  vendor_returns: 0,
  warehouse_transfer_io: 0,
  found: 0,
  lost: 0,
  damaged: 0,
  disposed: 0,
  other_events: 0,
  ending_balance: 40,
  unknown_events: 0,
  store: null,
  batch_id: 1,
}

const DETAIL_ROW = {
  id: 101,
  date: '2026-03-02',
  fnsku: 'FN-A',
  asin: 'B-A',
  msku: 'SKU-A',
  title: 'Item A',
  event_type: 'Receipts',
  reference_id: 'FBA123',
  quantity: 9,
  fulfillment_center: 'LAX1',
  disposition: 'SELLABLE',
  reason: null,
  country: 'US',
  reconciled_quantity: null,
  unreconciled_quantity: null,
  date_and_time: null,
  store: null,
  batch_id: 1,
}

describe('库存分类账列头（BLF-431 前端交付）', () => {
  it('summary 列头显示中文 label（期初库存/期末库存/客户发货…）', () => {
    render(<LedgerSummaryTab rows={[SUMMARY_ROW]} period="2026-03" />)
    expect(screen.getAllByText('日期').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('期初库存')).toBeInTheDocument()
    expect(screen.getByText('期末库存')).toBeInTheDocument()
    expect(screen.getByText('客户发货')).toBeInTheDocument()
    expect(screen.getByText('仓库调拨')).toBeInTheDocument()
  })

  it('summary 列头 hover 显示英文列名 tooltip', async () => {
    const user = userEvent.setup()
    render(<LedgerSummaryTab rows={[SUMMARY_ROW]} period="2026-03" />)
    await user.hover(screen.getByText('期初库存'))
    // Radix Tooltip 会渲染一个视觉隐藏的 a11y 副本（role=tooltip），
    // 因此用 findAllByText 断言至少出现一次英文列名。
    expect((await screen.findAllByText('Starting Warehouse Balance')).length).toBeGreaterThan(0)
  })

  it('detail 列头显示中文 label（事件类型/履约中心/处置状态/参考编号）', () => {
    render(<LedgerDetailTab rows={[DETAIL_ROW]} period="2026-03" />)
    expect(screen.getByText('事件类型')).toBeInTheDocument()
    expect(screen.getByText('履约中心')).toBeInTheDocument()
    expect(screen.getByText('处置状态')).toBeInTheDocument()
    expect(screen.getByText('参考编号')).toBeInTheDocument()
    expect(screen.getByText('上传批次 ID')).toBeInTheDocument()
  })

  it('detail 列头 hover 显示英文列名 tooltip（Fulfillment Center / Event Type）', async () => {
    const user = userEvent.setup()
    render(<LedgerDetailTab rows={[DETAIL_ROW]} period="2026-03" />)
    await user.hover(screen.getByText('履约中心'))
    expect((await screen.findAllByText('Fulfillment Center')).length).toBeGreaterThan(0)
  })

  it('亚马逊枚举值不翻译（SELLABLE 徽章仍为中文可售/英文原文走 dispositionLabel）', () => {
    render(<LedgerSummaryTab rows={[SUMMARY_ROW]} period="2026-03" />)
    // SELLABLE 徽章渲染为「可售」（BEL-428 既有行为），列值不引入新翻译
    expect(screen.getAllByText('可售').length).toBeGreaterThanOrEqual(1)
  })
})
