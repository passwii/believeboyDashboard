import type { LucideIcon } from 'lucide-react'
import {
  Banknote,
  BarChart3,
  Bell,
  Bot,
  Calculator,
  CalendarRange,
  ChartColumnBig,
  Coins,
  Database,
  DollarSign,
  FileBarChart,
  FileCode,
  FileSearch,
  FileText,
  History,
  LayoutDashboard,
  MessagesSquare,
  Layers,
  Package,
  Receipt,
  Repeat2,
  RotateCcw,
  ShoppingBag,
  Shield,
  ShieldUser,
  Sparkles,
  Store,
  TrendingUp,
  Truck,
  Users,
  Warehouse,
  Wrench,
  Zap,
  Handshake,
  Target,
  Settings as SettingsIcon,
} from 'lucide-react'

/**
 * Sidebar 两层结构的唯一数据权威。
 *
 * 外层分组由 SIDEBAR_TOP_GROUPS 定义（9 个顶级分类）。
 * 二级菜单项硬编码在每组的 items 中。
 *派生组件（pin-settings、search-command、新 sidebar）全部从本文件派生。
 *
 * 权限说明：自本版起，整组 / 子项的 roles / groupRoles 标记已全部移除，
 * 可见性改由单页权限（per-page）接管，sidebar 不再做角色墙。
 */

export type RoleType = 'admin' | 'businessdev' | 'operator' | string

export type SidebarSubItem = {
  title: string
  url: string
  matchPrefixes?: string[]
  /** 子项图标（用于 pinned / search / recent 显示）；可省略，使用所属外层 icon */
  icon?: LucideIcon
  /** 子项级可见性（已弃用：权限改由单页接管，保留字段以兼容辅助函数） */
  roles?: RoleType[]
}

export type SidebarTopGroup = {
  id: string
  label: string
  icon: LucideIcon
  accent: string
  activeAccent: string
  /**整组级可见性（已弃用：权限改由单页接管，保留字段以兼容辅助函数） */
  groupRoles?: RoleType[]
  items: SidebarSubItem[]
}

// =========================== 子项 icon映射 ===========================

const IconMap = {
  LayoutDashboard,
  MessagesSquare,
  Store,
  Bot,
  TrendingUp,
  Calculator,
  FileBarChart,
  BarChart3,
  Coins,
  History,
  Package,
  Receipt,
  Repeat2,
  Warehouse,
  RotateCcw,
  Layers,
  FileSearch,
  FileText,
  FileCode,
  Users,
  Database,
  Shield,
  DollarSign,
  Banknote,
  Zap,
  Truck,
  ShoppingBag,
  ShieldUser,
  Sparkles,
  ChartColumnBig,
  Bell,
  CalendarRange,
  Handshake,
  Target,
  SettingsIcon,
  Wrench,
}

// =========================== 9 个外层分组 ===========================

const NEUTRAL_ACCENT = 'bg-[#e5e5e5] text-[#404040] dark:bg-[#2a2a2a] dark:text-[#b0b0b0]'
const NEUTRAL_ACTIVE = 'bg-[#d4d4d4] text-[#262626] dark:bg-[#383838] dark:text-[#e0e0e0]'

