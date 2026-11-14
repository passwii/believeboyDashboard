import * as React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { MobileFilterStrip, MobileFilterWide } from './mobile-filter-strip'

/**
 * MobileFilterStrip —— 移动端可折叠筛选条（BLF-933 Stage 1）。
 *
 * 折叠态：筛选摘要 + 展开按钮；展开态：grid-cols-2 网格，宽控件（MobileFilterWide）col-span-2。
 * 触控目标 ≥44px；Terminal 终端风格（1px border / 零圆角 / term-* 色组）。
 */

const shortControls = (
  <>
    <span>项目筛选</span>
    <span>站点筛选</span>
  </>
)

describe('MobileFilterStrip', () => {
  it('折叠态：渲染筛选摘要与展开按钮，控件不可见', () => {
    render(
      <MobileFilterStrip summary="玥涵 · US · 06/01~09/01" controls={shortControls} />
    )

    expect(screen.getByTestId('mobile-filter-strip')).toBeInTheDocument()
    expect(screen.getByText('玥涵 · US · 06/01~09/01')).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: '切换页面筛选' })
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // 折叠态不渲染网格与控件
    expect(screen.queryByTestId('mobile-filter-strip-grid')).not.toBeInTheDocument()
    expect(screen.queryByText('项目筛选')).not.toBeInTheDocument()
  })

  it('点击展开：网格出现、控件渲染、按钮切换收起', async () => {
    const user = userEvent.setup()
    render(
      <MobileFilterStrip summary="玥涵 · US · 06/01~09/01" controls={shortControls} />
    )

    await user.click(screen.getByRole('button', { name: '切换页面筛选' }))

    const grid = screen.getByTestId('mobile-filter-strip-grid')
    expect(grid).toBeInTheDocument()
    expect(grid).toHaveClass('grid-cols-2')
    expect(screen.getByText('项目筛选')).toBeInTheDocument()
    expect(screen.getByText('站点筛选')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '切换页面筛选' })).toHaveAttribute('aria-expanded', 'true')

    // 再次点击收起
    await user.click(screen.getByRole('button', { name: '切换页面筛选' }))
    expect(screen.queryByTestId('mobile-filter-strip-grid')).not.toBeInTheDocument()
  })

  it('受控模式：open/onOpenChange 生效', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <MobileFilterStrip
        summary="摘要"
        controls={shortControls}
        open
        onOpenChange={onOpenChange}
      />
    )

    expect(screen.getByTestId('mobile-filter-strip-grid')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '切换页面筛选' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    // 受控下展开态由外部 open 决定，点击只通知不改变自身
    rerender(
      <MobileFilterStrip
        summary="摘要"
        controls={shortControls}
        open={false}
        onOpenChange={onOpenChange}
      />
    )
    expect(screen.queryByTestId('mobile-filter-strip-grid')).not.toBeInTheDocument()
  })

  it('defaultOpen：初始即为展开态', () => {
    render(
      <MobileFilterStrip summary="摘要" controls={shortControls} defaultOpen />
    )
    expect(screen.getByTestId('mobile-filter-strip-grid')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '切换页面筛选' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('宽控件（MobileFilterWide）col-span-2 占整行', () => {
    render(
      <MobileFilterStrip
        summary="摘要"
        controls={
          <>
            <span>项目筛选</span>
            <MobileFilterWide>
              <span>日期范围</span>
            </MobileFilterWide>
          </>
        }
        defaultOpen
      />
    )

    const grid = screen.getByTestId('mobile-filter-strip-grid')
    // 短控件直接是 grid 子元素，宽控件被 MobileFilterWide 包裹且 col-span-2
    const wide = screen.getByTestId('mobile-filter-wide')
    expect(wide).toHaveClass('col-span-2')
    // 宽控件位于 grid 内、短控件之后
    expect(grid).toContainElement(wide)
    expect(grid.compareDocumentPosition(wide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('触控目标 ≥44px（规则 5）', () => {
    render(
      <MobileFilterStrip summary="摘要" controls={shortControls} />
    )
    expect(screen.getByRole('button', { name: '切换页面筛选' })).toHaveClass('min-h-[44px]')
  })

  it('Terminal 终端风格：零圆角 / term 面板 / 1px 边框', () => {
    render(
      <MobileFilterStrip summary="摘要" controls={shortControls} defaultOpen />
    )
    const strip = screen.getByTestId('mobile-filter-strip')
    expect(strip).toHaveClass('bg-term-panel')
    expect(strip).toHaveClass('border-b')
    expect(strip).toHaveClass('border-term-border')
    // 展开态网格带边框分隔
    const grid = screen.getByTestId('mobile-filter-strip-grid')
    expect(grid).toHaveClass('border-t')
  })

  it('Warm Ledger 风格：使用 warm-ledger 色彩与表面令牌，不混入 term 类', () => {
    render(
      <MobileFilterStrip
        summary="摘要"
        controls={shortControls}
        variant="warm-ledger"
        defaultOpen
      />
    )
    const strip = screen.getByTestId('mobile-filter-strip')
    expect(strip).toHaveAttribute('data-variant', 'warm-ledger')
    expect(strip.className).not.toContain('bg-term-panel')
    expect(strip.className).not.toContain('border-term-border')
    expect(strip.className).toContain('bg-[var(--warm-ledger-color-panel)]')
    expect(strip.className).toContain('border-[var(--warm-ledger-color-hairline)]')

    const button = screen.getByRole('button', { name: '切换页面筛选' })
    expect(button.className).not.toContain('text-term-text')
    expect(button.className).not.toContain('hover:bg-term-hover')
    expect(button.className).toContain('text-[var(--warm-ledger-color-text)]')

    const grid = screen.getByTestId('mobile-filter-strip-grid')
    expect(grid.className).not.toContain('border-term-border')
    expect(grid.className).toContain('border-[var(--warm-ledger-color-hairline)]')
    expect(grid.className).toContain('bg-[var(--warm-ledger-color-window)]')
  })
})
