import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { stableSession } from '@/test-utils/stable-mocks'
import {
  getWarmLedgerRouteMeta,
  getWarmLedgerPageTitle,
  isWarmLedgerRoute,
} from '@/components/dashboard-v2/warm-ledger/shell/warm-ledger-route-frame'

let mockPathname = '/dashboard'
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))
vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { name: 't' } }),
  signOut: vi.fn(),
}))

vi.mock('@/components/notifications/server-notifications-context', () => ({
  ServerNotificationsProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="notifications-provider">{children}</div>
  ),
}))
vi.mock('@/components/terminal/terminal-shell', () => ({
  TerminalShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="terminal-shell">{children}</div>
  ),
}))
vi.mock('@/components/dashboard/search-command', () => ({
  SearchCommand: () => <div data-testid="search-command" />,
}))

import DashboardLayout from './layout'

const WARM_ROUTE_CASES = [
  ['/dashboard/operations/daily-analysis', '销售数据', '运营'],
  ['/dashboard/operations/portfolio-overview', '组合分析', '运营'],
  ['/dashboard/operations/inventory-analysis', '库存分析', '运营'],
  ['/dashboard/operations/inventory-ledger', '库存分类账', '运营'],
  ['/dashboard/operations/shipping-plan', '发货规划', '运营'],
  ['/dashboard/operations/shipment-management', '货件管理', '运营'],
  ['/dashboard/operations/sku-info', 'SKU 信息中心', '运营'],
  ['/dashboard/reports/order-info', '订单信息', '报表中心'],
  ['/dashboard/reports/product-analysis', '产品分析', '报表中心'],
  ['/dashboard/reports/monthly-report/display', '财务月报', '报表中心'],
  ['/dashboard/finance/platform-revenue', '平台回款', '财务资金'],
  ['/dashboard/finance/exchange-rate', '汇率信息', '财务资金'],
  ['/dashboard/finance/vat-invoice', 'VAT 发票', '财务资金'],
  ['/dashboard/finance/commission-management', '佣金管理', '财务资金'],
  ['/dashboard/crm/dashboard', '数据看板', 'CRM 客户与合作伙伴'],
  ['/dashboard/crm/follow-ups', '待跟进', 'CRM 客户与合作伙伴'],
  ['/dashboard/crm/customers', '客户', 'CRM 客户与合作伙伴'],
  ['/dashboard/crm/sea', '客户公海', 'CRM 客户与合作伙伴'],
  ['/dashboard/crm/proposals', '客户方案', 'CRM 客户与合作伙伴'],
  ['/dashboard/crm/proposals/42', '客户方案详情', 'CRM 客户与合作伙伴'],
  ['/dashboard/crm/leads', '线索', 'CRM 客户与合作伙伴'],
  ['/dashboard/crm/tasks', '任务', 'CRM 客户与合作伙伴'],
  ['/dashboard/crm/audit', '操作日志', 'CRM 客户与合作伙伴'],
  ['/dashboard/crm/settings', 'CRM 设置', 'CRM 客户与合作伙伴'],
  ['/dashboard/ai/insights', 'AI洞察', 'AI 智能'],
  ['/dashboard/ai/ad-analysis', 'AI 广告分析', 'AI 智能'],
  ['/dashboard/ai/inventory-health', 'AI 库存健康', 'AI 智能'],
  ['/dashboard/ai/believeboy-models', '模型选型', 'AI 智能'],
  ['/dashboard/ai/customer-service', '客服交流', 'AI 智能'],
  ['/dashboard/ai/digital-employees', '数字员工', 'AI 智能'],
  ['/dashboard/ai/digital-employees/employee-7', '数字员工详情', 'AI 智能'],
  ['/dashboard/ai/digital-employees/office', '虚拟办公室', 'AI 智能'],
  ['/dashboard/tools/markdown-to-word', 'Markdown 转 Word', '工具箱'],
  ['/dashboard/tools/page-render', 'Markdown / HTML 渲染', '工具箱'],
  ['/dashboard/tools/brand-registration-example', '品牌备案示例', '工具箱'],
  ['/dashboard/tools/product-label', '产品标签制作', '工具箱'],
  ['/dashboard/tools/cross-border-compliance', '跨境电商合规', '工具箱'],
  ['/dashboard/system/account-management', '系统账号管理', '系统管理'],
  ['/dashboard/system/agent-management', 'Agent 接入管理', '系统管理'],
  ['/dashboard/system/alerts', '告警中心', '系统管理'],
  ['/dashboard/system/changelog', '更新日志', '系统管理'],
  ['/dashboard/system/data-management', '数据库状态', '系统管理'],
  ['/dashboard/system/logs', '日志查看', '系统管理'],
  ['/dashboard/system/operator-management', '运营管理', '系统管理'],
  ['/dashboard/system/project-info', '项目信息', '系统管理'],
] as const

