'use client'

/**
 * 库存分类账页面（BLF-428 前端重构，方案 A；operations 全域 header 化迁移）.
 *
 * 三层结构：Top Header 中段插槽（项目/月份 + 4 维派生筛选 + 清除筛选，portal）
 * → 总览区（常驻，响应筛选）→ 汇总/明细/批次 tabs。
 *
 * 数据流（设计决策 D6）：summary + detail 两个原始数据集是唯一真相源，
 * 全局筛选条是唯一筛选状态；总览 KPI/图表全部由 ledger-derive 从筛选后的
 * 原始行客户端派生。/snapshot（环比口径）、/trend（月份趋势）、
 * /consistency（双表对账）作为补充数据。
 *
 * 刷新语义（header 迁移 §1.4）：本页无缓存，全局刷新 = useHeaderRefresh
 * 直接全量重拉 6 端点（allSettled）并上报 { loading }；handler 用 ref 桥接
 * 防过期闭包。原 TermPanel 控制台壳与页内「刷新」按钮已删除（全局唯一入口）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { AlertTriangle, Clock4, LayoutGrid, List, UploadCloud } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import {
  HeaderSlotSelect,
  TERM_HEADER_W_MD,
  TERM_HEADER_W_SM,
} from '@/components/terminal/header-filter-suite'
import { useHeaderRefresh, useHeaderSlot, useMobileFilterStrip } from '@/components/terminal/terminal-header-slot'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useUrlParam, useUrlParams } from '@/lib/hooks/use-url-param'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'

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

  // —— Header 化：head 插槽 + 全局刷新（operations header 迁移 §1.4） ——
  // 刷新语义与原控制台「刷新」按钮一致：本页无缓存，直接全量重拉 6 端点（allSettled）。
  // handler 用 ref 桥接——projectId/month 变化后触发刷新仍执行最新闭包，不过期。
  const loadDataRef = useRef(loadData)
  loadDataRef.current = loadData
  useHeaderRefresh(() => loadDataRef.current(), { loading })

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

  // 筛选控件 portal 进 Top Header 中段插槽（项目/月份 + 4 维派生筛选 + 清除筛选）。
  // 派生筛选的选项集合随数据更新——控件由页面自身渲染，portal 天然实时，无过期快照。
  const filterControls = (
    <>
      <HeaderSlotSelect
        value={projectId}
        onChange={setProjectId}
        options={projects.map((p) => ({ value: String(p.id), label: p.name }))}
        placeholder="选择项目"
        widthClass={TERM_HEADER_W_MD}
        title="项目筛选"
      />
      <HeaderSlotSelect
        value={month}
        onChange={setMonth}
        options={months.map((m) => ({ value: m, label: m }))}
        placeholder="选择月份"
        widthClass={TERM_HEADER_W_SM}
        title="月份筛选"
      />
      <HeaderSlotSelect
        value={filters.msku}
        onChange={(v) => setFilters({ msku: v })}
        options={[
          { value: ALL, label: '全部 SKU' },
          ...filterOptions.mskus.map((s) => ({ value: s, label: s })),
        ]}
        widthClass={TERM_HEADER_W_MD}
        title="SKU 筛选"
      />
      <HeaderSlotSelect
        value={filters.fc}
        onChange={(v) => setFilters({ fc: v })}
        options={[
          { value: ALL, label: '全部仓库' },
          ...filterOptions.locations.map((l) => ({ value: l, label: l })),
        ]}
        widthClass={TERM_HEADER_W_SM}
        title="仓库筛选"
      />
      <HeaderSlotSelect
        value={filters.disp}
        onChange={(v) => setFilters({ disp: v })}
        options={[
          { value: ALL, label: '全部状态' },
          ...filterOptions.dispositions.map((d) => ({ value: d, label: dispositionLabel(d) })),
        ]}
        widthClass={TERM_HEADER_W_SM}
        title="状态筛选"
      />
      <HeaderSlotSelect
        value={filters.evt}
        onChange={(v) => setFilters({ evt: v })}
        options={[
          { value: ALL, label: '全部事件类型' },
          ...filterOptions.eventTypes.map((e) => ({ value: e, label: eventTypeLabel(e) })),
        ]}
        widthClass={TERM_HEADER_W_MD}
        title="事件类型筛选"
      />
      {activeFilterCount > 0 && (
        <button
          type="button"
          onClick={() => setFilters({ msku: ALL, fc: ALL, disp: ALL, evt: ALL })}
          className="flex h-10 shrink-0 items-center rounded-none border border-term-border bg-term-panel px-2.5 font-mono text-xs text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
        >
          清除筛选（{activeFilterCount}）
        </button>
      )}
    </>
  )
  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={filterControls} />
  )

  // BLF-931 · 移动端：筛选控件下迁为正文顶部可折叠筛选条
  const mobileProjectLabel = projects.find((p) => String(p.id) === projectId)?.name ?? projectId
  const mobileFilterSummary = `${mobileProjectLabel} · ${month || '未选月份'}${activeFilterCount > 0 ? ` · ${activeFilterCount} 个筛选` : ''}`
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      controls={
        <>
          <HeaderSlotSelect
            value={projectId}
            onChange={setProjectId}
            options={projects.map((p) => ({ value: String(p.id), label: p.name }))}
            placeholder="选择项目"
            widthClass={TERM_HEADER_W_MD}
            title="项目筛选"
          />
          <HeaderSlotSelect
            value={month}
            onChange={setMonth}
            options={months.map((m) => ({ value: m, label: m }))}
            placeholder="选择月份"
            widthClass={TERM_HEADER_W_SM}
            title="月份筛选"
          />
          <HeaderSlotSelect
            value={filters.msku}
            onChange={(v) => setFilters({ msku: v })}
            options={[
              { value: ALL, label: '全部 SKU' },
              ...filterOptions.mskus.map((s) => ({ value: s, label: s })),
            ]}
            widthClass={TERM_HEADER_W_MD}
            title="SKU 筛选"
          />
          <HeaderSlotSelect
            value={filters.fc}
            onChange={(v) => setFilters({ fc: v })}
            options={[
              { value: ALL, label: '全部仓库' },
              ...filterOptions.locations.map((l) => ({ value: l, label: l })),
            ]}
            widthClass={TERM_HEADER_W_SM}
            title="仓库筛选"
          />
          <HeaderSlotSelect
            value={filters.disp}
            onChange={(v) => setFilters({ disp: v })}
            options={[
              { value: ALL, label: '全部状态' },
              ...filterOptions.dispositions.map((d) => ({ value: d, label: dispositionLabel(d) })),
            ]}
            widthClass={TERM_HEADER_W_SM}
            title="状态筛选"
          />
          <HeaderSlotSelect
            value={filters.evt}
            onChange={(v) => setFilters({ evt: v })}
            options={[
              { value: ALL, label: '全部事件类型' },
              ...filterOptions.eventTypes.map((e) => ({ value: e, label: eventTypeLabel(e) })),
            ]}
            widthClass={TERM_HEADER_W_MD}
            title="事件类型筛选"
          />
          <MobileFilterWide>
            <button
              type="button"
              onClick={() => setFilters({ msku: ALL, fc: ALL, disp: ALL, evt: ALL })}
              className="flex h-10 w-full shrink-0 items-center justify-center rounded-none border border-term-border bg-term-panel px-2.5 font-mono text-xs text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
            >
              清除筛选（{activeFilterCount}）
            </button>
          </MobileFilterWide>
        </>
      }
    />
  )

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Header 化：筛选控件已上移 Top Header 中段插槽，页面仅渲染 portal 宿主 */}
      {headerSlotPortal}
      {/* BLF-931：移动端折叠筛选条（正文顶部，md:hidden 挂载点内） */}
      {mobileFilterStrip}

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
          <Skeleton className="h-10 w-full" />
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
            {/* BLF-883 全局统一：variant="term" + 前置 icon */}
            <TabsList variant="term" className="w-fit justify-start">
              <TabsTrigger value="summary" variant="term">
                <LayoutGrid aria-hidden />
                汇总视图 Summary
              </TabsTrigger>
              <TabsTrigger value="detail" variant="term">
                <List aria-hidden />
                明细视图 Detail
              </TabsTrigger>
              <TabsTrigger value="batches" variant="term">
                <UploadCloud aria-hidden />
                上传批次
              </TabsTrigger>
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
