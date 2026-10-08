'use client'

import * as React from 'react'
import { usePathname, useRouter } from 'next/navigation'

/**
 * BLF-819 · Top Header 全局筛选状态（DashboardFilterContext）。
 *
 * 让头部从「展示壳」变成真正的全局控制台：project / country / dateRange 三维
 * 全局筛选状态，供头部四件套（项目 / 站点 / 日期 / KPI 磁贴）读写，试点页消费。
 *
 * 同步策略（三层真相源，优先级从高到低）：
 *  1. URL query（gProject / gCountry / gDateFrom / gDateTo）—— 可分享、可后退恢复；
 *     g 前缀避免与广告分析页已有的 country / dateFrom 等页面级参数冲突。
 *  2. localStorage（跨页导航 / 下次进入时记忆上次选择）。
 *  3. 内置默认值（国家 US；日期 = 美西时区近 7 天，客户端计算避免 SSR 水合不一致）。
 *
 * 写入路径：update() 同时落 localStorage + URL（router.replace，不堆历史栈）。
 *
 * ⚠️ 故意不使用 useSearchParams：provider 挂在整个 dashboard layout 上，
 * 若引入该 hook 会让所有静态预渲染子页面的构建报 Missing Suspense 边界错误。
 * URL 读取改走 window.location.search（mount 时一次 + popstate 监听），
 * 代价是 SPA 内部 push 导航不触发重读 —— 对本场景（header 写、试点页读内存态）无影响。
 */

export type TerminalGlobalFilterState = {
  /** 项目 ID 字符串；'' = 尚未选择（项目列表加载后自动选第一个），'all' = 全部项目 */
  projectId: string
  /** 国家站点代码；默认 'US'，'ALL' = 全部站点 */
  country: string
  /** YYYY-MM-DD */
  dateFrom: string
  /** YYYY-MM-DD */
  dateTo: string
}

export type TerminalGlobalFilterContextValue = TerminalGlobalFilterState & {
  /** 水合（URL → localStorage → 默认值）是否完成；完成前消费者应跳过绑定 */
  ready: boolean
  setProjectId: (v: string) => void
  setCountry: (v: string) => void
  setDateRange: (from: string, to: string) => void
}

/** URL query 键名（g 前缀 = global，避免与页面级参数冲突） */
export const GLOBAL_FILTER_URL_KEYS = {
  projectId: 'gProject',
  country: 'gCountry',
  dateFrom: 'gDateFrom',
  dateTo: 'gDateTo',
} as const

const STORAGE_KEY = 'bb.terminal.global-filter'

/**
 * 试点消费页路由前缀（BLF-819 先接销售数据 + 订单信息两页）。
 * 后续批量接入：把新页面加进这里 + 页面内加一段 useTerminalGlobalFilter 绑定 effect，
 * 迁移说明见 BLF-819 issue 完成评论。
 */
export const GLOBAL_FILTER_PILOT_PREFIXES = [
  '/dashboard/operations/daily-analysis',
  '/dashboard/reports/order-info',
  '/dashboard/operations/shipping-plan',
] as const

export function isGlobalFilterPilotRoute(pathname: string): boolean {
  return GLOBAL_FILTER_PILOT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

const US_TIMEZONE = 'America/Los_Angeles'

/** en-CA locale 直接输出 YYYY-MM-DD */
function todayYMDInTimezone(tz = US_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
}

/** 默认日期窗口：美西时区近 7 天（含今天），与首页 / 销售数据页口径一致 */
export function defaultGlobalDateRange(): { dateFrom: string; dateTo: string } {
  const dateTo = todayYMDInTimezone()
  const [y, m, d] = dateTo.split('-').map(Number)
  const fromDate = new Date(y!, m! - 1, d!)
  fromDate.setDate(fromDate.getDate() - 6)
  const dateFrom = [
    fromDate.getFullYear(),
    String(fromDate.getMonth() + 1).padStart(2, '0'),
    String(fromDate.getDate()).padStart(2, '0'),
  ].join('-')
  return { dateFrom, dateTo }
}

function readStored(): Partial<TerminalGlobalFilterState> | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Record<string, unknown>
    const out: Partial<TerminalGlobalFilterState> = {}
    for (const key of ['projectId', 'country', 'dateFrom', 'dateTo'] as const) {
      if (typeof obj[key] === 'string') out[key] = obj[key] as string
    }
    return out
  } catch {
    return null
  }
}

