'use client'

import * as React from 'react'
import {
  Banknote,
  BarChart3,
  Bot,
  Calculator,
  ChartColumnBig,
  Check,
  ClipboardCheck,
  ClipboardList,
  DollarSign,
  Edit3,
  FileText,
  LayoutDashboard,
  Layers,
  Package,
  Repeat2,
  RotateCcw,
  Search,
  Shield,
  Shell,
  ShoppingCart,
  Store,
  TrendingUp,
  Truck,
  Warehouse,
  Zap,
} from 'lucide-react'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const STORAGE_KEY = 'believeboy-sidebar-pinned-v1'
export const MAX_PINNED = 10

export function useLongPress(duration = 500) {
  const [active, setActive] = React.useState(false)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRef = React.useRef(false)

  const start = React.useCallback(() => {
    timerRef.current = setTimeout(() => {
      activeRef.current = true
      setActive(true)
    }, duration)
  }, [duration])

  const stop = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (activeRef.current) {
      // Keep visible for a while after release so user can interact
      setTimeout(() => {
        activeRef.current = false
        setActive(false)
      }, 3000)
    }
  }, [])

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return {
    editVisible: active,
    handlers: {
      onPointerDown: start,
      onPointerUp: stop,
      onPointerLeave: stop,
    },
  }
}

type RoleType = 'admin' | 'businessdev' | string

type PinnedItem = {
  title: string
  url: string
  icon: React.ReactNode
  roles?: RoleType[] // undefined = visible to all
}

export const ALL_ITEMS: PinnedItem[] = [
  // 运营导航
  {
    title: '站点导航',
    url: '/dashboard/operations/site-navigation',
    icon: <LayoutDashboard className='h-4 w-4' />,
  },
  {
    title: '店铺导航',
    url: '/dashboard/operations/store-navigation',
    icon: <Store className='h-4 w-4' />,
  },
  // AI 面板
  {
    title: 'AI 洞察',
    url: '/dashboard/ai-insights',
    icon: <Bot className='h-4 w-4' />,
  },
  // 运营核算
  {
    title: '财务月报',
    url: '/dashboard/data-reporting/monthly-report',
    icon: <Calculator className='h-4 w-4' />,
  },
  {
    title: '产品分析',
    url: '/dashboard/data-reporting/product-analysis',
    icon: <BarChart3 className='h-4 w-4' />,
  },
  {
    title: '新品核算',
    url: '/dashboard/data-reporting/pricing-calculation/new-product',
    icon: <Calculator className='h-4 w-4' />,
  },
  {
    title: '店铺测算',
    url: '/dashboard/data-reporting/pricing-calculation/shop-calculation',
    icon: <ShoppingCart className='h-4 w-4' />,
  },
  // 数据分析
  {
    title: '销售数据',
    url: '/dashboard/data-analysis/daily-analysis',
    icon: <TrendingUp className='h-4 w-4' />,
  },
  {
    title: '广告分析',
    url: '/dashboard/data-analysis/ad-analysis/overview',
    icon: <BarChart3 className='h-4 w-4' />,
  },
  {
    title: '月度财务分析',
    url: '/dashboard/data-analysis/financial-data',
    icon: <DollarSign className='h-4 w-4' />,
  },
  {
    title: '按周产品分析',
    url: '/dashboard/data-analysis/weekly-product-analysis',
    icon: <BarChart3 className='h-4 w-4' />,
  },
  {
    title: '库存分析',
    url: '/dashboard/data-analysis/inventory-analysis',
    icon: <Warehouse className='h-4 w-4' />,
  },
  {
    title: '补货分析',
    url: '/dashboard/data-analysis/inventory-replenishment',
    icon: <Repeat2 className='h-4 w-4' />,
  },
  {
    title: '退货分析',
    url: '/dashboard/data-analysis/return-analysis',
    icon: <RotateCcw className='h-4 w-4' />,
  },
  {
    title: '组合分析',
    url: '/dashboard/data-analysis/portfolio-overview',
    icon: <Layers className='h-4 w-4' />,
  },
  {
    title: '项目目标',
    url: '/dashboard/data-analysis/project-goals',
    icon: <TrendingUp className='h-4 w-4' />,
  },
  // 数据管理
  {
    title: '发货管理',
    url: '/dashboard/data-management/shipment-management',
    icon: <Package className='h-4 w-4' />,
  },
  {
    title: 'SKU 信息',
    url: '/dashboard/data-management/sku-info',
    icon: <FileText className='h-4 w-4' />,
  },
  {
    title: '报表核对',
    url: '/dashboard/data-management/report-reconciliation',
    icon: <ClipboardCheck className='h-4 w-4' />,
  },
  {
    title: '平台巡检',
    url: '/dashboard/data-management/platform-inspection',
    icon: <Shield className='h-4 w-4' />,
  },
  {
    title: '汇率信息',
    url: '/dashboard/data-management/exchange-rate',
    icon: <DollarSign className='h-4 w-4' />,
  },
  {
    title: '平台回款',
    url: '/dashboard/data-management/platform-revenue',
    icon: <Banknote className='h-4 w-4' />,
  },
  {
    title: '报表自动化',
    url: '/dashboard/data-management/auto-upload',
    icon: <Zap className='h-4 w-4' />,
  },
  // 工具集
  {
    title: '调研分析',
    url: '/dashboard/tools/research-analysis',
    icon: <Search className='h-4 w-4' />,
  },
  // 数字员工 (admin only)
  {
    title: '数字员工',
    url: '/dashboard/digital-employees',
    icon: <Bot className='h-4 w-4' />,
    roles: ['admin'],
  },
  // 系统管理 (admin only)
  {
    title: '定时报告',
    url: '/dashboard/system-management/scheduled-reports',
    icon: <Zap className='h-4 w-4' />,
    roles: ['admin'],
  },
]

