import type { LucideIcon } from 'lucide-react'
import {
 Banknote,
 BarChart3,
 Bell,
 Bot,
 Calculator,
 ChartColumnBig,
 Coins,
 Database,
 DollarSign,
 FileBarChart,
 FileSearch,
 History,
 LayoutDashboard,
 Layers,
 Package,
 Repeat,
 Repeat2,
 RotateCcw,
 Search,
 Shield,
 ShieldUser,
 ShoppingCart,
 Sparkles,
 Store,
 TrendingUp,
 Truck,
 Upload,
 Users,
 Warehouse,
 Zap,
} from 'lucide-react'

/**
 * Sidebar 两层结构的唯一数据权威。
 *
 * 外层分组由 SIDEBAR_TOP_GROUPS 定义（7 个顶级分类）。
 * 二级菜单项硬编码在每组的 items 中。
 *派生组件（pin-settings、search-command、新 sidebar）全部从本文件派生。
 */

export type RoleType = 'admin' | 'businessdev' | 'operator' | 'factory' | string

export type SidebarSubItem = {
 title: string
 url: string
 matchPrefixes?: string[]
 /** 子项级可见性；undefined = 所有角色 */
 roles?: RoleType[]
 /** 子项图标（用于 pinned / search / recent 显示）；可省略，使用所属外层 icon */
 icon?: LucideIcon
}

export type SidebarTopGroup = {
 id: string
 label: string
 icon: LucideIcon
 accent: string
 activeAccent: string
 /**整组级可见性；undefined =整组全角色可见 */
 groupRoles?: RoleType[]
 items: SidebarSubItem[]
}

// =========================== 子项 icon映射 ===========================

const IconMap = {
 LayoutDashboard,
 Store,
 Bot,
 TrendingUp,
 Calculator,
 FileBarChart,
 BarChart3,
 Coins,
 ShoppingCart,
 History,
 Package,
 Repeat,
 Repeat2,
 Warehouse,
 RotateCcw,
 Layers,
 FileSearch,
 Search,
 Users,
 Database,
 Shield,
 DollarSign,
 Banknote,
 Upload,
 Zap,
 Truck,
 ShieldUser,
 Sparkles,
 ChartColumnBig,
 Bell,
}

// ===========================7 个外层分组（最终定义） ===========================

