import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PageHeader } from './page-header'

describe('PageHeader', () => {
  it('pill 形态：渲染 eyebrow + 描述 + 右侧 actions', () => {
    const { container } = render(
      <PageHeader
        eyebrow={
          <>
            <span data-testid="eyebrow-icon" />
            运营导航 · 站点导航
          </>
        }
        description="聚合主流跨境电商平台与运营入口"
        actions={<button type="button">操作</button>}
      />
    )
    expect(screen.getByText('运营导航 · 站点导航')).toBeInTheDocument()
    expect(screen.getByText('聚合主流跨境电商平台与运营入口')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '操作' })).toBeInTheDocument()
    // BLF-873：eyebrow 收口为 term 原子标签（零圆角 + mono + term 边框/底）
    const pill = container.querySelector('p')
    expect(pill?.className).toContain('rounded-none')
    expect(pill?.className).toContain('border-term-border')
    expect(pill?.className).toContain('bg-term-raised')
    expect(pill?.className).toContain('font-mono')
  })

  it('kicker 形态：渲染 dashboard-kicker 小标 + 标题', () => {
    const { container } = render(<PageHeader kicker="操作台账" title="库存明细表" />)
    expect(screen.getByText('操作台账')).toBeInTheDocument()
    expect(screen.getByText('库存明细表')).toBeInTheDocument()
    expect(container.querySelector('p')?.className).toContain('dashboard-kicker')
  })

  it('标题用 h1（走 --font-display）', () => {
    render(<PageHeader title="站点导航" />)
    expect(screen.getByRole('heading', { level: 1, name: '站点导航' })).toBeInTheDocument()
  })

  it('无 eyebrow/kicker/actions 时只渲染给定内容，不产生空节点', () => {
    const { container } = render(<PageHeader title="仅标题" />)
    expect(container.querySelectorAll('p').length).toBe(0)
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })

  it('header 采用 §4.1 页面级头部布局（flex 两端对齐）', () => {
    const { container } = render(<PageHeader title="标题" actions={<button type="button">x</button>} />)
    const header = container.querySelector('header')
    expect(header?.className).toContain('flex')
    expect(header?.className).toContain('justify-between')
  })

  it('BLF-873：标题/描述走 term 色阶，操作区间距对齐终端密度', () => {
    const { container } = render(
      <PageHeader title="标题" description="描述" actions={<button type="button">x</button>} />
    )
    expect(container.querySelector('h1')?.className).toContain('text-term-text')
    const description = Array.from(container.querySelectorAll('p')).find((p) =>
      p.className.includes('text-term-muted')
    )
    expect(description).toBeTruthy()
    const actions = container.querySelector('header > div:last-child')
    expect(actions?.className).toContain('gap-2')
  })
})
