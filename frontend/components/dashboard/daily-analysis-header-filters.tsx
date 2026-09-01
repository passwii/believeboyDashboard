'use client'

import * as React from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'

import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DateRangePicker, COUNTRY_TIMEZONE_MAP } from '@/components/ui/date-picker'
import { TERM_HEADER_TRIGGER, TERM_HEADER_W_LG, TERM_SELECT_CONTENT } from '@/components/terminal/header-filter-suite'
import { cn } from '@/lib/utils'

/**
 * BLF-832 follow-up · daily-analysis 头部筛选去重与原子化。
 *
 * 背景：BLF-819 在试点路由的 Top Header 渲染全局四件套（项目 / 站点 / 日期），
 * BLF-826 又让本页把旧 console 风格的同名三件套 portal 进 HeaderSlot 中段 ——
 * xl+ 视口两套并存，视觉重复。本组件收编为单一插槽内容：
 *
 * - SKU 搜索（页面独有维度，全局筛选没有）：升级为 TERM_HEADER_TRIGGER 同源
 *   终端规格（h-9 零圆角 mono），带 mono 大写「SKU」标签，语言与全局四件套一致；
 * - 项目 / 站点 / 日期：xl+ 隐藏（由全局四件套承担）；md~xl 全局四件套不渲染
 *   （HeaderProjectSelect 区 xl:flex、插槽容器 hidden md:flex），保留降级三件套兜底；
 * - <md：HeaderFilterControls 折叠为「筛选」Popover 的行为不变。
 */

export type ProjectSkuOption = {
  sku: string
  asin: string | null
  fnsku: string | null
  product_name: string | null
  units_per_carton: number
  carton_length_cm: number | null
  carton_width_cm: number | null
  carton_height_cm: number | null
  carton_weight_kg: number | null
  is_active: boolean
}
type SkuSearchFieldProps = {
  value: string
  options: ProjectSkuOption[]
  loading: boolean
  onChange: (value: string) => void
  disabled?: boolean
  /** 打开选择器时回调（父级据此懒加载 SKU 列表）。 */
  onOpen?: () => void
  /** 宽度类覆盖：默认 TERM_HEADER_W_LG（w-[200px]）；移动端折叠条内传 w-full。 */
  widthClass?: string
}

/**
 * SKU 搜索选择器（原 SearchableSkuField 终端化版本）：
 * trigger 用头部标准控件规格（h-9 零圆角 term-bg + mono 标签），
 * 弹层仍走 Dialog + Command 全屏搜索（SKU 量大时的既有交互）。
 */
