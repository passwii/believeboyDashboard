import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import {
  AgentTablePageLoading,
  AnalyticsContentLoading,
  AnalyticsPageLoading,
  CardListSkeleton,
  ChatPageLoading,
  CrmDashboardPageLoading,
  CrmProposalDetailPageLoading,
  CrmTaskBoardPageLoading,
  InventoryLedgerPageLoading,
  InventoryReplenishmentPageLoading,
  MonthlyReportGeneratePageLoading,
  OperationsNavigationPageLoading,
  PlatformInspectionPageLoading,
  ProjectGoalsPageLoading,
  ProjectLaunchPageLoading,
  ShipmentManagementPageLoading,
  ShippingPlanPageLoading,
  SkuInfoPageLoading,
  WorkflowTemplateEditorPageLoading,
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
  it('共享骨架使用 busy 区域和独立的非打断加载播报', () => {
    const { container } = render(<TablePageLoading />)
    const region = container.firstElementChild

    expect(region).toHaveAttribute('aria-busy', 'true')
    expect(region).not.toHaveAttribute('aria-label')
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('页面加载中')
  })

  it('TablePageLoading 渲染 标题/过滤器/表格 三段且标记 aria-busy', () => {
    render(<TablePageLoading />)
    expect(screen.getByTestId('page-skeleton-header')).toBeDefined()
    expect(screen.getByTestId('page-skeleton-filters')).toBeDefined()
    expect(screen.getByTestId('page-skeleton-table')).toBeDefined()
    expect(screen.getByRole('status')).toHaveTextContent('页面加载中')
  })

  it('AnalyticsPageLoading 额外渲染 KPI 行与图表占位', () => {
    render(<AnalyticsPageLoading />)
    expect(screen.getByTestId('page-skeleton-kpis')).toBeDefined()
    expect(screen.getByTestId('page-skeleton-chart')).toBeDefined()
    expect(screen.getByTestId('page-skeleton-table')).toBeDefined()
  })

  it('AnalyticsContentLoading 不含页头（供布局层 Suspense fallback 复用）', () => {
    render(<AnalyticsContentLoading />)
    expect(screen.queryByTestId('page-skeleton-header')).toBeNull()
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

  it('CRM 任务骨架按工具条和三列看板占位，不伪装成表格', () => {
    render(<CrmTaskBoardPageLoading />)
    expect(screen.getByTestId('page-skeleton-task-toolbar')).toBeInTheDocument()
    expect(screen.getByTestId('page-skeleton-task-columns').children).toHaveLength(3)
    expect(screen.queryByTestId('page-skeleton-table')).toBeNull()
  })

  it('CRM 客户方案详情骨架按左栏信息/版本链、右栏大预览占位', () => {
    render(<CrmProposalDetailPageLoading />)
    const root = screen.getByTestId('page-skeleton-proposal-detail')
    expect(root).toBeInTheDocument()
    // 左栏信息面板 + 左栏版本链 + 右栏预览（右栏跨两行）+ sr-only 状态文案
    expect(root.children).toHaveLength(4)
    expect(root).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('页面加载中')
  })

  it('CRM dashboard 骨架包含四个 KPI、漏斗和负责人表', () => {
    render(<CrmDashboardPageLoading />)
    expect(screen.getByTestId('page-skeleton-kpis').children).toHaveLength(4)
    expect(screen.getByTestId('page-skeleton-crm-funnel')).toBeInTheDocument()
    expect(screen.getByTestId('page-skeleton-crm-lifecycle')).toBeInTheDocument()
  })

  it.each([
    ['库存分类账', InventoryLedgerPageLoading, 'page-skeleton-inventory-ledger'],
    ['项目启动台', ProjectLaunchPageLoading, 'page-skeleton-project-launch'],
    ['模板编辑器', WorkflowTemplateEditorPageLoading, 'page-skeleton-workflow-editor'],
    ['站点导航', OperationsNavigationPageLoading, 'page-skeleton-operations-navigation'],
    ['发货规划', ShippingPlanPageLoading, 'page-skeleton-shipping-plan'],
    ['补货 cockpit', InventoryReplenishmentPageLoading, 'page-skeleton-inventory-replenishment'],
    ['巡检工作区', PlatformInspectionPageLoading, 'page-skeleton-platform-inspection'],
    ['项目目标', ProjectGoalsPageLoading, 'page-skeleton-project-goals'],
    ['船期管理', ShipmentManagementPageLoading, 'page-skeleton-shipment-management'],
    ['SKU 管理', SkuInfoPageLoading, 'page-skeleton-sku-info'],
    ['月报生成', MonthlyReportGeneratePageLoading, 'page-skeleton-monthly-report-generate'],
  ])('%s 路由骨架保留页面专属区域', (_, PageLoading, testId) => {
    const { container } = render(<PageLoading />)
    const region = container.querySelector('[aria-busy="true"]')
    expect(screen.getByTestId(testId as string)).toBeInTheDocument()
    expect(region).toBeInTheDocument()
    expect(region).not.toHaveAttribute('aria-label')
    expect(screen.getByRole('status')).toHaveTextContent('页面加载中')
  })

  it('Agent 活动矩阵按 8/11 列参数生成表格宽骨架', () => {
    const { rerender } = render(<AgentTablePageLoading columns={8} />)
    expect(screen.getByTestId('page-skeleton-wide-table')).toBeInTheDocument()
    rerender(<AgentTablePageLoading columns={11} />)
    expect(screen.getByTestId('page-skeleton-wide-table').querySelector('[style*="repeat(11,"]')).toBeInTheDocument()
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

  it('客户方案详情路由注册专用 loading boundary', () => {
    const detailBoundary = join(dashboardDir, 'crm', 'proposals', '[id]', 'loading.tsx')
    expect(existsSync(detailBoundary)).toBe(true)
  })

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
