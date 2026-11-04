export const DASHBOARD_PAGE_TITLES: Array<{ match: string; title: string }> = [
  { match: '/reports/monthly-report', title: '财务月报' },
  { match: '/reports/product-analysis', title: '产品分析' },
  { match: '/reports/pricing-calculation/shop-calculation', title: '店铺测算' },
  { match: '/reports/pricing-calculation', title: '定价核算' },
  { match: '/operations/daily-analysis', title: '销售数据' },
  { match: '/operations/return-analysis', title: '退货分析' },
  { match: '/advertising/ad-analysis', title: '广告分析' },
  { match: '/operations/weekly-product-analysis', title: '按周产品分析' },
  { match: '/operations/inventory-analysis', title: '库存分析' },
  { match: '/operations/inventory-replenishment', title: '补货分析' },
  { match: '/operations/seasonal-replenishment', title: '季节性补货分析' },
  { match: '/operations/shipping-plan', title: '发货规划' },
  { match: '/operations/project-launch/templates', title: '流程模板管理' },
  { match: '/operations/project-launch', title: '项目启动台' },
  { match: '/operations/project-goals', title: '目标管理' },
  { match: '/reports/report-upload', title: '报表上传' },
  { match: '/operations/shipment-management', title: '货件管理' },
  { match: '/reports/order-info', title: '订单信息' },
  { match: '/operations/sku-info', title: 'SKU 信息中心' },
  { match: '/finance/exchange-rate', title: '汇率信息' },
  { match: '/system/project-info', title: '项目信息' },
  { match: '/system/data-management', title: '数据库状态' },
  { match: '/system/account-management', title: '系统账号管理' },
  { match: '/system/operator-management', title: '运营管理' },
  { match: '/system/agent-management', title: 'Agent 接入管理' },
  { match: '/finance/commission-management', title: '佣金管理' },
  { match: '/system/logs', title: '日志查看' },
  { match: '/reports/scheduled-reports', title: '定时报告' },
  { match: '/reports/auto-upload', title: '报表自动化' },
  { match: '/finance/vat-invoice', title: 'VAT 发票生成器' },
  { match: '/finance/platform-revenue', title: '平台回款' },
  { match: '/operations/platform-inspection', title: '平台巡检' },
  { match: '/operations/complaint-center', title: '客户消息' },
  { match: '/operations/review-tracking', title: '评论追踪' },
  { match: '/agent-center/overview', title: '数据流总览' },
  { match: '/agent-center/employees', title: 'Agent 员工' },
  { match: '/operations/site-navigation', title: '跨境平台书签导航' },
  { match: '/operations/store-navigation', title: '店铺导航' },
  { match: '/ai/insights', title: 'AI洞察' },
  { match: '/tools/markdown-to-word', title: 'Markdown 转 Word' },
  { match: '/tools/page-render', title: 'Markdown / HTML 渲染' },
  { match: '/tools/brand-registration-example', title: '品牌备案示例' },
  { match: '/tools/product-label', title: '产品标签制作' },
  { match: '/tools/cross-border-compliance', title: '跨境电商合规' },
  { match: '/ai/chat', title: 'AI Chat' },
  { match: '/ai/ad-analysis', title: 'AI 广告分析' },
  { match: '/ai/inventory-health', title: 'AI 库存健康' },
  { match: '/operations/research-analysis', title: '调研分析' },
  { match: '/change-password', title: '修改密码' },
  { match: '/profile', title: '个人中心' },
  { match: '/feature-updates', title: '产品更新' },
  { match: '/system/system/changelog', title: '更新日志' },
  { match: '/dashboard/crm/customers', title: '客户管理' },
  { match: '/dashboard/crm/proposals', title: '客户方案' },
  { match: '/dashboard/crm/leads', title: '线索管理' },
  { match: '/dashboard/crm/sea', title: '客户公海' },
  { match: '/dashboard/crm/settings', title: 'CRM 设置' },
  { match: '/dashboard/crm', title: 'CRM 业务' },
]

export type DashboardRouteMeta = {
  title: string
  sectionLabel?: string
  sectionHref?: string
  navHref?: string
  warm?: boolean
}

