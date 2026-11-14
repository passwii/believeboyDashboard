'use client'

import * as React from 'react'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'

import { cn } from '@/lib/utils'

interface MobileFilterStripProps {
  /**
   * 折叠态显示的当前筛选摘要（如 "玥涵 · US · 06/01~09/01"）。
   * 由页面根据当前筛选值自行构造。
   */
  summary: React.ReactNode
  /** 展开态显示的筛选控件，直接放入 grid-cols-2 网格 */
  controls: React.ReactNode
  /** 初始展开状态（默认折叠） */
  defaultOpen?: boolean
  /** 受控展开状态 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  /**
   * 设计系统风格变体：
   * - 'terminal'（默认）：历史 Terminal 规范，使用 term-* 令牌
   * - 'warm-ledger'：V4 Warm Ledger 规范（design-spec.md §0.4），使用 --warm-ledger-* 令牌，浅色/深色主题一致
   */
  variant?: 'terminal' | 'warm-ledger'
}

/**
 * BLF-933 · 移动端可折叠筛选条（Collapsible Filter Strip）。
 *
 * 折叠态：筛选图标 + 当前筛选摘要 + 展开按钮（ChevronDown）。
 * 展开态：`grid-cols-2` 网格布局，短控件各占 1/2，宽控件用 `MobileFilterWide` 占整行。
 *
 * 风格与 Terminal 终端一致：1px border / 零圆角 / term-* 色组 / mono 数值。
 * 触控目标 ≥44px（MOBILE_ADAPTATION_RULES.md 规则 5）。
 *
 * ```tsx
 * <MobileFilterStrip summary="玥涵 · US · 06/01~09/01">
 *   <HeaderProjectSelect ... />
 *   <HeaderCountrySelect ... />
 *   <MobileFilterWide><HeaderDateRangePicker ... /></MobileFilterWide>
 *   <MobileFilterWide><SkuSearch ... /></MobileFilterWide>
 * </MobileFilterStrip>
 * ```
 */
export function MobileFilterStrip({
  summary,
  controls,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  className,
  variant = 'terminal',
}: MobileFilterStripProps) {
  const isWarm = variant === 'warm-ledger'
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
  const isControlled = controlledOpen !== undefined
  const isOpen = isControlled ? controlledOpen : internalOpen
  const stripId = React.useId()

  const toggle = React.useCallback(() => {
    if (isControlled) {
      onOpenChange?.(!isOpen)
    } else {
      setInternalOpen((v) => !v)
    }
  }, [isControlled, isOpen, onOpenChange])

  return (
    <section
      className={cn(
        isWarm
          ? 'border-b border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] text-[var(--warm-ledger-color-text)]'
          : 'border-b border-term-border bg-term-panel',
        className
      )}
      data-testid="mobile-filter-strip"
      data-variant={variant}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-controls={stripId}
        aria-label="切换页面筛选"
        className={cn(
          'flex min-h-[44px] w-full items-center gap-2 px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1',
          isWarm
            ? 'text-[var(--warm-ledger-color-text)] hover:bg-[var(--warm-ledger-color-panel-strong)] focus-visible:ring-[var(--warm-ledger-focus-color)]'
            : 'text-term-text hover:bg-term-hover focus-visible:ring-term-accent'
        )}
      >
        <SlidersHorizontal
          className={cn(
            'h-4 w-4 shrink-0',
            isWarm ? 'text-[var(--warm-ledger-color-text-muted)]' : 'text-term-muted'
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-sm">{summary}</span>
        <span
          className={cn(
            'shrink-0 font-mono text-xs',
            isWarm ? 'text-[var(--warm-ledger-color-text-faint)]' : 'text-term-faint'
          )}
        >
          {isOpen ? '收起' : '筛选'}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 transition-transform',
            isWarm ? 'text-[var(--warm-ledger-color-text-muted)]' : 'text-term-muted',
            isOpen && 'rotate-180'
          )}
          aria-hidden
        />
      </button>
      {isOpen && (
        <div
          id={stripId}
          className={cn(
            'grid grid-cols-2 gap-2 p-2',
            isWarm
              ? 'border-t border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-window)]'
              : 'border-t border-term-border'
          )}
          data-testid="mobile-filter-strip-grid"
        >
          {controls}
        </div>
      )}
    </section>
  )
}

/**
 * 宽筛选项容器：占满整行（`col-span-2`）。
 *
 * 在 `grid-cols-2` 布局中，短控件（项目/站点）直接作为 `MobileFilterStrip` 的子元素，
 * 各占 1/2 列；宽控件（日期范围 / SKU 搜索）用 `MobileFilterWide` 包裹，占整行。
 */
export function MobileFilterWide({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('col-span-2 min-w-0', className)} data-testid="mobile-filter-wide">
      {children}
    </div>
  )
}