export function SkuSearchField({
  value,
  options,
  loading,
  onChange,
  disabled = false,
  onOpen,
  widthClass = TERM_HEADER_W_LG,
}: SkuSearchFieldProps) {
  const [open, setOpen] = React.useState(false)
  const selectedSku = options.find((option) => option.sku === value)

  const handleOpen = () => {
    if (disabled) return
    setOpen(true)
    onOpen?.()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (disabled ? setOpen(false) : setOpen(next))}>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          title="搜索并选择 SKU（清空即恢复全部 SKU）"
          className={cn(
            TERM_HEADER_TRIGGER,
            widthClass,
            'justify-between px-2 font-mono font-normal shadow-none',
            disabled && 'cursor-not-allowed opacity-50'
          )}
          onClick={handleOpen}
        >
          <span className="truncate text-left">
            {selectedSku ? (
              selectedSku.product_name ? (
                <>
                  {selectedSku.sku}
                  <span className="ml-1.5 hidden truncate text-term-faint lg:inline">
                    / {selectedSku.product_name}
                  </span>
                </>
              ) : (
                selectedSku.sku
              )
            ) : loading ? (
              'SKU 加载中...'
            ) : (
              '全部 SKU'
            )}
          </span>
          <ChevronsUpDown className="shrink-0 opacity-50" />
        </Button>
        <DialogContent
          aria-describedby="sku-search-dialog-description"
          className="overflow-hidden rounded-none border border-term-border bg-term-panel p-0 text-term-text sm:max-w-xl"
        >
          <span id="sku-search-dialog-description" className="sr-only">
            搜索并选择 SKU
          </span>
          <Command className="max-h-[70vh] bg-term-panel">
            <CommandInput placeholder="搜索 SKU" className="placeholder:text-term-faint" />
            <CommandList className="term-scroll">
              <CommandEmpty>{loading ? 'SKU 加载中...' : '没有匹配的 SKU'}</CommandEmpty>
              <CommandItem
                value="__all__"
                onSelect={() => {
                  onChange('')
                  setOpen(false)
                }}
                className={cn('rounded-none focus:bg-term-hover focus:text-term-text', !value && 'bg-term-hover')}
              >
                <Check className={cn('h-4 w-4 shrink-0', !value ? 'opacity-100' : 'opacity-0')} />
                <span className="font-medium">全部 SKU</span>
              </CommandItem>
              {options.map((option) => {
                const missingUnits = !option.units_per_carton || option.units_per_carton <= 0
                return (
                  <CommandItem
                    key={option.sku}
                    value={option.sku}
                    disabled={missingUnits}
                    onSelect={() => {
                      if (!missingUnits) {
                        onChange(option.sku)
                        setOpen(false)
                      }
                    }}
                    className={cn('rounded-none focus:bg-term-hover focus:text-term-text', missingUnits && 'cursor-not-allowed opacity-50')}
                  >
                    <Check
                      className={cn(
                        'h-4 w-4 shrink-0',
                        value === option.sku ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="flex-1 truncate font-medium">{option.sku}</span>
                      {option.product_name && (
                        <span className="max-w-[200px] shrink-0 truncate text-xs text-muted-foreground">
                          {option.product_name}
                        </span>
                      )}
                      {missingUnits && (
                        <span className="shrink-0 rounded bg-term-warn/10 px-1 py-0.5 text-[10px] font-medium text-term-warn">
                          未维护单箱数
                        </span>
                      )}
                    </div>
                  </CommandItem>
                )
              })}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
  )
}

/**
 * md~xl 降级三件套（项目 / 站点 / 日期）：仅在该区间渲染（父级传 `xl:hidden` 容器）。
 * xl+ 由 Top Header 全局四件套（BLF-819）承担同名筛选，避免重复控制台。
 * 数据经 props 与页面共享真相源，页面内改动 / 头部同步 effect 均不受影响。
 */
export function LegacyFallbackFilters({
  projectId,
  projects,
  country,
  dateRange,
  onProjectChange,
  onCountryChange,
  onDateRangeChange,
  onDateApply,
}: {
  projectId: string
  projects: Array<{ id: number; name: string }>
  country: string
  dateRange: React.ComponentProps<typeof DateRangePicker>['value']
  onProjectChange: (v: string) => void
  onCountryChange: (v: string) => void
  onDateRangeChange: (range: React.ComponentProps<typeof DateRangePicker>['value']) => void
  /** 日期应用时回调（页面据此重新拉数）。 */
  onDateApply: () => void
}) {
  return (
    <>
      <Select value={projectId} onValueChange={onProjectChange}>
        <SelectTrigger className={cn(TERM_HEADER_TRIGGER, 'w-[150px] shrink-0 overflow-hidden')}>
          <SelectValue placeholder="选择项目" />
        </SelectTrigger>
        <SelectContent className={TERM_SELECT_CONTENT}>
          <SelectItem value="all" className="rounded-none text-sm focus:bg-term-hover focus:text-term-text">全部项目</SelectItem>
          {projects.map((item) => (
            <SelectItem key={item.id} value={String(item.id)} className="rounded-none text-sm focus:bg-term-hover focus:text-term-text">
              {item.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* 站点选择：选项集合与 HeaderCountrySelect 一致（全部站点 + US/DE/UK） */}
      <Select value={country} onValueChange={onCountryChange}>
        <SelectTrigger className={cn(TERM_HEADER_TRIGGER, 'w-[130px] shrink-0 overflow-hidden')}>
          <SelectValue placeholder="选择站点" />
        </SelectTrigger>
        <SelectContent className={cn(TERM_SELECT_CONTENT, 'max-h-[60vh] overflow-y-auto term-scroll')}>
          <SelectItem value="ALL" className="rounded-none text-sm focus:bg-term-hover focus:text-term-text">全部站点</SelectItem>
          <SelectItem value="US" className="rounded-none text-sm focus:bg-term-hover focus:text-term-text">美国站 (US)</SelectItem>
          <SelectItem value="DE" className="rounded-none text-sm focus:bg-term-hover focus:text-term-text">德国站 (DE)</SelectItem>
          <SelectItem value="UK" className="rounded-none text-sm focus:bg-term-hover focus:text-term-text">英国站 (UK)</SelectItem>
        </SelectContent>
      </Select>
      <DateRangePicker
        value={dateRange}
        onChange={onDateRangeChange}
        placeholder="选择日期范围"
        className={cn(TERM_HEADER_TRIGGER, 'w-[240px] shrink-0 justify-start px-2 text-left shadow-none')}
        timezone={COUNTRY_TIMEZONE_MAP[country]}
        onApply={onDateApply}
      />
    </>
  )
}