const DEFAULT_PINNED_URLS = [
  '/dashboard/data-management/shipment-management',
  '/dashboard/data-analysis/daily-analysis',
]

function loadPinnedUrls(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as string[]
      if (Array.isArray(parsed) && parsed.every((u) => typeof u === 'string')) {
        return parsed
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_PINNED_URLS
}

function savePinnedUrls(urls: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(urls))
  } catch {
    // ignore
  }
}

export function useSidebarPinnedItems() {
  const [pinnedUrls, setPinnedUrls] = React.useState<string[]>(DEFAULT_PINNED_URLS)
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setPinnedUrls(loadPinnedUrls())
    setMounted(true)
  }, [])

  const toggle = React.useCallback((url: string) => {
    setPinnedUrls((prev) => {
      const next = prev.includes(url) ? prev.filter((u) => u !== url) : prev.length < MAX_PINNED ? [...prev, url] : prev
      savePinnedUrls(next)
      return next
    })
  }, [])

  return { pinnedUrls, toggle, maxPinned: MAX_PINNED, mounted }
}

export function getVisibleItems(roleType?: RoleType): PinnedItem[] {
  return ALL_ITEMS.filter(
    (item) => !item.roles || item.roles.includes(roleType as RoleType)
  )
}

export function useVisiblePinnedUrls(urls: string[], roleType?: RoleType): string[] {
  return React.useMemo(() => {
    const visible = getVisibleItems(roleType)
    const visibleUrls = new Set(visible.map((i) => i.url))
    return urls.filter((u) => visibleUrls.has(u))
  }, [urls, roleType])
}

