/**
 * Agent 业务域注册表（BLF-448）。
 *
 * 单一事实源：新增业务域 = 注册表加一条 + 后端挂路由，页面自动出现。
 * ``code`` 必须与后端 ``agent_api_keys.business_scope`` 取值一致
 * （``require_business_scope("<code>")`` 路由接线）。
 */

export type AgentDomainStatus = 'live' | 'planned'

export type AgentDomain = {
  /** 后端 business_scope 取值，如 'shipments' */
  code: string
  /** 中文名 */
  label: string
  /** 一句话说明 */
  description: string
  /** live = 已接入 agent 命名空间；planned = 规划中（仅概览展示） */
  status: AgentDomainStatus
  /** agent 命名空间路由数（展示用，人工维护） */
  routeCount: number
  /** Dashboard 前端入口页（无对应页面的域省略，如规划中 finance_profit） */
  dashboardPath?: string
  capabilities: { read: boolean; write: boolean }
}

export const AGENT_DOMAINS: AgentDomain[] = [
  {
    code: 'shipments',
    dashboardPath: '/dashboard/operations/shipment-management',
    label: '货件管理',
    description: 'FBA 货件全生命周期：列表/详情/增删改/状态推进/费用重算',
    status: 'live',
    routeCount: 11,
    capabilities: { read: true, write: true },
  },
  {
    code: 'shop_calculations',
    dashboardPath: '/dashboard/reports/pricing-calculation/shop-calculation',
    label: '店铺测算',
    description: '店铺测算数据读写与试算：列表/SKU 详情/历史/审计/追加/试算',
    status: 'live',
    routeCount: 6,
    capabilities: { read: true, write: true },
  },
  {
    code: 'return_analysis',
    dashboardPath: '/dashboard/operations/return-analysis',
    label: '退货分析',
    description: '退货/客诉归因：全量分析/per-SKU 风险清单/raw 事件/覆盖度',
    status: 'live',
    routeCount: 5,
    capabilities: { read: true, write: false },
  },
  {
    code: 'inventory',
    dashboardPath: '/dashboard/operations/inventory-analysis',
    label: '库存信息',
    description: '当前库存快照：总量/库龄/缺货/单 SKU 数量（独立于补货分析）',
    status: 'live',
    routeCount: 1,
    capabilities: { read: true, write: false },
  },
  {
    code: 'ad_analysis',
    dashboardPath: '/dashboard/advertising/ad-analysis/overview',
    label: '广告分析',
    description: '10 个广告域聚合（预算/搜索词/竞品份额）',
    status: 'live',
    routeCount: 10,
    capabilities: { read: true, write: false },
  },
  {
    code: 'inventory_ledger',
    dashboardPath: '/dashboard/operations/inventory-ledger',
    label: '库存台账',
    description: '月度盘点/事件/收货簇/完整性/趋势（Detailed + Summary 视图）',
    status: 'live',
    routeCount: 10,
    capabilities: { read: true, write: false },
  },
  {
    code: 'report_upload_status',
    dashboardPath: '/dashboard/reports/auto-upload',
    label: '报表状态',
    description: 'RPA 报表上传状态矩阵：15 类活跃报表缺失统计',
    status: 'live',
    routeCount: 1,
    capabilities: { read: true, write: false },
  },
  {
    code: 'report_upload',
    dashboardPath: '/dashboard/reports/auto-upload',
    label: '报表上传',
    description: 'Agent 报表上传：dry-run 校验 + 正式提交（列匹配度/多站点检测/审计）',
    status: 'live',
    routeCount: 2,
    capabilities: { read: false, write: true },
  },
  {
    code: 'monthly_reports',
    dashboardPath: '/dashboard/reports/monthly-report/display',
    label: '财务月报',
    description:
      '月报列表/详情/财务序列/核算明细与导出 + 上传/计算草稿/预览/确认入库/自动与手工对账（读 10 + 写 6）',
    status: 'live',
    routeCount: 16,
    capabilities: { read: true, write: true },
  },
  {
    code: 'replenishment_analysis',
    dashboardPath: '/dashboard/operations/inventory-replenishment',
    label: '补货分析',
    description: '补货决策清单/单 SKU 深挖/项目总览/覆盖度/设置（三段式体系，BLF-502）',
    status: 'live',
    routeCount: 6,
    capabilities: { read: true, write: true },
  },
  {
    code: 'new_product_calculations',
    dashboardPath: '/dashboard/reports/pricing-calculation/new-product',
    label: '新品测算',
    description: '新品测算快照读写与试算：列表/SKU 详情/审计/落库/试算（读3+写1+试算1，BLF-526）',
    status: 'live',
    routeCount: 5,
    capabilities: { read: true, write: true },
  },
  {
    code: 'account_health',
    dashboardPath: '/dashboard/operations/platform-inspection',
    label: '店铺合规健康',
    description: '店铺合规/账户健康：周巡检周期列表/概览/单店明细/历史趋势（读 5 条，BLF-547）',
    status: 'live',
    routeCount: 5,
    capabilities: { read: true, write: false },
  },
  {
    code: 'platform_inspection',
    dashboardPath: '/dashboard/operations/platform-inspection',
    label: '平台巡检',
    description: '平台巡检写侧：模板 + 填写/更新/提交报告 + 截图上传/删除（写 5 条，读侧走 account-health，BLF-944）',
    status: 'live',
    routeCount: 5,
    capabilities: { read: false, write: true },
  },
  {
    code: 'complaint_center',
    dashboardPath: '/dashboard/operations/complaint-center',
    label: '客户消息',
    description: 'Agent 每日巡检客诉写入 + Dashboard 概览/明细/详情管理（W1 批量 upsert + R1 列表读取，BLF-981）',
    status: 'live',
    routeCount: 2,
    capabilities: { read: true, write: true },
  },
  {
    code: 'sales',
    dashboardPath: '/dashboard/operations/daily-analysis',
    label: '销售数据',
    description: '销售订单明细/聚合统计：原始行 + ASIN×日/ASIN/日聚合（Sales Data）',
    status: 'live',
    routeCount: 1,
    capabilities: { read: true, write: false },
  },
  {
    code: 'sku_info',
    dashboardPath: '/dashboard/operations/sku-info',
    label: 'SKU 主数据',
    description: '商品主数据读+写：列表/详情/审计 + 新建/改规格成本/上下架（confirm 流，BLF-579）+ FNSKU 标签上传（BLF-628）+ Listing 文案批量写（W6，BLF-1083）',
    status: 'live',
    routeCount: 9,
    capabilities: { read: true, write: true },
  },
  {
    code: 'agent_provisioning',
    dashboardPath: '/dashboard/system/agent-management',
    label: '凭据签发',
    description: '签发新 Agent 凭据（敏感，仅管理 Key）',
    status: 'live',
    routeCount: 1,
    capabilities: { read: false, write: true },
  },
  {
    code: 'finance_profit',
    label: '财务利润',
    description: '利润/财务（月度×项目×国家），COGS 口径待定',
    status: 'planned',
    routeCount: 0,
    capabilities: { read: true, write: false },
  },
]

