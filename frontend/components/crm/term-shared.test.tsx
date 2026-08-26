import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TermEnumPill, CUSTOMER_STATUS_TERM, LEAD_INTENT_TERM, NEUTRAL_TERM } from './term-shared'

/**
 * BLF-837 契约测试：CRM 终端化共享原语。
 * 锁定单色 pill 的终端规格（零圆角、mono、term 语义色），防止回退彩色胶囊。
 */
describe('TermEnumPill（BLF-837 契约）', () => {
  it('渲染零圆角 + mono + 语义色 class', () => {
    render(<TermEnumPill tone="pos">活跃</TermEnumPill>)
    const el = screen.getByText('活跃')
    expect(el.className).toContain('rounded-none')
    expect(el.className).toContain('font-mono')
    expect(el.className).toContain('text-term-pos')
  })

  it('neg / warn / muted 各 tone 映射正确', () => {
    render(
      <>
        <TermEnumPill tone="neg">丢弃</TermEnumPill>
        <TermEnumPill tone="warn">暂缓</TermEnumPill>
        <TermEnumPill tone="muted">其他</TermEnumPill>
      </>
    )
    expect(screen.getByText('丢弃').className).toContain('text-term-neg')
    expect(screen.getByText('暂缓').className).toContain('text-term-warn')
    expect(screen.getByText('其他').className).toContain('text-term-muted')
  })

  it('客户状态映射：active=pos · lost=neg · signed=accent · on_hold=warn', () => {
    expect(CUSTOMER_STATUS_TERM.active).toBe('pos')
    expect(CUSTOMER_STATUS_TERM.lost).toBe('neg')
    expect(CUSTOMER_STATUS_TERM.signed).toBe('accent')
    expect(CUSTOMER_STATUS_TERM.on_hold).toBe('warn')
  })

  it('线索意向映射：high=pos · medium=warn · low=muted；中性分类统一 muted', () => {
    expect(LEAD_INTENT_TERM.high).toBe('pos')
    expect(LEAD_INTENT_TERM.medium).toBe('warn')
    expect(LEAD_INTENT_TERM.low).toBe('muted')
    expect(NEUTRAL_TERM).toBe('muted')
  })
})