export const SIDEBAR_TOP_GROUPS: SidebarTopGroup[] = [
  // 1. 报表中心（所有角色）—— 一切"产出报表 / 核算单"的入口
  {
    id: 'reports',
    label: '报表中心',
    icon: IconMap.FileBarChart,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      { title: '财务月报', url: '/dashboard/data-reporting/monthly-report', icon: IconMap.FileBarChart },
      { title: '产品分析', url: '/dashboard/data-reporting/product-analysis', icon: IconMap.Calculator },
      {
        title: '新品核算',
        url: '/dashboard/data-reporting/pricing-calculation/new-product',
        matchPrefixes: ['/dashboard/data-reporting/pricing-calculation/new-product'],
        icon: IconMap.Coins,
      },
      {
        title: '店铺测算',
        url: '/dashboard/data-reporting/pricing-calculation/shop-calculation',
        matchPrefixes: ['/dashboard/data-reporting/pricing-calculation/shop-calculation'],
        icon: IconMap.Store,
      },
      { title: '月度财务分析', url: '/dashboard/data-analysis/financial-data', icon: IconMap.DollarSign },
      { title: '报表核对', url: '/dashboard/data-management/report-reconciliation', icon: IconMap.Shield },
      {
        title: '定时报告',
        url: '/dashboard/data-analysis/scheduled-reports',
        matchPrefixes: ['/dashboard/data-analysis/scheduled-reports'],
        icon: IconMap.Zap,
      },
      { title: '报表自动化', url: '/dashboard/data-management/auto-upload', icon: IconMap.Repeat2 },
    ],
  },

  // 2. 运营（所有角色）—— 站点 / 店铺 / 销售 / 退货 / 战略 / 平台巡检
  {
    id: 'operations',
    label: '运营',
    icon: IconMap.LayoutDashboard,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      { title: '站点导航', url: '/dashboard/operations/site-navigation', icon: IconMap.LayoutDashboard },
      { title: '店铺导航', url: '/dashboard/operations/store-navigation', icon: IconMap.Store },
      { title: '销售数据', url: '/dashboard/data-analysis/daily-analysis', icon: IconMap.TrendingUp },
      { title: '退货分析', url: '/dashboard/data-analysis/return-analysis', icon: IconMap.RotateCcw },
      { title: '项目目标', url: '/dashboard/data-analysis/project-goals', icon: IconMap.Target },
      { title: '调研分析', url: '/dashboard/data-analysis/research-analysis', icon: IconMap.FileSearch },
      { title: '平台巡检', url: '/dashboard/data-management/platform-inspection', icon: IconMap.Shield },
    ],
  },

  // 3. 财务资金（所有角色）—— 资金流水 / 税务（报表已归入报表中心）
  {
    id: 'finance',
    label: '财务资金',
    icon: IconMap.DollarSign,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      { title: '平台回款', url: '/dashboard/data-management/platform-revenue', icon: IconMap.Banknote },
      { title: '汇率信息', url: '/dashboard/data-management/exchange-rate', icon: IconMap.DollarSign },
      { title: 'VAT 发票', url: '/dashboard/data-management/vat-invoice', icon: IconMap.Receipt },
      { title: '佣金管理', url: '/dashboard/system-management/commission-management', icon: IconMap.Coins },
    ],
  },

  // 4. 广告（所有角色）
  {
    id: 'advertising',
    label: '广告',
    icon: IconMap.BarChart3,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      {
        title: '广告分析',
        url: '/dashboard/data-analysis/ad-analysis/overview',
        matchPrefixes: ['/dashboard/data-analysis/ad-analysis'],
        icon: IconMap.BarChart3,
      },
      {
        title: '广告数据',
        url: '/dashboard/data-analysis/ad-data',
        matchPrefixes: ['/dashboard/data-analysis/ad-data'],
        icon: IconMap.Database,
      },
    ],
  },

  // 5. 商品供应链（所有角色）—— 商品 / 库存 / 履约
  {
    id: 'supply-chain',
    label: '商品供应链',
    icon: IconMap.Package,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      { title: '按周产品分析', url: '/dashboard/data-analysis/weekly-product-analysis', icon: IconMap.BarChart3 },
      { title: '组合分析', url: '/dashboard/data-analysis/portfolio-overview', icon: IconMap.Layers },
      { title: 'SKU 信息', url: '/dashboard/data-management/sku-info', icon: IconMap.FileBarChart },
      { title: '库存分析', url: '/dashboard/data-analysis/inventory-analysis', icon: IconMap.Warehouse },
      { title: '补货分析', url: '/dashboard/data-analysis/inventory-replenishment', icon: IconMap.Repeat2 },
      {
        title: '季节性补货分析',
        url: '/dashboard/data-analysis/seasonal-replenishment',
        icon: IconMap.CalendarRange,
      },
      { title: '发货管理', url: '/dashboard/data-management/shipment-management', icon: IconMap.Package },
      { title: '订单信息', url: '/dashboard/data-management/order-info', icon: IconMap.ShoppingBag },
    ],
  },

  // 6. AI 智能（所有角色）—— 含数字员工
  {
    id: 'ai',
    label: 'AI 智能',
    icon: IconMap.Bot,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      { title: 'AI概览', url: '/dashboard/ai', icon: IconMap.Bot },
      { title: 'AI洞察', url: '/dashboard/ai-insights', icon: IconMap.TrendingUp },
      {
        title: 'AI 广告分析',
        url: '/dashboard/ai/ad-analysis',
        matchPrefixes: ['/dashboard/ai/ad-analysis'],
        icon: IconMap.BarChart3,
      },
      { title: 'AI Chat', url: '/dashboard/ai-chat', icon: IconMap.Bot },
      {
        title: '模型选型',
        url: '/dashboard/ai/believeboy-models',
        matchPrefixes: ['/dashboard/ai/believeboy-models'],
        icon: IconMap.FileText,
      },
      { title: '客服交流', url: '/dashboard/ai/customer-service', icon: IconMap.MessagesSquare },
      { title: '数字员工', url: '/dashboard/digital-employees', icon: IconMap.Users },
    ],
  },

  // 7. CRM 客户与合作伙伴（所有角色）—— 开发(CRM) + 合作维护(招商)
  {
    id: 'crm',
    label: 'CRM 客户与合作伙伴',
    icon: IconMap.Handshake,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      {
        title: '客户',
        url: '/dashboard/crm/customers',
        icon: IconMap.Users,
        matchPrefixes: ['/dashboard/crm/customers', '/dashboard/crm/sea'],
      },
      {
        title: '线索',
        url: '/dashboard/crm/leads',
        icon: IconMap.Sparkles,
        matchPrefixes: ['/dashboard/crm/leads'],
      },
      {
        title: '商机',
        url: '/dashboard/crm/opportunities',
        icon: IconMap.Target,
        matchPrefixes: ['/dashboard/crm/opportunities'],
      },
      { title: 'CRM 设置', url: '/dashboard/crm/settings', icon: IconMap.SettingsIcon },
      { title: '招商面板', url: '/dashboard/business-dev/overview', icon: IconMap.Store },
      { title: '供应商管理', url: '/dashboard/business-dev/suppliers', icon: IconMap.Truck },
      { title: '招商报表', url: '/dashboard/business-dev/reports', icon: IconMap.FileBarChart },
    ],
  },

  // 8. 工具箱（所有角色）
  {
    id: 'tools',
    label: '工具箱',
    icon: IconMap.Wrench,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      { title: 'Markdown 转换', url: '/dashboard/special/markdown-to-word', icon: IconMap.FileText },
      { title: 'Markdown/HTML 渲染', url: '/dashboard/special/page-render', icon: IconMap.FileCode },
    ],
  },

  // 9. 系统管理（所有角色可见；细粒度权限由单页权限接管）
  {
    id: 'system',
    label: '系统管理',
    icon: IconMap.ShieldUser,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      { title: '更新日志', url: '/dashboard/changelog', icon: IconMap.History },
      { title: '项目信息', url: '/dashboard/system-management/project-info', icon: IconMap.Store },
      { title: '数据库状态', url: '/dashboard/system-management/data-management', icon: IconMap.Database },
      { title: '账号管理', url: '/dashboard/system-management/account-management', icon: IconMap.Users },
      { title: '运营管理', url: '/dashboard/system-management/operator-management', icon: IconMap.ShieldUser },
      { title: '日志查看', url: '/dashboard/system-management/logs', icon: IconMap.History },
      { title: '备份管理', url: '/dashboard/system-management/backup-management', icon: IconMap.Database },
    ],
  },
]

