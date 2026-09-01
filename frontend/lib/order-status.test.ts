import { describe, expect, it } from 'vitest'

import {
  getOrderStatusLabel,
  getOrderStatusTone,
  ORDER_STATUS_TONE_PILL_CLASS,
} from '@/lib/order-status'

describe('lib/order-status · tone 公共导出（BLF-927）', () => {
  it('getOrderStatusTone：Pending→warn · Shipped→pos · Cancelled→neg · 其他→muted', () => {
    expect(getOrderStatusTone('Pending')).toBe('warn')
    expect(getOrderStatusTone('pending')).toBe('warn')
    expect(getOrderStatusTone('Shipped')).toBe('pos')
    expect(getOrderStatusTone('Shipping')).toBe('pos')
    expect(getOrderStatusTone('Cancelled')).toBe('neg')
    expect(getOrderStatusTone('Canceled')).toBe('neg')
    expect(getOrderStatusTone('Unfulfillable')).toBe('neg')
    expect(getOrderStatusTone('Whatever')).toBe('muted')
  })

  it('TONE_PILL_CLASS：四态均含 1px 语义色边界 + 零圆角（终端契约 BLF-809）', () => {
    expect(ORDER_STATUS_TONE_PILL_CLASS.pos).toContain('border-term-pos/50')
    expect(ORDER_STATUS_TONE_PILL_CLASS.warn).toContain('border-term-warn/50')
    expect(ORDER_STATUS_TONE_PILL_CLASS.neg).toContain('border-term-neg/50')
    expect(ORDER_STATUS_TONE_PILL_CLASS.muted).toContain('border-term-border-strong')
    // class 列表不含 rounded-*（方角）
    for (const cls of Object.values(ORDER_STATUS_TONE_PILL_CLASS)) {
      expect(cls).not.toMatch(/rounded/)
    }
  })

  it('getOrderStatusLabel 既有契约不回归（中文标签）', () => {
    expect(getOrderStatusLabel('Pending')).toBe('处理中')
    expect(getOrderStatusLabel('Shipped')).toBe('已发货')
    expect(getOrderStatusLabel('Cancelled')).toBe('已取消')
    expect(getOrderStatusLabel(null)).toBe('—')
  })
})
