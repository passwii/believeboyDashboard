'use client'

/**
 * 库存分类账页面（BLF-428 前端重构，方案 A）.
 *
 * 三层结构：全局筛选条 → 总览区（常驻，响应筛选）→ 汇总/明细/批次 tabs。
 *
 * 数据流（设计决策 D6）：summary + detail 两个原始数据集是唯一真相源，
 * 全局筛选条是唯一筛选状态；总览 KPI/图表全部由 ledger-derive 从筛选后的
 * 原始行客户端派生。/snapshot（环比口径）、/trend（月份趋势）、
 * /consistency（双表对账）作为补充数据。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { AlertTriangle, ClipboardCheck, Clock4, RefreshCw } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { FilterToolbar } from '@/components/ui/filter-toolbar'
import { PageHeader } from '@/components/ui/page-header'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useUrlParam, useUrlParams } from '@/lib/hooks/use-url-param'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'
import { cn } from '@/lib/utils'

import { fetchLedgerJson } from './ledger-load'
import { filterDetailRows, filterSummaryRows } from './ledger-derive'
import { LedgerBatchesTab } from './ledger-batches-tab'
import { LedgerDetailTab } from './ledger-detail-tab'
import { LedgerSummaryTab } from './ledger-summary-tab'
import {
  ALL,
  dispositionLabel,
  eventTypeLabel,
  type ConsistencyCheckResult,
  type IngestBatchesResponse,
  type LedgerDetailResponse,
  type LedgerSummaryResponse,
  type ProjectOption,
  type SnapshotResponse,
  type TrendResponse,
} from './ledger-types'

const API_BASE = '/api/backend/api/v1'

// recharts 只在客户端渲染（对齐 dashboard v1/v2 的代码分割模式）
const LazyLedgerOverview = dynamic(
  () => import('./ledger-overview').then((m) => m.LedgerOverview),
  {
    ssr: false,
    loading: () => <Skeleton className="h-64 w-full" />,
  },
)

export default function InventoryLedgerPage() {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<ProjectOption[]>([])

  // ── 全局筛选状态（唯一真相源，URL 同步） ─────────────────────────────────
  const [projectId, setProjectId] = useUrlParam<string>('project_id', '')
  const [month, setMonth] = useUrlParam<string>('month', '')
  const [activeTab, setActiveTab] = useUrlParam<string>('tab', 'summary')
  const [filters, setFilters] = useUrlParams({
    msku: ALL,
    fc: ALL,
    disp: ALL,
    evt: ALL,
  })

  const [months, setMonths] = useState<string[]>([])
  const [monthsLoaded, setMonthsLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  // BEL-417 教训：后端 500 不能伪装成"暂无数据"或白屏。
  const [loadError, setLoadError] = useState<string | null>(null)
  // 竞态保护：快速切换项目/月份时丢弃过期响应。
  const loadSeq = useRef(0)

  // Data states
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null)
  const [trend, setTrend] = useState<TrendResponse | null>(null)
  const [summaryRows, setSummaryRows] = useState<LedgerSummaryResponse | null>(null)
  const [detailRows, setDetailRows] = useState<LedgerDetailResponse | null>(null)
  const [batches, setBatches] = useState<IngestBatchesResponse | null>(null)
  const [consistency, setConsistency] = useState<ConsistencyCheckResult | null>(null)

  // Load projects
  useEffect(() => {
    if (!session) return
    fetchManagedProjectsCached<ProjectOption[]>().then((items) => {
      setProjects(items)
    })
  }, [session])

  useAutoSelectFirstProject(projects, projectId, setProjectId)

  // Load months when project changes
  useEffect(() => {
    if (!projectId) return
    setMonthsLoaded(false)
    fetchLedgerJson<{ months?: string[] }>(
      `${API_BASE}/inventory-ledger/months?project_id=${projectId}`,
    )
      .then((data) => {
        const list = data.months ?? []
        setMonths(list)
        if (!month && list.length > 0) {
          setMonth(list[0])
        }
      })
      .catch((err) => {
        setMonths([])
        setLoadError(err instanceof Error ? err.message : '月份列表加载失败')
      })
      .finally(() => setMonthsLoaded(true))
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 切换项目/月份时重置维度筛选（首次挂载不重置，保住深链分享）
  const prevScope = useRef<{ project: string; month: string } | null>(null)
  useEffect(() => {
    const prev = prevScope.current
    prevScope.current = { project: projectId, month }
    if (prev && (prev.project !== projectId || prev.month !== month)) {
      setFilters({ msku: ALL, fc: ALL, disp: ALL, evt: ALL })
    }
  }, [projectId, month, setFilters])

  // Load data when month changes
  const loadData = useCallback(async () => {
    if (!projectId || !month) return
    const seq = ++loadSeq.current
    setLoading(true)
    setLoadError(null)
    try {
      const base = `${API_BASE}/inventory-ledger`
      const params = `project_id=${projectId}&period=${month}`

      // allSettled: 单个端点失败不拖垮其他区块（BEL-417 教训）。
      const [snapRes, trendRes, summaryRes, detailRes, batchRes, consRes] =
        await Promise.allSettled([
          fetchLedgerJson<SnapshotResponse>(`${base}/snapshot?${params}`),
          fetchLedgerJson<TrendResponse>(`${base}/trend?project_id=${projectId}&months=6`),
          fetchLedgerJson<LedgerSummaryResponse>(`${base}/summary?${params}`),
          fetchLedgerJson<LedgerDetailResponse>(`${base}/detail?${params}`),
          fetchLedgerJson<IngestBatchesResponse>(`${base}/batches?project_id=${projectId}`),
          fetchLedgerJson<ConsistencyCheckResult>(`${base}/consistency?${params}`),
        ])
      if (seq !== loadSeq.current) return

      setSnapshot(snapRes.status === 'fulfilled' ? snapRes.value : null)
      setTrend(trendRes.status === 'fulfilled' ? trendRes.value : null)
      setSummaryRows(summaryRes.status === 'fulfilled' ? summaryRes.value : null)
      setDetailRows(detailRes.status === 'fulfilled' ? detailRes.value : null)
      setBatches(batchRes.status === 'fulfilled' ? batchRes.value : null)
      setConsistency(consRes.status === 'fulfilled' ? consRes.value : null)

      const failures = [snapRes, trendRes, summaryRes, detailRes, batchRes, consRes].filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      )
      if (failures.length > 0) {
        const firstMsg =
          failures[0].reason instanceof Error ? failures[0].reason.message : '加载失败'
        setLoadError(
          failures.length === 6 ? firstMsg : `部分数据加载失败：${firstMsg}`,
        )
      }
    } catch (err) {
      if (seq === loadSeq.current) {
        setLoadError(err instanceof Error ? err.message : '加载失败')
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [projectId, month])

  useEffect(() => {
    loadData()
  }, [loadData])

  // ── 筛选选项（从原始行派生） ────────────────────────────────────────────
  const rawSummary = summaryRows?.rows ?? []
  const rawDetail = detailRows?.rows ?? []

  const filterOptions = useMemo(() => {
    const mskus = new Set<string>()
    const locations = new Set<string>()
    const dispositions = new Set<string>()
    const eventTypes = new Set<string>()
    for (const r of rawSummary) {
      mskus.add(r.msku)
      locations.add(r.location)
      dispositions.add(r.disposition)
    }
    for (const r of rawDetail) {
      mskus.add(r.msku)
      locations.add(r.fulfillment_center)
      dispositions.add(r.disposition)
      eventTypes.add(r.event_type)
    }
    return {
      mskus: Array.from(mskus).sort(),
      locations: Array.from(locations).sort(),
      dispositions: Array.from(dispositions).sort(),
      eventTypes: Array.from(eventTypes).sort(),
    }
  }, [rawSummary, rawDetail])

  // ── 应用全局筛选（总览 + 两个 tab 共用） ────────────────────────────────
  const globalFilters = useMemo(
    () => ({
      msku: filters.msku,
      location: filters.fc,
      disposition: filters.disp,
      eventType: filters.evt,
    }),
    [filters],
  )
  const filteredSummary = useMemo(
    () => filterSummaryRows(rawSummary, globalFilters),
    [rawSummary, globalFilters],
  )
  const filteredDetail = useMemo(
    () => filterDetailRows(rawDetail, globalFilters),
    [rawDetail, globalFilters],
  )

  const hasAnyData = rawSummary.length > 0 || rawDetail.length > 0 || snapshot !== null
  const activeFilterCount = [filters.msku, filters.fc, filters.disp, filters.evt].filter(
    (v) => v !== ALL,
  ).length

  return (
    <div className="flex flex-col gap-4">
      {/* 页面头部：eyebrow pill + 标题 + 描述 + 操作区（§8.1 PageHeader 原语，对齐 site-navigation） */}
      <section className="dashboard-surface animate-enter px-5 py-5 md:px-7 md:py-6 dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <PageHeader
          className="relative z-10"
          eyebrow={
            <>
              <ClipboardCheck className="h-3.5 w-3.5" />
              供应链 · 库存分类账
            </>
          }
          title="库存分类账"
          description="按月对账 Amazon Inventory Ledger：汇总水位 / 事件明细 / 上传批次，支持跨月连续性与双表一致性校验。"
          actions={
            <>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="选择项目" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={month} onValueChange={setMonth}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="选择月份" />
                </SelectTrigger>
                <SelectContent>
                  {months.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button variant="outline" size="icon" onClick={loadData} disabled={loading}>
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </Button>
            </>
          }
        />
      </section>

      {/* 全局维度筛选条（唯一筛选真相源）— §8.2 FilterToolbar，桌面横向 / 手机 2 列网格 */}
      <FilterToolbar
        actions={
          activeFilterCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={() => setFilters({ msku: ALL, fc: ALL, disp: ALL, evt: ALL })}
            >
              清除筛选（{activeFilterCount}）
            </Button>
          ) : undefined
        }
      >
        <Select value={filters.msku} onValueChange={(v) => setFilters({ msku: v })}>
          <SelectTrigger className="w-full md:w-[150px]">
            <SelectValue placeholder="全部 SKU" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部 SKU</SelectItem>
            {filterOptions.mskus.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filters.fc} onValueChange={(v) => setFilters({ fc: v })}>
          <SelectTrigger className="w-full md:w-[130px]">
            <SelectValue placeholder="全部仓库" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部仓库</SelectItem>
            {filterOptions.locations.map((l) => (
              <SelectItem key={l} value={l}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filters.disp} onValueChange={(v) => setFilters({ disp: v })}>
          <SelectTrigger className="w-full md:w-[140px]">
            <SelectValue placeholder="全部状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部状态</SelectItem>
            {filterOptions.dispositions.map((d) => (
              <SelectItem key={d} value={d}>
                {dispositionLabel(d)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filters.evt} onValueChange={(v) => setFilters({ evt: v })}>
          <SelectTrigger className="w-full md:w-[140px]">
            <SelectValue placeholder="全部事件类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部事件类型</SelectItem>
            {filterOptions.eventTypes.map((e) => (
              <SelectItem key={e} value={e}>
                {eventTypeLabel(e)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterToolbar>

      {/* Load error banner（BEL-417：真实错误 + 重试，不再静默假空态；destructive token 自动适配 dark） */}
      {loadError && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{loadError}</span>
          </div>
          <Button variant="outline" size="sm" onClick={loadData}>
            重试
          </Button>
        </div>
      )}

      {/* Loading */}
      {loading && !hasAnyData && (
        <div className="space-y-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {/* Empty state */}
      {!loading && !hasAnyData && !loadError && projectId && monthsLoaded && (month || months.length === 0) && (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
          <Clock4 className="h-8 w-8" />
          <p className="text-sm font-medium">暂无库存分类账数据</p>
          <p className="text-xs">请通过「报表上传」页面上传 Amazon Inventory Ledger CSV（Summary / Detailed 视图均可自动识别）</p>
        </div>
      )}

      {/* 总览区（常驻）+ 明细 tabs */}
      {hasAnyData && (
        <>
          <LazyLedgerOverview
            snapshot={snapshot}
            trend={trend}
            consistency={consistency}
            summaryRows={filteredSummary}
            detailRows={filteredDetail}
            mskuFilter={filters.msku}
          />

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="summary">汇总视图 Summary</TabsTrigger>
              <TabsTrigger value="detail">明细视图 Detail</TabsTrigger>
              <TabsTrigger value="batches">上传批次</TabsTrigger>
            </TabsList>

            <TabsContent value="summary">
              <LedgerSummaryTab
                rows={filteredSummary}
                failed={loadError !== null && summaryRows === null}
                period={month}
              />
            </TabsContent>
            <TabsContent value="detail">
              <LedgerDetailTab
                rows={filteredDetail}
                failed={loadError !== null && detailRows === null}
                period={month}
              />
            </TabsContent>
            <TabsContent value="batches">
              <LedgerBatchesTab
                batches={batches?.batches ?? []}
                failed={loadError !== null && batches === null}
              />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}
