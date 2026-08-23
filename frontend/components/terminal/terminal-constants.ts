import type { SidebarSubItem, SidebarTopGroup } from '@/lib/sidebar-config'

/**
 * Terminal 外壳尺寸与持久化常量（BLF-809）。
 * 规格来源：高密度交易终端设计规范 —— L1 50px / L2 200px / Header 36px / Footer 24px / Inspector 280px。
 */

export const TERMINAL_RAIL_WIDTH = 50
export const TERMINAL_SUBNAV_WIDTH = 200
export const TERMINAL_HEADER_HEIGHT = 36
export const TERMINAL_FOOTER_HEIGHT = 24
export const TERMINAL_INSPECTOR_WIDTH = 288

export const TERMINAL_STORAGE_KEYS = {
  subnavCollapsed: 'bb.terminal.subnav-collapsed',
  inspectorOpen: 'bb.terminal.inspector-open',
  recents: 'bb.terminal.recents',
} as const

export type RecentPageEntry = {
  path: string
  title: string
}

export function readRecents(): RecentPageEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(TERMINAL_STORAGE_KEYS.recents)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (it): it is RecentPageEntry =>
        !!it && typeof it === 'object' && typeof (it as RecentPageEntry).path === 'string'
    )
  } catch {
    return []
  }
}

export function pushRecent(path: string, title: string): RecentPageEntry[] {
  const next = [{ path, title }, ...readRecents().filter((it) => it.path !== path)].slice(0, 8)
  try {
    window.localStorage.setItem(TERMINAL_STORAGE_KEYS.recents, JSON.stringify(next))
  } catch {
    // 隐私模式等写入失败场景静默降级（仅影响"最近访问"列表）
  }
  return next
}

/** 组内当前激活项（供 SubNav 高亮）；无匹配时回退组第一项作为默认落点 */
export function findActiveItem(
  group: SidebarTopGroup,
  pathname: string
): SidebarSubItem | undefined {
  return group.items.find((it) => isItemActive(it, pathname))
}

export function isItemActive(item: SidebarSubItem, pathname: string): boolean {
  if (pathname === item.url) return true
  return item.matchPrefixes?.some((p) => pathname.startsWith(p)) ?? false
}