// =========================== 工具函数 ===========================

/**
 * 子项级角色过滤（保留接口；当前无 roles 标记，全部可见，权限由单页接管）。
 */
export function filterByRole<T extends { roles?: RoleType[] }>(
  items: T[],
  roleType?: RoleType
): T[] {
  if (!roleType) return items.filter((it) => !it.roles)
  return items.filter((it) => !it.roles || it.roles.includes(roleType))
}

/**
 * 返回当前角色可见的完整分组列表（含整组过滤 + 子项过滤）。
 */
export function getVisibleGroups(
  groups: SidebarTopGroup[] = SIDEBAR_TOP_GROUPS,
  roleType?: RoleType
): SidebarTopGroup[] {
  return (
    groups
      .filter((g) => !g.groupRoles || (roleType && g.groupRoles.includes(roleType)))
      .map((g) => ({ ...g, items: filterByRole(g.items, roleType) }))
      // 特殊功能组（无 groupRoles）的子项可能过滤后为空，但仍保留 icon 显示
      .filter((g) => g.groupRoles || g.items.length > 0)
  )
}

/**
 * URL活动判定（含前缀匹配）。
 */
export function isLinkActive(pathname: string, item: SidebarSubItem): boolean {
  if (item.url === '/dashboard') return pathname === item.url
  if (pathname === item.url) return true
  return item.matchPrefixes?.some((p) => pathname.startsWith(p)) ?? false
}

/**
 * 给定 pathname，找到所在的外层分组 id。
 */
export function findGroupByPathname(
  groups: SidebarTopGroup[],
  pathname: string
): string | undefined {
  return groups.find((g) => g.items.some((it) => isLinkActive(pathname, it)))?.id
}

/**
 *派生：扁平化的所有菜单项（用于 pinned / search）。
 *包含角色过滤（默认对所有角色可见）。
 */
export function flattenAllItems(groups: SidebarTopGroup[] = SIDEBAR_TOP_GROUPS): SidebarSubItem[] {
  return groups.flatMap((g) => g.items)
}