export const SIDEBAR_TOP_GROUPS: SidebarTopGroup[] = [
 //1.运营导航（所有角色）
 {
 id: 'operations',
 label: '运营导航',
 icon: IconMap.LayoutDashboard,
 accent: 'bg-[linear-gradient(180deg,#505050,#686868)] text-[#f5f5f5]',
 activeAccent: 'bg-[linear-gradient(180deg,#6a6a6a,#818181)] text-white',
 items: [
 { title: '站点导航', url: '/dashboard/operations/site-navigation', icon: IconMap.LayoutDashboard },
 { title: '店铺导航', url: '/dashboard/operations/store-navigation', icon: IconMap.Store },
 ],
 },

 //2. AI面板（所有角色）
 {
 id: 'ai',
 label: 'AI面板',
 icon: IconMap.Bot,
 accent: 'bg-[linear-gradient(180deg,#5a2f8f,#7b43c2)] text-[#efe0ff]',
 activeAccent: 'bg-[linear-gradient(180deg,#7340b4,#9558e0)] text-white',
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
 ],
 },

 //3.运营核算（所有角色）
 {
 id: 'reporting',
 label: '运营核算',
 icon: IconMap.Calculator,
 accent: 'bg-[linear-gradient(180deg,#6a5411,#92741a)] text-[#f9e6a6]',
 activeAccent: 'bg-[linear-gradient(180deg,#886b16,#b18c1e)] text-white',
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
 ],
 },

 //4. 数据分析（所有角色）
 {
 id: 'analysis',
 label: '数据分析',
 icon: IconMap.ChartColumnBig,
 accent: 'bg-[linear-gradient(180deg,#0f527a,#1675ae)] text-[#b3e3ff]',
 activeAccent: 'bg-[linear-gradient(180deg,#156896,#1b90cf)] text-white',
 items: [
 { title: '销售数据', url: '/dashboard/data-analysis/daily-analysis', icon: IconMap.TrendingUp },
 {
 title: '广告分析',
 url: '/dashboard/data-analysis/ad-analysis/overview',
 matchPrefixes: ['/dashboard/data-analysis/ad-analysis'],
 icon: IconMap.BarChart3,
 },
 { title: '月度财务分析', url: '/dashboard/data-analysis/financial-data', icon: IconMap.DollarSign },
 { title: '按周产品分析', url: '/dashboard/data-analysis/weekly-product-analysis', icon: IconMap.BarChart3 },
 { title: '库存分析', url: '/dashboard/data-analysis/inventory-analysis', icon: IconMap.Warehouse },
 { title: '补货分析', url: '/dashboard/data-analysis/inventory-replenishment', icon: IconMap.Repeat2 },
 { title: '组合分析', url: '/dashboard/data-analysis/portfolio-overview', icon: IconMap.Layers },
 { title: '退货分析', url: '/dashboard/data-analysis/return-analysis', icon: IconMap.RotateCcw },
 { title: '项目目标', url: '/dashboard/data-analysis/project-goals', icon: IconMap.TrendingUp },
 { title: '调研分析', url: '/dashboard/data-analysis/research-analysis', icon: IconMap.FileSearch },
 ],
 },

 //5. 数据管理（所有角色）
 {
 id: 'data-management',
 label: '数据管理',
 icon: IconMap.Database,
 accent: 'bg-[linear-gradient(180deg,#8c3b5e,#bb5682)] text-[#ffe1ee]',
 activeAccent: 'bg-[linear-gradient(180deg,#aa4b72,#d46797)] text-white',
 items: [
 { title: '发货管理', url: '/dashboard/data-management/shipment-management', icon: IconMap.Package },
 { title: 'SKU 信息', url: '/dashboard/data-management/sku-info', icon: IconMap.FileBarChart },
 { title: '报表核对', url: '/dashboard/data-management/report-reconciliation', icon: IconMap.Shield },
 { title: '平台巡检', url: '/dashboard/data-management/platform-inspection', icon: IconMap.Shield },
 { title: '汇率信息', url: '/dashboard/data-management/exchange-rate', icon: IconMap.DollarSign },
 { title: '平台回款', url: '/dashboard/data-management/platform-revenue', icon: IconMap.Banknote },
 { title: '报表自动化', url: '/dashboard/data-management/auto-upload', icon: IconMap.Zap },
 ],
 },

 //6.特殊功能（合并：招商管理 +数字员工 + 支持入口）
 //整组 icon始终可见，子项按角色过滤
 {
 id: 'special',
 label: '特殊功能',
 icon: IconMap.Sparkles,
 accent: 'bg-[linear-gradient(180deg,#1a3a5c,#2a5a8c)] text-[#b3d4ff]',
 activeAccent: 'bg-[linear-gradient(180deg,#1e4a72,#3478b0)] text-white',
 items: [
 {
 title: '招商面板',
 url: '/dashboard/business-dev/overview',
 roles: ['admin', 'businessdev'],
 icon: IconMap.Store,
 },
 {
 title: '供应商管理',
 url: '/dashboard/business-dev/suppliers',
 roles: ['admin', 'businessdev'],
 icon: IconMap.Truck,
 },
 {
 title: '招商报表',
 url: '/dashboard/business-dev/reports',
 roles: ['admin', 'businessdev'],
 icon: IconMap.FileBarChart,
 },
 {
 title: '数字员工',
 url: '/dashboard/digital-employees',
 roles: ['admin'],
 icon: IconMap.Users,
 },
 { title: '更新日志', url: '/dashboard/changelog', icon: IconMap.History },
 ],
 },

 //7. 系统管理（admin only —整组过滤）
 {
 id: 'system',
 label: '系统管理',
 icon: IconMap.ShieldUser,
 accent: 'bg-[linear-gradient(180deg,#4d4f8d,#676cc3)] text-[#e2e4ff]',
 activeAccent: 'bg-[linear-gradient(180deg,#6166ae,#7c82dd)] text-white',
 groupRoles: ['admin'],
 items: [
 { title: '项目信息', url: '/dashboard/system-management/project-info', icon: IconMap.Store },
 { title: '数据库状态', url: '/dashboard/system-management/data-management', icon: IconMap.Database },
 { title: '账号管理', url: '/dashboard/system-management/account-management', icon: IconMap.Users },
 { title: '运营管理', url: '/dashboard/system-management/operator-management', icon: IconMap.ShieldUser },
 { title: '佣金管理', url: '/dashboard/system-management/commission-management', icon: IconMap.Coins },
 { title: '日志查看', url: '/dashboard/system-management/logs', icon: IconMap.History },
 { title: '通知设置', url: '/dashboard/system-management/notification-settings', icon: IconMap.Bell },
 { title: '定时报告', url: '/dashboard/system-management/scheduled-reports', icon: IconMap.Zap },
 { title: '备份管理', url: '/dashboard/system-management/backup-management', icon: IconMap.Database },
 ],
 },
]

// ===========================工具函数 ===========================

/**
 * 子项级角色过滤。
 */
export function filterByRole<T extends { roles?: RoleType[] }>(
 items: T[],
 roleType?: RoleType,
): T[] {
 if (!roleType) return items.filter((it) => !it.roles)
 return items.filter((it) => !it.roles || it.roles.includes(roleType))
}

/**
 * 返回当前角色可见的完整分组列表（含整组过滤 + 子项过滤）。
 */
export function getVisibleGroups(
 groups: SidebarTopGroup[] = SIDEBAR_TOP_GROUPS,
 roleType?: RoleType,
): SidebarTopGroup[] {
 return groups
 .filter((g) => !g.groupRoles || (roleType && g.groupRoles.includes(roleType)))
 .map((g) => ({ ...g, items: filterByRole(g.items, roleType) }))
 //特殊功能组（无 groupRoles）的子项可能过滤后为空，但仍保留 icon 显示
 .filter((g) => g.groupRoles || g.items.length >0)
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
 pathname: string,
): string | undefined {
 return groups.find((g) => g.items.some((it) => isLinkActive(pathname, it)))?.id
}

/**
 *派生：扁平化的所有菜单项（用于 pinned / search）。
 *包含角色过滤（默认对所有角色可见）。
 */
export function flattenAllItems(
 groups: SidebarTopGroup[] = SIDEBAR_TOP_GROUPS,
): SidebarSubItem[] {
 return groups.flatMap((g) => g.items)
}