function writeStored(state: TerminalGlobalFilterState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 隐私模式等写入失败静默降级：仅影响下次进入时的记忆
  }
}

function readUrlFilter(): Partial<TerminalGlobalFilterState> {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  const out: Partial<TerminalGlobalFilterState> = {}
  for (const key of Object.keys(GLOBAL_FILTER_URL_KEYS) as Array<
    keyof typeof GLOBAL_FILTER_URL_KEYS
  >) {
    const v = params.get(GLOBAL_FILTER_URL_KEYS[key])
    if (v) out[key] = v
  }
  return out
}

const Ctx = React.createContext<TerminalGlobalFilterContextValue | null>(null)

export function TerminalGlobalFilterProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()

  const [ready, setReady] = React.useState(false)
  const [state, setState] = React.useState<TerminalGlobalFilterState>({
    projectId: '',
    country: 'US',
    dateFrom: '',
    dateTo: '',
  })

  // 水合：URL > localStorage > 默认值。只在 mount 跑一次（客户端），无 SSR 水合风险。
  React.useEffect(() => {
    const url = readUrlFilter()
    const stored = readStored()
    let country = url.country ?? stored?.country ?? ''
    let dateFrom = url.dateFrom ?? stored?.dateFrom ?? ''
    let dateTo = url.dateTo ?? stored?.dateTo ?? ''
    if (!country) country = 'US'
    if (!dateFrom || !dateTo) {
      const def = defaultGlobalDateRange()
      dateFrom = dateFrom || def.dateFrom
      dateTo = dateTo || def.dateTo
    }
    const next: TerminalGlobalFilterState = {
      projectId: url.projectId ?? stored?.projectId ?? '',
      country,
      dateFrom,
      dateTo,
    }
    setState(next)
    writeStored(next)
    setReady(true)
  }, [])

  // 浏览器前进/后退带 g* 参数时同步（SPA 内部导航不触发，属已知取舍）
  React.useEffect(() => {
    const onPopState = () => {
      const url = readUrlFilter()
      const hasAny =
        url.projectId || url.country || url.dateFrom || url.dateTo
      if (!hasAny) return
      setState((prev) => {
        const next: TerminalGlobalFilterState = {
          projectId: url.projectId ?? prev.projectId,
          country: url.country ?? prev.country,
          dateFrom: url.dateFrom ?? prev.dateFrom,
          dateTo: url.dateTo ?? prev.dateTo,
        }
        writeStored(next)
        return next
      })
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const update = React.useCallback(
    (patch: Partial<TerminalGlobalFilterState>) => {
      setState((prev) => {
        const next = { ...prev, ...patch }
        writeStored(next)
        return next
      })
      // URL 同步：只动 patch 涉及的 g* 键，其余 query（页面自己的 project/country 等）原样保留
      const params = new URLSearchParams(
        typeof window === 'undefined' ? '' : window.location.search
      )
      for (const key of Object.keys(patch) as Array<keyof TerminalGlobalFilterState>) {
        const urlKey = GLOBAL_FILTER_URL_KEYS[key]
        const value = patch[key]
        if (value) {
          params.set(urlKey, value)
        } else {
          params.delete(urlKey)
        }
      }
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [pathname, router]
  )

  const setProjectId = React.useCallback(
    (v: string) => update({ projectId: v }),
    [update]
  )
  const setCountry = React.useCallback((v: string) => update({ country: v }), [update])
  const setDateRange = React.useCallback(
    (from: string, to: string) => update({ dateFrom: from, dateTo: to }),
    [update]
  )

  const value = React.useMemo<TerminalGlobalFilterContextValue>(
    () => ({ ...state, ready, setProjectId, setCountry, setDateRange }),
    [state, ready, setProjectId, setCountry, setDateRange]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** 消费全局筛选状态；必须在 TerminalGlobalFilterProvider 内使用 */
export function useTerminalGlobalFilter(): TerminalGlobalFilterContextValue {
  const ctx = React.useContext(Ctx)
  if (!ctx) {
    throw new Error('useTerminalGlobalFilter 必须在 TerminalGlobalFilterProvider 内使用')
  }
  return ctx
}
