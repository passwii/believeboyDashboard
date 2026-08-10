import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StatCard, StatCardRow } from './stat-card'

describe('StatCard 涨跌（Delta 原语）', () => {
  it('正值：渲染箭头 + 绝对值百分比 + 默认标签「较上期」', () => {
    render(<StatCard title="销售额" value="$1,200" icon={<span />} color="emerald" trend={12.34} />)
    expect(screen.getByText('销售额')).toBeInTheDocument()
    expect(screen.getByText('$1,200')).toBeInTheDocument()
    expect(screen.getByText('12.3%')).toBeInTheDocument()
    expect(screen.getByText('较上期')).toBeInTheDocument()
  })

  it('负值：百分比取绝对值渲染', () => {
    render(<StatCard title="广告花费" value="$80" icon={<span />} color="rose" trend={-5.67} />)
    expect(screen.getByText('5.7%')).toBeInTheDocument()
  })

  it('trend 未传时不渲染涨跌行', () => {
    const { container } = render(
      <StatCard title="订单量" value="40" icon={<span />} color="sky" />
    )
    expect(screen.queryByText('较上期')).not.toBeInTheDocument()
    expect(container.querySelector('[data-slot="delta"]')).toBeNull()
  })

  it('自定义 trendLabel 覆盖默认', () => {
    render(
      <StatCard
        title="转化率"
        value="5%"
        icon={<span />}
        color="amber"
        trend={2}
        trendLabel="较上周"
      />
    )
    expect(screen.getByText('较上周')).toBeInTheDocument()
  })
})

describe('StatCardRow', () => {
  it('渲染响应式指标卡行栅格（2/3/4/5 列）', () => {
    const { container } = render(
      <StatCardRow>
        <div>卡1</div>
        <div>卡2</div>
      </StatCardRow>
    )
    const grid = container.querySelector('.grid')
    expect(grid?.className).toContain('grid-cols-2')
    expect(grid?.className).toContain('sm:grid-cols-3')
    expect(grid?.className).toContain('md:grid-cols-4')
    expect(grid?.className).toContain('xl:grid-cols-5')
  })

  it('可覆盖 className', () => {
    const { container } = render(<StatCardRow className="gap-2">内容</StatCardRow>)
    expect(container.querySelector('.grid')?.className).toContain('gap-2')
  })
})

describe('StatCard 暗黑双环卡片契约（BLF-574）', () => {
  it('走 dashboard-surface（暗黑继承 --shadow-level-2 双环）+ hover-lift（暗黑 hover 配对阴影）', () => {
    const { container } = render(<StatCard title="销售额" value="$1" icon={<span />} color="emerald" />)
    const card = container.querySelector('.dashboard-surface')!
    expect(card.className).toContain('dashboard-surface')
    expect(card.className).toContain('hover-lift')
    expect(card.className).toContain('border-emerald-500/20')
  })
})