describe('DashboardLayout shell routing', () => {
  beforeEach(() => {
    mockPathname = '/dashboard'
  })

  it('bypasses TerminalShell only for the exact /dashboard route', () => {
    render(
      <DashboardLayout>
        <div data-testid="child">real child</div>
      </DashboardLayout>,
    )

    expect(screen.getByTestId('notifications-provider')).toBeInTheDocument()
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.queryByTestId('terminal-shell')).not.toBeInTheDocument()
    expect(screen.getByTestId('search-command')).toBeInTheDocument()
    expect(document.title).toContain('运营总览与关键数据面板')
  })

  it('keeps TerminalShell mounted for every nested Dashboard route', () => {
    mockPathname = '/dashboard/ai/chat'
    render(
      <DashboardLayout>
        <div data-testid="child">real child</div>
      </DashboardLayout>,
    )

    expect(screen.getByTestId('terminal-shell')).toBeInTheDocument()
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.queryByTestId('search-command')).not.toBeInTheDocument()
  })

  it('warms only the three exact C3 report routes and uses their sidebar titles', () => {
    const routes = [
      ['/dashboard/reports/order-info', '订单信息'],
      ['/dashboard/reports/product-analysis', '产品分析'],
      ['/dashboard/reports/monthly-report/display', '财务月报'],
    ] as const

    for (const [pathname, title] of routes) {
      expect(isWarmLedgerRoute(pathname)).toBe(true)
      expect(getWarmLedgerPageTitle(pathname)).toBe(title)
    }
  })

  it('keeps adjacent and nested report routes outside Warm Ledger', () => {
    const nonWarmReportRoutes = [
      '/dashboard/reports',
      '/dashboard/reports/order-info/history',
      '/dashboard/reports/product-analysis/archive',
      '/dashboard/reports/monthly-report/display/export',
      '/dashboard/reports/monthly-report/generate',
      '/dashboard/reports/monthly-report/reconcile',
      '/dashboard/reports/scheduled-reports',
    ]

    for (const pathname of nonWarmReportRoutes) {
      expect(isWarmLedgerRoute(pathname)).toBe(false)
    }
  })

  it('classifies every approved warm route with its exact title and section', () => {
    for (const [pathname, title, section] of WARM_ROUTE_CASES) {
      expect(isWarmLedgerRoute(pathname)).toBe(true)
      expect(getWarmLedgerPageTitle(pathname)).toBe(title)
      expect(getWarmLedgerRouteMeta(pathname)).toMatchObject({
        title,
        sectionLabel: section,
      })
    }
  })

  it('keeps redirects, visual exceptions, public pages, and nested neighbors outside Warm', () => {
    const outsideWarm = [
      '/dashboard/finance/vat-invoices',
      '/dashboard/crm',
      '/dashboard/crm/workbench',
      '/dashboard/ai',
      '/dashboard/ai/chat',
      '/dashboard/system/digital-display',
      '/p/public-page-id',
      '/dashboard/finance/platform-revenue/history',
      '/dashboard/crm/proposals/42/versions',
      '/dashboard/ai/digital-employees/employee-7/chat',
      '/dashboard/ai/digital-employees/office/presentation',
      '/dashboard/tools/page-render/preview',
    ]

    for (const pathname of outsideWarm) {
      expect(isWarmLedgerRoute(pathname)).toBe(false)
    }
  })

  it('maps detail routes to the matching parent navigation item', () => {
    expect(getWarmLedgerRouteMeta('/dashboard/crm/sea')).toMatchObject({
      navHref: '/dashboard/crm/customers',
    })
    expect(getWarmLedgerRouteMeta('/dashboard/crm/proposals/42')).toMatchObject({
      navHref: '/dashboard/crm/proposals',
    })
    expect(getWarmLedgerRouteMeta('/dashboard/ai/digital-employees/employee-7')).toMatchObject({
      navHref: '/dashboard/ai/digital-employees',
    })
    expect(getWarmLedgerRouteMeta('/dashboard/ai/digital-employees/office')).toMatchObject({
      navHref: '/dashboard/ai/digital-employees/office',
    })
  })
})
