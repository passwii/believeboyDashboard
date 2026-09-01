import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TrendingUp } from 'lucide-react'

import { ChartCard } from './chart-card'

describe('ChartCard', () => {
  it('渲染表头：icon + 标题 + 描述 + delta 徽章', () => {
    render(
      <ChartCard
        icon={<TrendingUp data-testid="icon" />}
        title="销售额"
        description="近 7 天"
        delta={{ value: 12.5 }}
      >
        <div>图表内容</div>
      </ChartCard>
    )
    expect(screen.getByText('销售额')).toBeInTheDocument()
    expect(screen.getByText('近 7 天')).toBeInTheDocument()
    expect(screen.getByTestId('icon')).toBeInTheDocument()
    // delta 徽章：+12.5%
    expect(screen.getByText('12.5%')).toBeInTheDocument()
    expect(screen.getByText('图表内容')).toBeInTheDocument()
  })

  it('渲染 actions 与 footer 插槽', () => {
    render(
      <ChartCard title="项目排行" actions={<button>销售额</button>} footer={<span>共 6 项</span>}>
        <div>内容</div>
      </ChartCard>
    )
    expect(screen.getByRole('button', { name: '销售额' })).toBeInTheDocument()
    expect(screen.getByText('共 6 项')).toBeInTheDocument()
  })

  it('loading 时渲染骨架而非内容', () => {
    render(
      <ChartCard title="库存" loading>
        <div>不应出现</div>
      </ChartCard>
    )
    expect(screen.queryByText('不应出现')).not.toBeInTheDocument()
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  })

  it('empty 时渲染空态文案', () => {
    render(
      <ChartCard title="国家" empty emptyText="暂无国家数据">
        <div>不应出现</div>
      </ChartCard>
    )
    expect(screen.getByText('暂无国家数据')).toBeInTheDocument()
    expect(screen.queryByText('不应出现')).not.toBeInTheDocument()
  })

  it('loading 与 empty 同时为真时渲染骨架（loading 优先）', () => {
    render(
      <ChartCard title="加载中" loading empty emptyText="暂无数据">
        <div>不应出现</div>
      </ChartCard>
    )
    // loading 优先 → 显示骨架，非空态文案
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.queryByText('暂无数据')).not.toBeInTheDocument()
    expect(screen.queryByText('不应出现')).not.toBeInTheDocument()
  })

  it('className 透传（col-span 等布局）', () => {
    const { container } = render(<ChartCard title="测试" className="col-span-2"><div /></ChartCard>)
    expect(container.firstElementChild?.className).toContain('col-span-2')
  })
})