function PinSettingsContent({
  pinnedUrls,
  onToggle,
  roleType,
}: {
  pinnedUrls: string[]
  onToggle: (url: string) => void
  roleType?: RoleType
}) {
  const visibleItems = getVisibleItems(roleType)
  const visiblePinnedCount = pinnedUrls.filter((u) =>
    visibleItems.some((i) => i.url === u)
  ).length
  const atMax = visiblePinnedCount >= MAX_PINNED

  return (
    <div className='flex flex-col gap-1'>
      <div className='mb-2 flex items-center justify-between'>
        <span className='text-[0.82rem] font-semibold text-foreground'>
          快捷入口设置
        </span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[0.7rem] font-medium',
            atMax
              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
              : 'bg-muted text-muted-foreground'
          )}
        >
          {visiblePinnedCount}/{MAX_PINNED}
        </span>
      </div>
      <div className='flex flex-col gap-0.5'>
        {visibleItems.map((item) => {
          const isPinned = pinnedUrls.includes(item.url)
          const disabled = !isPinned && atMax
          return (
            <button
              key={item.url}
              type='button'
              disabled={disabled}
              onClick={() => !disabled && onToggle(item.url)}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2 py-2 text-left text-[0.82rem] transition-colors',
                disabled
                  ? 'cursor-not-allowed opacity-40'
                  : 'hover:bg-accent cursor-pointer'
              )}
            >
              <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border/60 bg-muted/60 text-muted-foreground'>
                {item.icon}
              </span>
              <span className='min-w-0 flex-1 truncate text-foreground'>{item.title}</span>
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
                  isPinned
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background'
                )}
              >
                {isPinned && <Check className='h-3 w-3' />}
              </span>
            </button>
          )
        })}
      </div>
      {atMax && (
        <p className='mt-1 text-center text-[0.72rem] text-muted-foreground'>
          最多 {MAX_PINNED} 个快捷入口，已达上限
        </p>
      )}
    </div>
  )
}

export function PinSettingsPopover({
  pinnedUrls,
  onToggle,
  roleType,
  trigger,
}: {
  pinnedUrls: string[]
  onToggle: (url: string) => void
  roleType?: RoleType
  trigger: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side='right'
        align='start'
        sideOffset={8}
        className='w-64 p-3'
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <PinSettingsContent pinnedUrls={pinnedUrls} onToggle={onToggle} roleType={roleType} />
      </PopoverContent>
    </Popover>
  )
}

export function SidebarPinnedItem({
  url,
  title,
  pinnedUrls,
  onToggle,
  roleType,
  editVisible,
}: {
  url: string
  title: string
  pinnedUrls: string[]
  onToggle: (url: string) => void
  roleType?: RoleType
  editVisible: boolean
}) {
  const [editOpen, setEditOpen] = React.useState(false)

  return (
    <Popover open={editOpen} onOpenChange={setEditOpen}>
      <PopoverTrigger asChild>
        <div className='group relative'>
          <RouteLoadingLink
            href={url}
            className='flex h-11 w-11 min-w-touch items-center justify-center rounded-[0.65rem] border border-[hsl(var(--sidebar-foreground)/0.08)] bg-[hsl(var(--sidebar-foreground)/0.03)] text-sidebar-foreground/72 shadow-none transition-all duration-200 hover:bg-[hsl(var(--sidebar-foreground)/0.08)] hover:text-sidebar-foreground group-data-[collapsible=icon]:hidden'
            title={title}
          >
            {ALL_ITEMS.find((item) => item.url === url)?.icon}
          </RouteLoadingLink>
          <button
            type='button'
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setEditOpen(true)
            }}
            className={cn(
              'absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded border border-[hsl(var(--sidebar-foreground)/0.12)] bg-[hsl(var(--surface-overlay))] text-sidebar-foreground/50 shadow-sm transition-opacity duration-200 hover:text-sidebar-foreground group-data-[collapsible=icon]:hidden',
              editVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
            )}
            title='编辑快捷入口'
          >
            <Edit3 className='h-3 w-3' />
          </button>
        </div>
      </PopoverTrigger>
      <PopoverContent
        side='right'
        align='start'
        sideOffset={8}
        className='w-64 p-3'
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <PinSettingsContent pinnedUrls={pinnedUrls} onToggle={onToggle} roleType={roleType} />
      </PopoverContent>
    </Popover>
  )
}
