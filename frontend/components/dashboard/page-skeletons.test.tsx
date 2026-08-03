import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import {
  AnalyticsPageLoading,
  CardListSkeleton,
  ChatPageLoading,
  DataTableSkeleton,
  FilterBarSkeleton,
  KpiCardsSkeleton,
  SimplePageLoading,
  TablePageLoading,
} from '@/components/dashboard/page-skeletons'

describe('page-skeletons 原子组件', () => {
  it('FilterBarSkeleton 按 count 渲染过滤器占位', () => {
    const { container } = render(<FilterBarSkeleton count={5} />)
    const bar = screen.getByTestId('page-skeleton-filters')
    expect(bar).toBeDefined()
    // count 个过滤器 + 1 个右侧操作按钮
    expect(container.querySelectorAll('.u-skeleton-shimmer')).toHaveLength(6)
  })

  it('KpiCardsSkeleton 按 count 渲染 KPI 卡片', () => {
    render(<KpiCardsSkeleton count={3} />)
    const kpis = screen.getByTestId('page-skeleton-kpis')
    expect(kpis.children).toHaveLength(3)
  })

  it('CardListSkeleton 按 count 渲染卡片', () => {
    render(<CardListSkeleton count={2} />)
    const cards = screen.getByTestId('page-skeleton-cards')
    expect(cards.children).toHaveLength(2)
  })

  it('DataTableSkeleton 按 rows 渲染数据行并支持关闭工具条', () => {
    const { container, rerender } = render(<DataTableSkeleton rows={4} toolbar={false} />)
    expect(screen.getByTestId('page-skeleton-table')).toBeDefined()
    // 工具条标题占位（h-4 w-32）仅在 toolbar=true 时出现
    expect(container.querySelector('.h-4.w-32')).toBeNull()
    rerender(<DataTableSkeleton rows={4} toolbar />)
    expect(container.querySelector('.h-4.w-32')).not.toBeNull()
  })
})

describe('page-skeletons 组合骨架', () => {
  it('TablePageLoading 渲染 标题/过滤器/表格 三段且标记 aria-busy', () => {
    render(<TablePageLoading />)
    expect(screen.getByTestId('page-skeleton-header')).toBeDefined()
    expect(screen.getByTestId('page-skeleton-filters')).toBeDefined()
    expect(screen.getByTestId('page-skeleton-table')).toBeDefined()
    expect(screen.getByLabelText('页面加载中')).toBeDefined()
  })

  it('AnalyticsPageLoading 额外渲染 KPI 行与图表占位', () => {
    render(<AnalyticsPageLoading />)
    expect(screen.getByTestId('page-skeleton-kpis')).toBeDefined()
    expect(screen.getByTestId('page-skeleton-chart')).toBeDefined()
    expect(screen.getByTestId('page-skeleton-table')).toBeDefined()
  })

  it('SimplePageLoading 渲染 标题 + 卡片网格', () => {
    render(<SimplePageLoading />)
    expect(screen.getByTestId('page-skeleton-header')).toBeDefined()
    expect(screen.getByTestId('page-skeleton-cards')).toBeDefined()
  })

  it('ChatPageLoading 渲染会话气泡与输入区', () => {
    render(<ChatPageLoading />)
    expect(screen.getByTestId('page-skeleton-chat')).toBeDefined()
  })
})

describe('BEL-419 路由骨架覆盖', () => {
  const dashboardDir = join(process.cwd(), 'app', 'dashboard')

  function containsPage(dir: string): boolean {
    if (existsSync(join(dir, 'page.tsx'))) return true
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory() && containsPage(full)) return true
    }
    return false
  }

  it('dashboard 下每个含页面的 section 都有自己的 loading.tsx（不依赖首页骨架兜底）', () => {
    const sections = readdirSync(dashboardDir)
      .map((entry) => join(dashboardDir, entry))
      .filter((full) => statSync(full).isDirectory() && containsPage(full))
    expect(sections.length).toBeGreaterThanOrEqual(10) // 防止扫描路径失效导致假绿
    const uncovered = sections
      .filter((dir) => !existsSync(join(dir, 'loading.tsx')))
      .map((dir) => dir.replace(`${process.cwd()}/app/dashboard/`, ''))
    expect(uncovered).toEqual([])
  })
})
