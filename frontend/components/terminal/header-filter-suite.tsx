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
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cva, type VariantProps } from 'class-variance-authority'

/**
 * BLF-819 · Top Header 全局筛选四件套（BLF-887 高度上档：h-10 终端规格）。
 *
 * 与 BLF-817 Console 工具栏同源的控件基类：h-10、零圆角、1px 边界、等宽字体。
 * 数据经 useTerminalGlobalFilter 读写（URL + localStorage 双持久化），
 * 组件自身不持有业务状态 —— 同一状态在头部与试点页之间天然同步。
 */

export const TERM_HEADER_TRIGGER =
  'h-10 shrink-0 overflow-hidden rounded-none border border-term-border bg-term-bg font-mono text-sm font-normal text-term-text shadow-none focus:ring-0 focus:ring-offset-0 data-[state=open]:border-term-border-strong [&>span]:truncate'
/** 操作区 4 档固定宽度（Stage 4 三区标准）：SM=站点 / MD=项目 / LG=SKU / XL=日期 */
export const TERM_HEADER_W_SM = 'w-[130px]'
export const TERM_HEADER_W_MD = 'w-[150px]'
export const TERM_HEADER_W_LG = 'w-[200px]'
export const TERM_HEADER_W_XL = 'w-[240px]'
/** Select 弹层统一样式（终端化：零圆角、term 边界/面板） */
export const TERM_SELECT_CONTENT =
  'rounded-none border border-term-border bg-term-panel text-term-text shadow-lg'
const TERM_SELECT_ITEM = 'rounded-none text-sm focus:bg-term-hover focus:text-term-text'

// ======================== ProjectSelect ========================

type ManagedProjectOption = { id: number; name: string; country?: string; country_name?: string | null }

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
    <Select value={value} onValueChange={onChange} disabled={loading}>
      <SelectTrigger className={cn(TERM_HEADER_TRIGGER, TERM_HEADER_W_MD)} title="全局项目筛选">
        <SelectValue placeholder={loading ? '加载中…' : '选择项目'} />
      </SelectTrigger>
      <SelectContent className={cn(TERM_SELECT_CONTENT, 'max-h-[60vh] overflow-y-auto term-scroll')}>
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
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn(TERM_HEADER_TRIGGER, TERM_HEADER_W_SM)} title="全局站点筛选">
        <SelectValue placeholder="选择站点" />
      </SelectTrigger>
      <SelectContent className={cn(TERM_SELECT_CONTENT, 'max-h-[60vh] overflow-y-auto term-scroll')}>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className={TERM_SELECT_ITEM}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
    <DateRangePicker
      value={range}
      timezone={COUNTRY_TIMEZONE_MAP[country === 'ALL' ? 'US' : country]}
      onChange={(next?: DateRange) => {
        onChange(formatDateInputValue(next?.from), formatDateInputValue(next?.to))
      }}
      placeholder="选择日期范围"
      className={cn(TERM_HEADER_TRIGGER, TERM_HEADER_W_XL, 'justify-start px-2 text-left')}
    />
  )
}

// ======================== 页面插槽泛型控件 ========================

/**
 * 页面插槽泛型下拉（term 规格）。
 *
 * 与全局四件套 HeaderProjectSelect/HeaderCountrySelect 的区别：选项集合由页面传入，
 * 保持页面原生选项集（例如某页站点只有 US/DE/UK、不带 ALL），不做全局假设。
 * 宽度默认取项目档（W_MD），页面按控件语义传 SM/MD/LG/XL。
 */
