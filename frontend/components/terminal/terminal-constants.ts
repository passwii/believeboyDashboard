import type { SidebarSubItem, SidebarTopGroup } from '@/lib/sidebar-config'

/**
 * Terminal 外壳尺寸与持久化常量（BLF-809）。
 * 尺寸沿革：原始 50/200/36/24/280 → 全局放大两档 64/256/48/32/360 →
 * BLF-844 SubNav 回调 224 → BLF-887（2026-08-29）高度整体上档：
 * Header 48→56 / Footer 32→36；宽度维度（Rail 64 / SubNav 224 / Inspector 360）不变。
 */

// 宽度维持 BLF-844/809 规格（SubNav 256 曾因观感过宽回调至 224，用户未反馈宽度问题）。
export const TERMINAL_RAIL_WIDTH = 64
/**
 * L1 Rail 主轨图标尺寸（BLF-850 18→20；BLF-887 整体上档 20→24）：
 * 8 大业务域图标 + 底部主题切换图标统一引用本常量（24px），单源驱动。
 * 组件侧经内联 style 应用（Tailwind JIT 不编译模板字符串拼出的任意值类，
 * `h-[${N}px]` 动态类历史上从未生成——BLF-887 修复为 style + 测试断言 style）。
 * 仅限 L1 Rail；其余 L-图标（Header 工具钮）为 20px（见 master-prompt §1b-2）。
 */
export const TERMINAL_RAIL_ICON_SIZE = 24
export const TERMINAL_SUBNAV_WIDTH = 224
/** SubNav 折叠宽度（BLF-825）：有意整列收起归零（与 BLF-809 旧行为等价），仅以动效呈现；非窄图标列 */
export const TERMINAL_SUBNAV_COLLAPSED_WIDTH = 0

/**
 * L2 SubNav 折叠/展开动效参数（BLF-825）。
 * 曲线取 ease-out-expo 类（cubic-bezier(0.16, 1, 0.3, 1)）：快出缓收，符合交易终端的利落手感。
 * 内容退场先于容器收缩、入场晚于容器展开，形成「壳动→字散→壳定→字归」的分层节奏。
 */
export const TERMINAL_SUBNAV_MOTION = {
  /** 容器宽度过渡时长（ms）；对齐 --duration-fast（250ms，dropdown/panel open 档） */
  durationMs: 250,
  /** 宽度过渡缓动曲线；对齐 --ease-smooth-out */
  ease: 'cubic-bezier(0.22, 1, 0.36, 1)',
  /** 文本内容淡出时长（ms）；收缩时文字先行淡出，对齐 --duration-micro（80ms） */
  fadeOutMs: 80,
  /** 文本内容入场单段时长（ms）；展开时级联淡入，对齐 --duration-quick（150ms） */
  fadeInMs: 150,
  /** 入场 stagger 步长（ms）：组头 → 搜索框 → 列表项依次级联，对齐 --duration-stagger（40ms） */
  staggerStepMs: 40,
  /** 入场最大级联延迟（ms），防止列表过长时尾部等待过久 */
  maxStaggerDelayMs: 240,
} as const
export const TERMINAL_HEADER_HEIGHT = 56
/**
 * 顶部基准带高度（BLF-832 / master-prompt §任务 1）：各列顶部第一个区块
 * （Rail Logo 位 / SubNav 组头 / Inspector 标题条）统一引用本常量，
 * 保证四列第一条横向分割线贯通。表达式绑定 Header 高度，联动调整。
 */
export const TERMINAL_TOP_STRIP_HEIGHT = TERMINAL_HEADER_HEIGHT
export const TERMINAL_FOOTER_HEIGHT = 36
export const TERMINAL_INSPECTOR_WIDTH = 360

/**
 * Footer 多频道滚动 Ticker 配置（BLF-816）。
 * 频道开关集中在此，新增/下线频道只改常量不动组件。
 */
export const TERMINAL_TICKER = {
  /** 滚动速度（像素/秒）；按内容实际宽度换算动画时长，保证匀速观感 */
  scrollSpeedPxPerSecond: 60,
  /** 内容不超宽时关闭滚动（静态展示），避免双拷贝出现空档跳动 */
  staticWhenContentFits: true,
  /** 各频道数据轮询间隔（毫秒） */
  pollIntervalMs: 5 * 60 * 1000,
  /** 手动 scrub（BLF-966）：滚轮回看灵敏度 */
  manualScrub: {
    /** 每单位滚轮增量的偏移像素；Shift 按住时加速 */
    pxPerDelta: 1,
    shiftMultiplier: 3,
  },
  channels: {
    /** 汇率频道：全部可用币种 + 环比涨跌着色 */
    fx: true,
    /** 全局快报（近 7 天，T-1 终点）：GMV / 订单数 / Pending / 广告花费 / 广告订单数 / 本月至今 GMV，单指标环比 vs 上一周期（本月 vs 上月同期，BLF-950/967） */
    dailyBrief: true,
    /** 最近同步完成时刻（复用汇率频道成功时间） */
    syncTime: true,
    /** 更新日志最新一条摘要（本地 changelog 快照，无网络开销） */
    changelog: true,
    /** 库存预警：低于安全库存（断货风险/短期断货/长期断货）的 SKU 数，复用补货分析 summary.out_of_stock_risk_count */
    inventoryAlert: true,
    /** 报表上传完成度：当日报表 N/M（缺口 >0 才渲染），复用 RPA 状态矩阵端点 */
    uploadStatus: true,
    /** 数据新鲜度：关键报表最新数据日期（数据至 MM-DD），随快报响应透出 */
    dataFreshness: true,
    /** 告警事件：全局 active 告警计数（totalActive>0 才渲染），分级着色 */
    alertEvents: true,
  },
} as const

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
  return group.items
    .filter((item) => isItemActive(item, pathname))
    .sort((a, b) => getMatchSpecificity(b, pathname) - getMatchSpecificity(a, pathname))[0]
}

export function isItemActive(item: SidebarSubItem, pathname: string): boolean {
  return getMatchSpecificity(item, pathname) > 0
}

function getMatchSpecificity(item: SidebarSubItem, pathname: string): number {
  if (pathname === item.url) return Number.MAX_SAFE_INTEGER
  return (
    item.matchPrefixes?.reduce(
      (specificity, prefix) => (pathname.startsWith(prefix) ? Math.max(specificity, prefix.length) : specificity),
      0
    ) ?? 0
  )
}