const OPERATIONS_SECTION = {
  sectionLabel: '运营',
  sectionHref: '/dashboard',
} as const
const REPORTS_SECTION = { sectionLabel: '报表中心' } as const
const FINANCE_SECTION = { sectionLabel: '财务资金' } as const
const CRM_SECTION = { sectionLabel: 'CRM 客户与合作伙伴' } as const
const AI_SECTION = { sectionLabel: 'AI 智能' } as const
const TOOLS_SECTION = { sectionLabel: '工具箱' } as const
const SYSTEM_SECTION = { sectionLabel: '系统管理' } as const

const WARM_LEDGER_EXACT_ROUTE_META: Record<string, DashboardRouteMeta> = {
  '/dashboard/operations/daily-analysis': {
    ...OPERATIONS_SECTION,
    title: '销售数据',
    warm: true,
  },
  '/dashboard/operations/portfolio-overview': {
    ...OPERATIONS_SECTION,
    title: '组合分析',
    warm: true,
  },
  '/dashboard/operations/inventory-analysis': {
    ...OPERATIONS_SECTION,
    title: '库存分析',
    warm: true,
  },
  '/dashboard/operations/inventory-ledger': {
    ...OPERATIONS_SECTION,
    title: '库存分类账',
    warm: true,
  },
  '/dashboard/operations/shipping-plan': {
    ...OPERATIONS_SECTION,
    title: '发货规划',
    warm: true,
  },
  '/dashboard/operations/shipment-management': {
    ...OPERATIONS_SECTION,
    title: '货件管理',
    warm: true,
  },
  '/dashboard/operations/sku-info': {
    ...OPERATIONS_SECTION,
    title: 'SKU 信息中心',
    warm: true,
  },
  '/dashboard/reports/order-info': {
    ...REPORTS_SECTION,
    title: '订单信息',
    warm: true,
  },
  '/dashboard/reports/product-analysis': {
    ...REPORTS_SECTION,
    title: '产品分析',
    warm: true,
  },
  '/dashboard/reports/monthly-report/display': {
    ...REPORTS_SECTION,
    title: '财务月报',
    warm: true,
  },
  '/dashboard/finance/platform-revenue': {
    ...FINANCE_SECTION,
    title: '平台回款',
    warm: true,
  },
  '/dashboard/finance/exchange-rate': {
    ...FINANCE_SECTION,
    title: '汇率信息',
    warm: true,
  },
  '/dashboard/finance/vat-invoice': {
    ...FINANCE_SECTION,
    title: 'VAT 发票',
    warm: true,
  },
  '/dashboard/finance/commission-management': {
    ...FINANCE_SECTION,
    title: '佣金管理',
    warm: true,
  },
  '/dashboard/crm/dashboard': {
    ...CRM_SECTION,
    title: '数据看板',
    warm: true,
  },
  '/dashboard/crm/follow-ups': {
    ...CRM_SECTION,
    title: '待跟进',
    warm: true,
  },
  '/dashboard/crm/customers': {
    ...CRM_SECTION,
    title: '客户',
    warm: true,
  },
  '/dashboard/crm/sea': {
    ...CRM_SECTION,
    title: '客户公海',
    navHref: '/dashboard/crm/customers',
    warm: true,
  },
  '/dashboard/crm/proposals': {
    ...CRM_SECTION,
    title: '客户方案',
    warm: true,
  },
  '/dashboard/crm/leads': {
    ...CRM_SECTION,
    title: '线索',
    warm: true,
  },
  '/dashboard/crm/tasks': {
    ...CRM_SECTION,
    title: '任务',
    warm: true,
  },
  '/dashboard/crm/audit': {
    ...CRM_SECTION,
    title: '操作日志',
    warm: true,
  },
  '/dashboard/crm/settings': {
    ...CRM_SECTION,
    title: 'CRM 设置',
    warm: true,
  },
  '/dashboard/ai/insights': {
    ...AI_SECTION,
    title: 'AI洞察',
    warm: true,
  },
  '/dashboard/ai/ad-analysis': {
    ...AI_SECTION,
    title: 'AI 广告分析',
    warm: true,
  },
  '/dashboard/ai/inventory-health': {
    ...AI_SECTION,
    title: 'AI 库存健康',
    warm: true,
  },
  '/dashboard/ai/believeboy-models': {
    ...AI_SECTION,
    title: '模型选型',
    warm: true,
  },
  '/dashboard/ai/customer-service': {
    ...AI_SECTION,
    title: '客服交流',
    warm: true,
  },
  '/dashboard/ai/digital-employees': {
    ...AI_SECTION,
    title: '数字员工',
    warm: true,
  },
  '/dashboard/ai/digital-employees/office': {
    ...AI_SECTION,
    title: '虚拟办公室',
    warm: true,
  },
  '/dashboard/tools/markdown-to-word': {
    ...TOOLS_SECTION,
    title: 'Markdown 转 Word',
    warm: true,
  },
  '/dashboard/tools/page-render': {
    ...TOOLS_SECTION,
    title: 'Markdown / HTML 渲染',
    warm: true,
  },
  '/dashboard/tools/brand-registration-example': {
    ...TOOLS_SECTION,
    title: '品牌备案示例',
    warm: true,
  },
  '/dashboard/tools/product-label': {
    ...TOOLS_SECTION,
    title: '产品标签制作',
    warm: true,
  },
  '/dashboard/tools/cross-border-compliance': {
    ...TOOLS_SECTION,
    title: '跨境电商合规',
    warm: true,
  },
  '/dashboard/system/account-management': {
    ...SYSTEM_SECTION,
    title: '系统账号管理',
    warm: true,
  },
  '/dashboard/system/agent-management': {
    ...SYSTEM_SECTION,
    title: 'Agent 接入管理',
    warm: true,
  },
  '/dashboard/system/alerts': {
    ...SYSTEM_SECTION,
    title: '告警中心',
    warm: true,
  },
  '/dashboard/system/changelog': {
    ...SYSTEM_SECTION,
    title: '更新日志',
    warm: true,
  },
  '/dashboard/system/data-management': {
    ...SYSTEM_SECTION,
    title: '数据库状态',
    warm: true,
  },
  '/dashboard/system/logs': {
    ...SYSTEM_SECTION,
    title: '日志查看',
    warm: true,
  },
  '/dashboard/system/operator-management': {
    ...SYSTEM_SECTION,
    title: '运营管理',
    warm: true,
  },
  '/dashboard/system/project-info': {
    ...SYSTEM_SECTION,
    title: '项目信息',
    warm: true,
  },
}