export function HeaderSlotSelect({
  value,
  options,
  onChange,
  widthClass = TERM_HEADER_W_MD,
  placeholder,
  disabled,
  title,
}: {
  value: string
  options: Array<{ value: string; label: string; disabled?: boolean }>
  onChange: (v: string) => void
  widthClass?: string
  placeholder?: string
  disabled?: boolean
  title?: string
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={cn(TERM_HEADER_TRIGGER, widthClass)} title={title}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={cn(TERM_SELECT_CONTENT, 'max-h-[60vh] overflow-y-auto term-scroll')}>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled} className={TERM_SELECT_ITEM}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * 页面插槽日期范围（term 规格）：复用 ui/date-picker 的 DateRangePicker（自带预设侧栏），
 * timezone / onApply 透传（onApply 供「应用后再拉数」的页面语义）。
 */
export function HeaderSlotDateRange({
  value,
  onChange,
  onApply,
  timezone,
  widthClass = TERM_HEADER_W_XL,
  placeholder = '选择日期范围',
}: {
  value: React.ComponentProps<typeof DateRangePicker>['value']
  onChange: (range: React.ComponentProps<typeof DateRangePicker>['value']) => void
  onApply?: () => void
  timezone?: string
  widthClass?: string
  placeholder?: string
}) {
  return (
    <DateRangePicker
      value={value}
      timezone={timezone}
      onChange={onChange}
      onApply={onApply}
      placeholder={placeholder}
      className={cn(TERM_HEADER_TRIGGER, widthClass, 'justify-start px-2 text-left')}
    />
  )
}

// 已移除：HeaderKpiTile 已于 BLF-874 下线（正文 MetricSwitcherCard 已覆盖三磁贴），
// 保留空壳仅作历史测试兼容（head 三区已无固定区 KPI 元素）。
export function HeaderKpiTile() {
  return null
}
// ======================== BLF-997 共享插槽原子 ========================

/** HeaderSlotButton 变体 */
const headerSlotButtonVariants = cva(
  'h-10 rounded-none px-3 font-mono text-xs leading-5 border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
        muted:
          'border-term-border bg-term-panel text-term-text hover:border-term-border-strong hover:bg-term-hover hover:text-term-text',
      },
    },
    defaultVariants: {
      variant: 'muted',
    },
  }
)

export interface HeaderSlotButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'variant'> {
  variant?: 'primary' | 'muted'
}

/**
 * 头部插槽按钮：h-10、rounded-none、px-3，支持 primary/muted 变体。
 * variant 映射到 Button 的底层变体（primary→default, muted→outline），
 * 自定义样式由 headerSlotButtonVariants 叠加；不拥有业务状态。
 */
export function HeaderSlotButton({
  variant = 'muted',
  className,
  ...props
}: HeaderSlotButtonProps) {
  const buttonVariant: 'default' | 'outline' = variant === 'primary' ? 'default' : 'outline'
  return (
    <Button variant={buttonVariant} className={cn(headerSlotButtonVariants({ variant, className }))} {...props} />
  )
}

export { headerSlotButtonVariants }

/** HeaderSlotInput 宽度类映射（复用现有 W_ 常量） */
export interface HeaderSlotInputProps
  extends Omit<React.ComponentProps<'input'>, 'size'> {
  widthClass?: string
}

/**
 * 头部插槽输入框：封装 Input size="lg"，拥有 TERM_HEADER_TRIGGER 兼容的
 * 边界/高度与 widthClass；不拥有业务状态。
 */
export function HeaderSlotInput({
  widthClass,
  className,
  ...props
}: HeaderSlotInputProps) {
  return (
    <Input
      size="lg"
      className={cn(TERM_HEADER_TRIGGER, widthClass, className)}
      {...props}
    />
  )
}


/**
 * 头部插槽徽章：只读 h-10 边界容器，用于紧凑上下文元数据。
 * 使用 term 文本类；不拥有业务状态。
 */
export function HeaderSlotBadge({
  className,
  children,
  title,
}: {
  className?: string
  children: React.ReactNode
  title?: string
}) {
  return (
    <div
      className={cn(
        'h-10 shrink-0 rounded-none border border-term-border bg-term-panel px-2 font-mono text-sm text-term-text',
        className,
      )}
      title={title}
    >
      {children}
    </div>
  )
}
