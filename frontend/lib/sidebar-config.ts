import type { LucideIcon } from 'lucide-react'
import type { ComponentType } from 'react'
import {
  Banknote,
  BarChart3,
  Bell,
  Calculator,
  CalendarRange,
  ChartColumnBig,
  ClipboardCheck,
  CheckSquare,
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

// Custom CRM badge
import { CrmFollowUpBadge } from '@/components/crm/follow-up-badge'

/**
 * Sidebar 两层结构的唯一数据权威。
 *
 * 外层分组由 SIDEBAR_TOP_GROUPS 定义（8 个顶级分类）。
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
  /** 可选动态徽标组件（如 CRM 待跟进逾期数红点），渲染在标题右侧 */
  badge?: ComponentType
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
  TrendingUp,
  Calculator,
  FileBarChart,
  BarChart3,
  ClipboardCheck,
  CheckSquare,
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

// =========================== 8 个外层分组 ===========================

const NEUTRAL_ACCENT = 'bg-[#e5e5e5] text-[#404040] dark:bg-[#2a2a2a] dark:text-[#b0b0b0]'
const NEUTRAL_ACTIVE = 'bg-[#d4d4d4] text-[#262626] dark:bg-[#383838] dark:text-[#e0e0e0]'

export const SIDEBAR_TOP_GROUPS: SidebarTopGroup[] = [
  // 1. 运营（所有角色）—— 站点 / 店铺 / 销售 / 退货 / 战略 / 平台巡检 / 供应链（商品 / 库存 / 履约）
  {
    id: 'operations',
    label: '运营',
    icon: IconMap.LayoutDashboard,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      { title: '站点导航', url: '/dashboard/operations/site-navigation', icon: IconMap.LayoutDashboard },
      { title: '店铺导航', url: '/dashboard/operations/store-navigation', icon: IconMap.Store },
      { title: '销售数据', url: '/dashboard/operations/daily-analysis', icon: IconMap.TrendingUp },
      { title: '退货分析', url: '/dashboard/operations/return-analysis', icon: IconMap.RotateCcw },
      { title: '项目目标', url: '/dashboard/operations/project-goals', icon: IconMap.Target },
      { title: '调研分析', url: '/dashboard/operations/research-analysis', icon: IconMap.FileSearch },
      { title: '平台巡检', url: '/dashboard/operations/platform-inspection', icon: IconMap.Shield },
      { title: '库存分析', url: '/dashboard/operations/inventory-analysis', icon: IconMap.Warehouse },
      // 供应链原分类（商品 / 库存 / 履约）已并入运营
      { title: '按周产品分析', url: '/dashboard/operations/weekly-product-analysis', icon: IconMap.BarChart3 },
      { title: '组合分析', url: '/dashboard/operations/portfolio-overview', icon: IconMap.Layers },
      { title: 'SKU 信息', url: '/dashboard/operations/sku-info', icon: IconMap.FileBarChart },
      { title: '补货分析', url: '/dashboard/operations/inventory-replenishment', icon: IconMap.Repeat2 },
      { title: '库存分类账', url: '/dashboard/operations/inventory-ledger', icon: IconMap.ClipboardCheck },
      {
        title: '季节性补货分析',
        url: '/dashboard/operations/seasonal-replenishment',
        icon: IconMap.CalendarRange,
      },
      { title: '发货管理', url: '/dashboard/operations/shipment-management', icon: IconMap.Package },
    ],
  },

  // 2. 报表中心（所有角色）—— 一切"产出报表 / 核算单"的入口
  {
    id: 'reports',
    label: '报表中心',
    icon: IconMap.FileBarChart,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      {
        title: '财务月报',
        // 直接指向 display 页（财务月报 Tab），绕开中间 307 重定向，避免首次点击体感"打不开/要刷新"。
        url: '/dashboard/reports/monthly-report/display',
        matchPrefixes: ['/dashboard/reports/monthly-report'],
        icon: IconMap.FileBarChart,
      },
      { title: '产品分析', url: '/dashboard/reports/product-analysis', icon: IconMap.Calculator },
      {
        title: '新品核算',
        url: '/dashboard/reports/pricing-calculation/new-product',
        matchPrefixes: ['/dashboard/reports/pricing-calculation/new-product'],
        icon: IconMap.Coins,
      },
      {
        title: '店铺测算',
        url: '/dashboard/reports/pricing-calculation/shop-calculation',
        matchPrefixes: ['/dashboard/reports/pricing-calculation/shop-calculation'],
        icon: IconMap.Store,
      },
      {
        title: '定时报告',
        url: '/dashboard/reports/scheduled-reports',
        matchPrefixes: ['/dashboard/reports/scheduled-reports'],
        icon: IconMap.Zap,
      },
      { title: '报表自动化', url: '/dashboard/reports/auto-upload', icon: IconMap.Repeat2 },
      { title: '订单信息', url: '/dashboard/reports/order-info', icon: IconMap.ShoppingBag },
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
      { title: '平台回款', url: '/dashboard/finance/platform-revenue', icon: IconMap.Banknote },
      { title: '汇率信息', url: '/dashboard/finance/exchange-rate', icon: IconMap.DollarSign },
      { title: 'VAT 发票', url: '/dashboard/finance/vat-invoice', icon: IconMap.Receipt },
      { title: '佣金管理', url: '/dashboard/finance/commission-management', icon: IconMap.Coins },
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
        url: '/dashboard/advertising/ad-analysis/overview',
        matchPrefixes: ['/dashboard/advertising/ad-analysis'],
        icon: IconMap.BarChart3,
      },
      {
        title: '广告数据',
        url: '/dashboard/advertising/ad-data',
        matchPrefixes: ['/dashboard/advertising/ad-data'],
        icon: IconMap.Database,
      },
    ],
  },

  // 5. AI 智能（所有角色）—— 含数字员工
  {
    id: 'ai',
    label: 'AI 智能',
    icon: Sparkles,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      { title: 'AI洞察', url: '/dashboard/ai/insights', icon: IconMap.TrendingUp },
      {
        title: 'AI 广告分析',
        url: '/dashboard/ai/ad-analysis',
        matchPrefixes: ['/dashboard/ai/ad-analysis'],
        icon: IconMap.BarChart3,
      },
      { title: 'AI Chat', url: '/dashboard/ai/chat', icon: Sparkles },
      {
        title: '模型选型',
        url: '/dashboard/ai/believeboy-models',
        matchPrefixes: ['/dashboard/ai/believeboy-models'],
        icon: IconMap.FileText,
      },
      { title: '客服交流', url: '/dashboard/ai/customer-service', icon: IconMap.MessagesSquare },
      { title: '数字员工', url: '/dashboard/ai/digital-employees', icon: IconMap.Users },
      { title: '虚拟办公室', url: '/dashboard/ai/digital-employees/office', icon: IconMap.LayoutDashboard },
    ],
  },

  // 6. CRM 客户与合作伙伴（所有角色）—— 开发(CRM) + 合作维护(招商)
  {
    id: 'crm',
    label: 'CRM 客户与合作伙伴',
    icon: IconMap.Handshake,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      {
        title: '数据看板',
        url: '/dashboard/crm/dashboard',
        icon: IconMap.BarChart3,
        matchPrefixes: ['/dashboard/crm/dashboard'],
      },
      {
        title: '待跟进',
        url: '/dashboard/crm/follow-ups',
        icon: IconMap.Bell,
        badge: CrmFollowUpBadge,
        matchPrefixes: ['/dashboard/crm/follow-ups'],
      },
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
        title: '任务',
        url: '/dashboard/crm/tasks',
        icon: IconMap.CheckSquare,
        matchPrefixes: ['/dashboard/crm/tasks'],
      },
      {
        title: '操作日志',
        url: '/dashboard/crm/audit',
        icon: IconMap.History,
        matchPrefixes: ['/dashboard/crm/audit'],
      },
      { title: 'CRM 设置', url: '/dashboard/crm/settings', icon: IconMap.SettingsIcon },
    ],
  },

  // 7. 工具箱（所有角色）
  {
    id: 'tools',
    label: '工具箱',
    icon: IconMap.Wrench,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      { title: 'Markdown 转换', url: '/dashboard/tools/markdown-to-word', icon: IconMap.FileText },
      { title: 'Markdown/HTML 渲染', url: '/dashboard/tools/page-render', icon: IconMap.FileCode },
    ],
  },

  // 8. 系统管理（所有角色可见；细粒度权限由单页权限接管）
  {
    id: 'system',
    label: '系统管理',
    icon: IconMap.ShieldUser,
    accent: NEUTRAL_ACCENT,
    activeAccent: NEUTRAL_ACTIVE,
    items: [
      { title: '更新日志', url: '/dashboard/system/changelog', icon: IconMap.History },
      { title: '项目信息', url: '/dashboard/system/project-info', icon: IconMap.Store },
      { title: '数据库状态', url: '/dashboard/system/data-management', icon: IconMap.Database },
      { title: '账号管理', url: '/dashboard/system/account-management', icon: IconMap.Users },
      { title: '运营管理', url: '/dashboard/system/operator-management', icon: IconMap.ShieldUser },
      { title: '告警中心', url: '/dashboard/system/alerts', icon: IconMap.Bell },
      { title: '日志查看', url: '/dashboard/system/logs', icon: IconMap.History },
      { title: 'Agent 接入管理', url: '/dashboard/system/agent-management', icon: IconMap.Shield },
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
