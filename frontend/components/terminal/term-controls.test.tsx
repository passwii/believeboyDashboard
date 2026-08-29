import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'

import {
  TERM_BUTTON,
  TERM_INPUT,
  TERM_SELECT_NATIVE,
  TermKpiTile,
  TermPill,
  TermTabBar,
  TermToolbarRow,
} from './term-controls'

/**
 * BLF-838 · 批次 F 终端控件基类契约：
 * 零圆角 / 1px term 边界 / 等宽数值——与 BLF-817/836/837 的 term-shared 同规格。
 */

describe('term-controls 控件基类（BLF-838）', () => {
  it('TERM_INPUT：零圆角 + mono 数值 + 无阴影', () => {
    expect(TERM_INPUT).toContain('rounded-none')
    expect(TERM_INPUT).toContain('font-mono')
    expect(TERM_INPUT).toContain('shadow-none')
    expect(TERM_INPUT).toContain('border-term-border')
  })

  it('TERM_BUTTON：h-9 工具行档位（BLF-887 上档）+ mono 文本', () => {
    expect(TERM_BUTTON).toContain('h-9')
    expect(TERM_BUTTON).toContain('rounded-none')
    expect(TERM_BUTTON).toContain('font-mono')
  })

  it('TERM_SELECT_NATIVE：h-9 + 零圆角原生 select 基类（BLF-887 上档）', () => {
    expect(TERM_SELECT_NATIVE).toContain('h-9')
    expect(TERM_SELECT_NATIVE).toContain('rounded-none')
  })

  it('TermPill：单色 pill（零圆角 + 边界 + mono）按 tone 着色', () => {
    const { getByTestId } = render(<TermPill tone="neg" data-testid="pill">失败</TermPill>)
    const el = getByTestId('pill')
    expect(el.className).toContain('rounded-none')
    expect(el.className).toContain('font-mono')
    expect(el.className).toContain('text-term-neg')
  })

  it('TermTabBar：激活态走 term-raised，非激活 hover 提亮', () => {
    const { getAllByRole } = render(
      <TermTabBar
        tabs={[
          { key: 'a' as const, label: 'A' },
          { key: 'b' as const, label: 'B' },
        ]}
        active="b"
        onChange={() => {}}
      />
    )
    const tabs = getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(tabs[1].className).toContain('bg-term-raised')
    expect(tabs[0].className).not.toContain('bg-term-raised')
  })

  it('TermKpiTile：mono tabular 数值 + loading 占位', () => {
    const { getByTestId, rerender } = render(
      <TermKpiTile label="总数" value="1234" data-testid="kpi" />
    )
    const value = getByTestId('kpi-value')
    expect(value.className).toContain('font-mono')
    expect(value.className).toContain('tabular-nums')
    expect(value.textContent).toBe('1234')

    rerender(<TermKpiTile label="总数" value="" data-testid="kpi" loading />)
    expect(getByTestId('kpi-value').textContent).toBe('···')
  })

  it('TermToolbarRow：桌面右对齐、移动端两端分布', () => {
    const { container } = render(<TermToolbarRow right={<span>x</span>} />)
    const row = container.firstElementChild as HTMLElement
    expect(row.className).toContain('justify-end')
    expect(row.className).toContain('max-md:justify-between')
  })
})