/** 全域放行哨兵值（与后端 server_default 对齐）。 */
export const BUSINESS_SCOPE_ALL = '*'

/** 归一化：空串 / '*' → '*'; 其余保持 ',' 分隔白名单。 */
export function normalizeBusinessScope(scope: string | null | undefined): string {
  if (!scope) return BUSINESS_SCOPE_ALL
  const trimmed = scope.trim()
  if (!trimmed || trimmed === BUSINESS_SCOPE_ALL) return BUSINESS_SCOPE_ALL
  return trimmed
}

/** 域 code → 注册表条目（未知 code 回退 null，供格式化成 #code）。 */
export function getAgentDomain(code: string): AgentDomain | undefined {
  return AGENT_DOMAINS.find((d) => d.code === code)
}

/** 判断 scope 是否覆盖某域：'*' 恒 true；否则白名单包含。 */
export function scopeHasDomain(scope: string | null | undefined, code: string): boolean {
  const normalized = normalizeBusinessScope(scope)
  if (normalized === BUSINESS_SCOPE_ALL) return true
  return normalized
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(code)
}

/** 格式化 scope 为可读文案：'*' → 全部业务域；否则域中文名列表。 */
export function formatBusinessScope(scope: string | null | undefined): string {
  const normalized = normalizeBusinessScope(scope)
  if (normalized === BUSINESS_SCOPE_ALL) return '全部业务域'
  return normalized
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((code) => getAgentDomain(code)?.label ?? `#${code}`)
    .join('、')
}

/** 已接入（live）域列表：创建凭据时可选。 */
export function liveAgentDomains(): AgentDomain[] {
  return AGENT_DOMAINS.filter((d) => d.status === 'live')
}
