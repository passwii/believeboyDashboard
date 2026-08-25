'use client'

import * as React from 'react'
import type { DateRange } from 'react-day-picker'

import {
  DateRangePicker,
  COUNTRY_TIMEZONE_MAP,
  formatDateInputValue,
  parseDateRangeInputValue,
} from '@/components/ui/date-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { COUNTRY_LABELS } from '@/lib/country'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useSession } from 'next-auth/react'
import { cn } from '@/lib/utils'

/**
 * BLF-819 · Top Header 全局筛选四件套（二档放大后 h-9 终端规格）。
 *
 * 与 BLF-817 Console 工具栏同源的控件基类：h-8、零圆角、1px 边界、等宽字体。
 * 数据经 useTerminalGlobalFilter 读写（URL + localStorage 双持久化），
 * 组件自身不持有业务状态 —— 同一状态在头部与试点页之间天然同步。
 */

export const TERM_HEADER_TRIGGER =
  'h-9 rounded-none border-term-border bg-term-bg text-sm text-term-text focus:ring-0 data-[state=open]:border-term-border-strong'
const TERM_SELECT_ITEM = 'rounded-none text-sm focus:bg-term-hover focus:text-term-text'

/** 头部四件套外层标签：11px mono 大写，与 TermGridHeader 同规格 */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="hidden shrink-0 font-mono text-xs uppercase tracking-wider text-term-faint lg:inline">
      {children}
    </span>
  )
}

// ======================== ProjectSelect ========================

type ManagedProjectOption = { id: number; name: string }

/**
 * 头部项目选择器：走 /api/v1/projects/manage（X-Operator 过滤可见项目），
 * 经 fetchManagedProjectsCached 的 2min 客户端缓存，跨页零重复请求。
 * value 为空时自动选中第一个项目（与各页面既有 autoSelectFirst 行为一致）。
 */
export function HeaderProjectSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { data: session, status } = useSession()
  const [projects, setProjects] = React.useState<ManagedProjectOption[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    if (status === 'loading') return
    let active = true
    setLoading(true)
    fetchManagedProjectsCached<ManagedProjectOption[]>(session)
      .then((rows) => {
        if (!active) return
        const valid = rows.filter((r) => typeof r.id === 'number' && r.id > 0)
        setProjects(valid)
        // 空值自动选中第一个项目；'all' 是合法值（全部项目），不覆盖
        if (valid.length > 0 && !value) {
          onChange(String(valid[0].id))
        }
      })
      .catch(() => {
        if (active) setProjects([])
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在 session 就绪时加载一次；value/onChange 变化不应重拉列表
  }, [session, status])

  return (
    <label className="flex items-center gap-1.5">
      <FieldLabel>项目</FieldLabel>
      <Select value={value} onValueChange={onChange} disabled={loading}>
        <SelectTrigger className={cn(TERM_HEADER_TRIGGER, 'w-[150px]')} title="全局项目筛选">
          <SelectValue placeholder={loading ? '加载中…' : '选择项目'} />
        </SelectTrigger>
        <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
          <SelectItem value="all" className={TERM_SELECT_ITEM}>
            全部项目
          </SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={String(p.id)} className={TERM_SELECT_ITEM}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}

// ======================== CountrySelect ========================

/** 头部站点选择器：全站点集合 + ALL 聚合位（轻量下拉，无远程请求） */
export function HeaderCountrySelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const options = React.useMemo(
    () => [
      { value: 'ALL', label: '全部站点' },
      ...Object.entries(COUNTRY_LABELS).map(([code, name]) => ({
        value: code,
        label: `${name} (${code})`,
      })),
    ],
    []
  )

  return (
    <label className="flex items-center gap-1.5">
      <FieldLabel>站点</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className={cn(TERM_HEADER_TRIGGER, 'w-[130px]')} title="全局站点筛选">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-[60vh] overflow-y-auto rounded-none border-term-border bg-term-panel text-term-text term-scroll">
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className={TERM_SELECT_ITEM}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  )
}

// ======================== DateRangePicker ========================

/**
 * 头部日期范围：复用 ui/date-picker 的 DateRangePicker（自带 日/周/月/自定义 预设侧栏），
 * 时区跟随当前站点（COUNTRY_TIMEZONE_MAP）；ALL 站点回退美西（与后端口径一致）。
 * URL 持久化 YYYY-MM-DD 字符串。
 */
export function HeaderDateRangePicker({
  dateFrom,
  dateTo,
  country,
  onChange,
}: {
  dateFrom: string
  dateTo: string
  country: string
  onChange: (from: string, to: string) => void
}) {
  const range = parseDateRangeInputValue(dateFrom, dateTo)

  return (
    <label className="flex items-center gap-1.5">
      <FieldLabel>日期</FieldLabel>
      <DateRangePicker
        value={range}
        timezone={COUNTRY_TIMEZONE_MAP[country === 'ALL' ? 'US' : country]}
        onChange={(next?: DateRange) => {
          onChange(formatDateInputValue(next?.from), formatDateInputValue(next?.to))
        }}
        className="h-9 w-[240px] justify-start rounded-none border-term-border bg-term-bg px-2 text-left font-mono text-sm font-normal text-term-text shadow-none"
      />
    </label>
  )
}

// ======================== KPI 磁贴 ========================

type HeaderKpiTileProps = {
  label: string
  value: string | null
  loading?: boolean
}

/** 头部 KPI 磁贴：今日 GMV / 订单数 / Pending 快报（数据源复用 Footer 的 daily-brief 口径） */
export function HeaderKpiTile({ label, value, loading }: HeaderKpiTileProps) {
  return (
    <div
      className="flex h-9 min-w-0 shrink-0 items-center gap-1.5 border border-term-border bg-term-panel px-2"
      title={`${label}${value != null ? ` · ${value}` : ''}`}
    >
      <span className="shrink-0 font-mono text-xs uppercase tracking-wider text-term-faint">
        {label}
      </span>
      <span
        className={cn(
          'truncate font-mono text-sm tabular-nums',
          value == null ? 'text-term-faint' : 'text-term-text',
          loading && 'animate-pulse'
        )}
      >
        {loading ? '···' : (value ?? '--')}
      </span>
    </div>
  )
}
