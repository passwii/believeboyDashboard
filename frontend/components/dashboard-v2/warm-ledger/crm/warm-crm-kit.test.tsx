import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  WarmCrmPage,
  WarmCrmRecordDrawer,
  WarmCrmSection,
  WarmCrmState,
  WarmCrmStatusPill,
  WarmCrmTableFrame,
  WarmCrmTableScroller,
  WarmCrmToolbar,
} from './index'

describe('Warm CRM page primitives', () => {
  it('renders the page as a desktop flex frame without a duplicate page title', () => {
    const { container } = render(
      <WarmCrmPage>
        <div>客户内容</div>
      </WarmCrmPage>
    )

    const page = container.querySelector('[data-warm-crm-page]')
    expect(page).toBeInTheDocument()
    expect(page).toHaveTextContent('客户内容')
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('labels a titled section and keeps its action in the header', () => {
    render(
      <WarmCrmSection title="本月新增" actions={<button type="button">查看</button>}>
        <p>128</p>
      </WarmCrmSection>
    )

    const section = screen.getByRole('region', { name: '本月新增' })
    expect(screen.getByRole('heading', { name: '本月新增' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看' })).toBeInTheDocument()
    expect(section).toHaveTextContent('128')
  })

  it('keeps toolbar slots in their supplied start and end order', () => {
    render(
      <WarmCrmToolbar
        ariaLabel="客户工具栏"
        start={<span>筛选</span>}
        end={<button type="button">新建客户</button>}
      />
    )

    const toolbar = screen.getByRole('group', { name: '客户工具栏' })
    expect(toolbar).toHaveTextContent('筛选新建客户')
    expect(screen.getByRole('button', { name: '新建客户' })).toBeInTheDocument()
  })
})

describe('Warm CRM table primitives', () => {
  it('keeps the table in a named keyboard-scrollable region inside its panel', () => {
    render(
      <WarmCrmTableFrame footer={<span>共 12 条</span>}>
        <WarmCrmTableScroller ariaLabel="客户表格">
          <table>
            <thead>
              <tr>
                <th>客户</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>青山贸易</td>
              </tr>
            </tbody>
          </table>
        </WarmCrmTableScroller>
      </WarmCrmTableFrame>
    )

    const frame = screen.getByText('青山贸易').closest('[data-warm-crm-table-frame]')
    const scroller = screen.getByRole('region', { name: '客户表格' })

    expect(frame).toContainElement(scroller)
    expect(frame).toHaveTextContent('共 12 条')
    expect(scroller).toHaveAttribute('tabindex', '0')
    expect(scroller).toHaveAttribute('data-table-scroll')
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('marks rows interactive only when requested', () => {
    const { rerender } = render(
      <WarmCrmTableScroller ariaLabel="客户表格">
        <table>
          <tbody>
            <tr>
              <td>青山贸易</td>
            </tr>
          </tbody>
        </table>
      </WarmCrmTableScroller>
    )

    expect(screen.getByRole('region', { name: '客户表格' })).not.toHaveAttribute(
      'data-interactive-rows'
    )

    rerender(
      <WarmCrmTableScroller ariaLabel="客户表格" interactiveRows>
        <table>
          <tbody>
            <tr>
              <td>青山贸易</td>
            </tr>
          </tbody>
        </table>
      </WarmCrmTableScroller>
    )

    expect(screen.getByRole('region', { name: '客户表格' })).toHaveAttribute(
      'data-interactive-rows',
      'true'
    )
  })
})

describe('WarmCrmRecordDrawer', () => {
  it('composes a required accessible title with actions, body, and footer', () => {
    render(
      <WarmCrmRecordDrawer
        open
        onOpenChange={vi.fn()}
        title="青山贸易"
        actions={<button type="button">编辑</button>}
        footer={<span>最后更新 10:30</span>}
      >
        <p>客户详情</p>
      </WarmCrmRecordDrawer>
    )

    const dialog = screen.getByRole('dialog', { name: '青山贸易' })
    expect(dialog).toHaveTextContent('客户详情')
    expect(dialog).toHaveTextContent('最后更新 10:30')
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument()
  })

  it('reports close requests through onOpenChange', () => {
    const onOpenChange = vi.fn()

    render(
      <WarmCrmRecordDrawer open onOpenChange={onOpenChange} title="青山贸易">
        <p>客户详情</p>
      </WarmCrmRecordDrawer>
    )

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('Warm CRM status and state helpers', () => {
  it('renders caller-owned status copy with the Warm semantic tone', () => {
    render(<WarmCrmStatusPill tone="positive">已转化</WarmCrmStatusPill>)

    const status = screen.getByText('已转化')
    expect(status).toHaveAttribute('data-tone', 'positive')
    expect(status).toHaveAttribute('data-warm-crm-status-pill')
  })

  it('exposes loading as a busy status without default copy', () => {
    render(
      <WarmCrmState
        kind="loading"
        title="正在读取客户"
        detail="当前筛选范围"
        action={<button type="button">取消</button>}
      />
    )

    const state = screen.getByRole('status')
    expect(state).toHaveAttribute('aria-busy', 'true')
    expect(state).toHaveTextContent('正在读取客户')
    expect(state).toHaveTextContent('当前筛选范围')
    expect(state.querySelectorAll('[data-warm-crm-state-skeleton]')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
  })

  it('separates empty status from an actionable error alert', () => {
    const { rerender } = render(
      <WarmCrmState kind="empty" title="当前没有客户" />
    )

    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'empty')

    const onRetry = vi.fn()
    rerender(
      <WarmCrmState
        kind="error"
        title="客户加载失败"
        detail="请稍后重试"
        action={<button type="button" onClick={onRetry}>重试</button>}
      />
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveAttribute('data-state', 'error')
    expect(alert).toHaveTextContent('客户加载失败')
    expect(alert).toHaveTextContent('请稍后重试')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('Warm CRM design contract', () => {
  it('uses Warm Ledger tokens only and adds no responsive page adaptation', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'components/dashboard-v2/warm-ledger/crm/warm-crm-kit.module.css'),
      'utf8'
    )

    expect(css).toContain('--warm-ledger-')
    expect(css).not.toContain('--term-')
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)/)
    expect(css).toMatch(/\.tableScroller\s*\{[^}]*overflow(?:-x)?:\s*auto/s)
  })
})
