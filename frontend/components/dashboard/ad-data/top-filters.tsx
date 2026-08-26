'use client'

import { useEffect, useState } from 'react'
import type { DateRange } from 'react-day-picker'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { SlidersHorizontal } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
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

function buildHref(pathname: string, searchParams: URLSearchParams) {
  const query = searchParams.toString()
  return query ? `${pathname}?${query}` : pathname
}

/** BLF-826 阶段 C：head 筛选插槽内容（<md 折叠为筛选 Popover，≥md 平铺）。 */
function HeaderFilterControls({
  isMobileView,
  controls,
}: {
  isMobileView: boolean
  controls: React.ReactNode
}) {
  if (isMobileView) {
    return (
      <Popover>
        <PopoverTrigger
          className="flex h-8 items-center gap-1 rounded-md border border-term-border bg-term-panel px-2 text-xs text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
          aria-label="页面筛选"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
          筛选
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-[320px] p-3">
          <div className="grid grid-cols-1 gap-3">{controls}</div>
        </PopoverContent>
      </Popover>
    )
  }
  return <div className="flex min-w-0 items-center gap-1.5">{controls}</div>
}

/**
 * BLF-826 阶段 C：广告数据页全局筛选。
 *
 * 原「广告数据筛选区」Card（页面级标题胶囊 + Badge 摘要 + h-10 控件）已按 BLF-824/826
 * 范式上移 Top Header 中段插槽 —— 标题由 TerminalHeader 面包屑承载，Badge 摘要删除
 * （与控件信息重复），控件统一 h-8 终端规格。URL param 契约不变：
 * projectId / country / dateFrom / dateTo，下游 AdDataExplorer 零改动消费。
 */
export function AdDataTopFilters() {
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

  const updateSearchParam = (
    key: 'projectId' | 'country' | 'dateFrom' | 'dateTo',
    value: string
  ) => {
    const next = new URLSearchParams(searchParams.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    router.replace(buildHref(pathname, next), { scroll: false })
  }

  const updateDateRange = (range?: DateRange) => {
    const next = new URLSearchParams(searchParams.toString())
    const nextDateFrom = formatDateInputValue(range?.from)
    const nextDateTo = formatDateInputValue(range?.to)
    if (nextDateFrom) next.set('dateFrom', nextDateFrom)
    else next.delete('dateFrom')
    if (nextDateTo) next.set('dateTo', nextDateTo)
    else next.delete('dateTo')
    router.replace(buildHref(pathname, next), { scroll: false })
  }

  // 全局刷新语义：重放当前 URL 筛选下的拉取（router.replace 同 href 触发 explorer 重取）。
  useHeaderRefresh(() => router.refresh())

  const controls = (
    <>
      {projectsLoading ? (
        <Skeleton className="h-8 w-full rounded-none md:w-[150px]" />
      ) : (
        <Select value={projectId} onValueChange={(value) => updateSearchParam('projectId', value)}>
          <SelectTrigger className="h-8 w-full border-term-border bg-term-panel text-xs shadow-none md:w-[150px]">
            <SelectValue placeholder="请选择项目" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((item) => (
              <SelectItem key={item.id} value={String(item.id)}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Select value={country} onValueChange={(value) => updateSearchParam('country', value)}>
        <SelectTrigger className="h-8 w-full border-term-border bg-term-panel text-xs shadow-none md:w-[130px]">
          <SelectValue placeholder="请选择国家站点" />
        </SelectTrigger>
        <SelectContent>
          {COUNTRY_OPTIONS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <DateRangePicker
        value={parseDateRangeInputValue(dateFrom, dateTo)}
        onChange={updateDateRange}
        className="h-8 w-full justify-start border-term-border bg-term-panel px-2 font-mono text-xs shadow-none md:w-[220px]"
        timezone={COUNTRY_TIMEZONE_MAP[country]}
      />

      {projectsError ? (
        <div className="flex h-8 items-center gap-1.5 border border-term-neg/50 bg-term-neg/10 px-2 font-mono text-xs text-term-neg">
          {projectsError}
        </div>
      ) : null}
    </>
  )

  return (
    <>
      {/* BLF-826：筛选控件上移 Top Header 中段插槽；页面仅渲染 portal 宿主 */}
      <HeaderFilterControlsWrapper>{controls}</HeaderFilterControlsWrapper>
      {/* explorer 经 useSearchParams 消费同一份 URL 参数；路由 replace 已触发其重取 */}
      <HiddenRefreshBridge />
    </>
  )
}

/** portal 渲染宿主（useHeaderSlot 必须在组件体内调用） */
function HeaderFilterControlsWrapper({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile()
  const portal = useHeaderSlot(<HeaderFilterControls isMobileView={isMobile} controls={children} />)
  return <>{portal}</>
}

/** 占位桥：保留组件树形状，未来刷新逻辑扩展点 */
function HiddenRefreshBridge() {
  return null
}