const WARM_LEDGER_DYNAMIC_ROUTE_META: Array<{
  pattern: RegExp
  meta: DashboardRouteMeta
}> = [
  {
    pattern: /^\/dashboard\/crm\/proposals\/[^/]+$/,
    meta: {
      ...CRM_SECTION,
      title: '客户方案详情',
      navHref: '/dashboard/crm/proposals',
      warm: true,
    },
  },
  {
    pattern: /^\/dashboard\/ai\/digital-employees\/(?!office$)[^/]+$/,
    meta: {
      ...AI_SECTION,
      title: '数字员工详情',
      navHref: '/dashboard/ai/digital-employees',
      warm: true,
    },
  },
]

function normalizeDashboardRoute(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
}

export function getDashboardRouteMeta(pathname: string): DashboardRouteMeta | undefined {
  const normalizedPathname = normalizeDashboardRoute(pathname)
  const routeMeta =
    WARM_LEDGER_EXACT_ROUTE_META[normalizedPathname] ??
    WARM_LEDGER_DYNAMIC_ROUTE_META.find(({ pattern }) => pattern.test(normalizedPathname))?.meta
  if (!routeMeta) return undefined
  return {
    ...routeMeta,
    navHref: routeMeta.navHref ?? normalizedPathname,
  }
}

export function getDashboardPageTitle(pathname: string) {
  if (pathname === '/dashboard') return '运营总览与关键数据面板'
  const routeMeta = getDashboardRouteMeta(pathname)
  if (routeMeta) return routeMeta.title
  return DASHBOARD_PAGE_TITLES.find(({ match }) => pathname.includes(match))?.title ?? 'Dashboard'
}
