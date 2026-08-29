'use client'

import { useEffect, useState } from 'react'
import type { DateRange } from 'react-day-picker'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

import {
  COUNTRY_TIMEZONE_MAP,
  formatDateInputValue,
  parseDateRangeInputValue,
} from '@/components/ui/date-picker'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import {
  HeaderSlotDateRange,
  HeaderSlotSelect,
  TERM_HEADER_W_MD,
  TERM_HEADER_W_SM,
  TERM_HEADER_W_XL,
} from '@/components/terminal/header-filter-suite'
import { Skeleton } from '@/components/ui/skeleton'
import { TermPill } from '@/components/terminal/term-controls'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  useHeaderRefresh,
  useHeaderSlot,
} from '@/components/terminal/terminal-header-slot'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

type ProjectOption = {
  id: number
  name: string
}

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

const DRILL_PARAM_LABELS = {
  campaign: '活动',
  focusDate: '聚焦日期',
  placement: '广告位',
  purchasedAsin: '关联 ASIN',
  searchTerm: '搜索词',
  sku: 'SKU',
  targetText: '投放',
} as const

function buildHref(pathname: string, searchParams: URLSearchParams) {
  const query = searchParams.toString()
  return query ? `${pathname}?${query}` : pathname
}

/**
 * BLF-889 · 广告分析页筛选上移 Top Header 中段插槽。
 *
 * 原页面级「广告分析筛选区」TermPanel（视图/项目/站点/日期只读胶囊 + 筛选控件
 * + 说明文案）与头部控件信息完全重复，按 BLF-824/826 范式收敛：
 * - 项目 / 站点 / 日期控件 portal 进 TerminalHeader（HeaderFilterControls 统一形态，
 *   移动端自动折叠为「筛选」Popover）；
 * - 下钻 token（活动/SKU/搜索词等）只在存在下钻参数时以 accent pill + 清空按钮
 *   出现在插槽尾部，无下钻时零占位；
 * - 页面内不再渲染任何筛选区块。
 *
 * URL param 契约不变：projectId / country / dateFrom / dateTo + 下钻参数，
 * 下游 10 个子页 client 零改动消费。刷新语义：清 2min 客户端缓存后强刷
 * 当前路由（子页 effect 按 URL 参数重取）。
 */
export function AdAnalysisTopFilters() {
  const { data: session } = useSession()
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const isMobile = useIsMobile()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const drillTokens: Array<{ key: string; label: string; value: string }> = []
  Object.entries(DRILL_PARAM_LABELS).forEach(([key, label]) => {
    const value = searchParams.get(key)
    if (value) drillTokens.push({ key, label, value })
  })

  useEffect(() => {
    let active = true

    async function loadProjects() {
      setProjectsLoading(true)
      setProjectsError(null)
      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (!active) return
        setProjects(payload)
        if (!projectId && payload[0]?.id) {
          const next = new URLSearchParams(searchParams.toString())
          next.set('projectId', String(payload[0].id))
          if (!next.get('country')) next.set('country', country)
          router.replace(buildHref(pathname, next), { scroll: false })
        }
      } catch (error) {
        if (!active) return
        setProjectsError(error instanceof Error ? error.message : '项目列表加载失败')
      } finally {
        if (active) setProjectsLoading(false)
      }
    }

    void loadProjects()
    return () => {
      active = false
    }
  }, [country, pathname, projectId, router, searchParams, session])

  const replaceSearchParams = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams.toString())
    mutate(next)
    router.replace(buildHref(pathname, next), { scroll: false })
  }

  const updateSearchParam = (key: 'projectId' | 'country', value: string) => {
    replaceSearchParams((next) => {
      if (value) next.set(key, value)
      else next.delete(key)
    })
  }

  const updateDateRange = (range?: DateRange) => {
    replaceSearchParams((next) => {
      const nextDateFrom = formatDateInputValue(range?.from)
      const nextDateTo = formatDateInputValue(range?.to)
      if (nextDateFrom) next.set('dateFrom', nextDateFrom)
      else next.delete('dateFrom')
      if (nextDateTo) next.set('dateTo', nextDateTo)
      else next.delete('dateTo')
    })
  }

  const clearDrillParams = () => {
    replaceSearchParams((next) => {
      Object.keys(DRILL_PARAM_LABELS).forEach((key) => next.delete(key))
    })
  }

  // 刷新语义：清 2min 客户端缓存后 router.refresh —— 子页 effect 依 URL 参数重取，
  // 等价于「当前筛选条件下的强刷」。
  useHeaderRefresh(() => router.refresh())

  const controls = (
    <>
      {projectsLoading ? (
        <Skeleton className="h-10 w-full rounded-none md:w-[150px]" />
      ) : (
        <HeaderSlotSelect
          value={projectId}
          onChange={(value) => updateSearchParam('projectId', value)}
          options={projects.map((item) => ({ value: String(item.id), label: item.name }))}
          placeholder="选择项目"
          widthClass={TERM_HEADER_W_MD}
          title="项目筛选"
        />
      )}

      <HeaderSlotSelect
        value={country}
        onChange={(value) => updateSearchParam('country', value)}
        options={COUNTRY_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
        placeholder="选择站点"
        widthClass={TERM_HEADER_W_SM}
        title="站点筛选"
      />

      <HeaderSlotDateRange
        value={parseDateRangeInputValue(dateFrom, dateTo)}
        onChange={updateDateRange}
        timezone={COUNTRY_TIMEZONE_MAP[country]}
        widthClass={TERM_HEADER_W_XL}
      />

      {drillTokens.length > 0 && (
        <div className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden">
          {drillTokens.map((item) => (
            <TermPill key={item.key} tone="accent" className="shrink-0">
              {item.label}：{item.value}
            </TermPill>
          ))}
          <button
            type="button"
            onClick={clearDrillParams}
            className="flex h-10 shrink-0 items-center rounded-none border border-term-border bg-term-panel px-2 font-mono text-xs text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
          >
            清空下钻
          </button>
        </div>
      )}

      {projectsError && (
        <span className="flex h-10 shrink-0 items-center border border-term-neg/50 bg-term-neg/10 px-2 font-mono text-xs text-term-neg">
          {projectsError}
        </span>
      )}
    </>
  )

  return <AdAnalysisHeaderFilters controls={controls} isMobile={isMobile} />
}

/** portal 渲染宿主（useHeaderSlot 必须在组件体内调用） */
function AdAnalysisHeaderFilters({
  controls,
  isMobile,
}: {
  controls: React.ReactNode
  isMobile: boolean
}) {
  const portal = useHeaderSlot(<HeaderFilterControls isMobileView={isMobile} controls={controls} />)
  return <>{portal}</>
}
