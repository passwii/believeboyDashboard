import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'

import TableShowcasePage from '@/app/dashboard/table-showcase/page'

// 冒烟：定稿后的 showcase 页（基线 + 变体 + 规范速览 + 差异表）在 jsdom 下可渲染，
// 防止 framer-motion / DataTableFrame 组合引入运行时崩溃。
describe('table-showcase 定稿页', () => {
  it('渲染规范速览、基线、变体与差异表', () => {
    const { container } = render(<TableShowcasePage />)
    expect(container.querySelector('[data-warm-page="table-showcase"]')).not.toBeNull()
    // 规范速览
    expect(screen.getByText('表格规范速览')).toBeInTheDocument()
    expect(screen.getByText('密度档位')).toBeInTheDocument()
    // 基线（高密度数据网格）
    expect(screen.getByText('基线 · 高密度数据网格（全站默认）')).toBeInTheDocument()
    // 变体 A / C
    expect(screen.getByText('宽松密度（cozy）· 展示型')).toBeInTheDocument()
    expect(screen.getByText('动效增强（行展开）· 占位')).toBeInTheDocument()
    // 方向差异表（section 标题 + 卡片标题各一处）
    expect(screen.getAllByText('方向差异表').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('适用场景')).toBeInTheDocument()
    // mock 数据渲染（基线表格行）
    expect(screen.getAllByText(/INV-\d{4}/).length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-warm-table-scroll]').length).toBeGreaterThanOrEqual(4)
    expect(
      container.querySelectorAll('[data-warm-table-scroll][data-limited="true"]')
    ).toHaveLength(2)
  })

  it('生产源与样式不再引用 Terminal 或方角装饰', () => {
    const source = readFileSync('app/dashboard/table-showcase/page.tsx', 'utf8')
    const css = readFileSync(
      'app/dashboard/table-showcase/table-showcase-warm.module.css',
      'utf8'
    )
    expect(source).not.toMatch(/TermPanel|TermPill|term-|rounded-none/)
    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).toContain('.searchField:focus-within')
    expect(css).not.toMatch(/term-|rounded-none/)
  })

  it('保留基线排序、多选与行展开交互', async () => {
    const user = userEvent.setup()
    render(<TableShowcasePage />)

    const amountSort = screen.getByRole('button', { name: '金额' })
    const baselineTable = amountSort.closest('table')
    expect(baselineTable).not.toBeNull()
    const invoiceOrder = () =>
      Array.from(baselineTable!.querySelectorAll('tbody tr')).map(
        (row) => row.querySelector('td:nth-child(2)')?.textContent ?? ''
      )
    const beforeSort = invoiceOrder()
    await user.click(amountSort)
    expect(invoiceOrder()).not.toEqual(beforeSort)

    const choose = screen.getByRole('checkbox', { name: '选择 INV-2041' })
    await user.click(choose)
    expect(choose).toBeChecked()

    const targetRow = screen
      .getAllByText('INV-2043')
      .map((node) => node.closest('tr'))
      .find((row) => row?.hasAttribute('data-open'))
    expect(targetRow).not.toBeNull()
    await user.click(targetRow as HTMLTableRowElement)
    expect(screen.getByText('账户余额不足，已发起二次扣款。')).toBeInTheDocument()
  })
})
