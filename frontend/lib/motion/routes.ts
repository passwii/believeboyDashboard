/**
 * Full-bleed absolute 页面路由清单。
 * 这些页面的根 div 用 !absolute inset-0 撑满父级，不参与正常流高度计算，
 * 因此 PageTransition wrapper 不能用 h-full（百分比链路无法解析）。
 *
 * 新增 full-bleed 页面时只需在此数组追加，不需改组件代码。
 */
const FULL_BLEED_DASHBOARD_ROUTES = ['/dashboard/ai/chat'] as const

export type FullBleedDashboardRoute = (typeof FULL_BLEED_DASHBOARD_ROUTES)[number]

/**
 * 判断给定 pathname 是否属于 full-bleed dashboard 路由。
 * 严格相等匹配，不 startsWith，避免误伤未来 /dashboard/ai/chat-v2 这类。
 */
export function isFullBleedDashboardRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return FULL_BLEED_DASHBOARD_ROUTES.includes(pathname as FullBleedDashboardRoute)
}
