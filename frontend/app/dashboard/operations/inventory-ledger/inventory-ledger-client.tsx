'use client'

/**
 * 库存分类账页面（BLF-428 前端重构，方案 A；operations 全域 header 化迁移）.
 *
 * 页面结构：primary/secondary header slots → 总览区 → 汇总/明细/批次 tabs。
 *
 * 数据流：/month-analysis 一次返回所选月份全量 Summary / Detail、Snapshot、
 * Trend、Consistency 与批次元数据；页面筛选只影响展示，Excel 导出始终使用
 * 该整月全量数据，避免页面与导出两套口径。
 *
 * 刷新语义（header 迁移 §1.4）：本页无缓存，全局刷新 = useHeaderRefresh
 * 重拉整月聚合数据并上报 { loading }；handler 用 ref 桥接防过期闭包。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  Clock4,
  FileSpreadsheet,
  LayoutGrid,
  List,
  UploadCloud,
} from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import {
  useHeaderRefresh,
  useMobileFilterStrip,
  usePrimaryFilterSlot,
  useSecondaryHeaderSlot,
} from '@/components/terminal/terminal-header-slot'
import { WarmButton, WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useUrlParam, useUrlParams } from '@/lib/hooks/use-url-param'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'

import { fetchLedgerJson } from './ledger-load'
import { filterDetailRows, filterSummaryRows, formatLedgerMonthLabel } from './ledger-derive'
import { exportLedgerAnalysisToExcel } from './ledger-excel-export'
import { LedgerBatchesTab } from './ledger-batches-tab'
import { LedgerDetailTab } from './ledger-detail-tab'
import { LedgerSummaryTab } from './ledger-summary-tab'
import { ConsistencyBadge, IntegrityBadge } from './ledger-badges'
import styles from './inventory-ledger-warm.module.css'
import {
  ALL,
  dispositionLabel,
  eventTypeLabel,
  type ConsistencyCheckResult,
  type IngestBatchesResponse,
  type LedgerDetailResponse,
  type LedgerMonthAnalysisResponse,
  type LedgerSummaryResponse,
  type ProjectOption,
  type SnapshotResponse,
  type TrendResponse,
} from './ledger-types'

const API_BASE = '/api/backend/api/v1'
const ALL_FILTERS = { msku: ALL, fc: ALL, disp: ALL, evt: ALL }

function getLedgerMonthKey(value: string): string | null {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(value.trim())
  if (!match) return null

  const [, year, month] = match
  const monthNumber = Number(month)
  if (Number(year) < 1 || monthNumber < 1 || monthNumber > 12) return null

  return `${year}-${month}`
}

// recharts 只在客户端渲染（对齐 dashboard v1/v2 的代码分割模式）
const LazyLedgerOverview = dynamic(
  () => import('./ledger-overview').then((m) => m.LedgerOverview),
  {
    ssr: false,
    loading: () => (
      <div className={styles.overviewLoading} role="status" aria-busy="true">
        <span className={styles.visuallyHidden}>正在加载库存概览</span>
        <div className={styles.skeletonKpiGrid} aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => (
            <div className={styles.skeletonKpi} key={index} />
          ))}
        </div>
        <div className={styles.skeletonMain} aria-hidden="true" />
      </div>
    ),
  },
)

export default function InventoryLedgerPage() {
  const { data: session, status: sessionStatus } = useSession()
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [projectRetryKey, setProjectRetryKey] = useState(0)

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
  const [monthsLoading, setMonthsLoading] = useState(false)
  const [monthsError, setMonthsError] = useState<string | null>(null)
  const [monthRetryKey, setMonthRetryKey] = useState(0)
  const [loading, setLoading] = useState(false)
  const [analysisData, setAnalysisData] = useState<LedgerMonthAnalysisResponse | null>(null)
  const [analysisRequestScope, setAnalysisRequestScope] = useState<{
    projectId: string
    month: string
  } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  // BEL-417 教训：后端 500 不能伪装成"暂无数据"或白屏。
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  // 竞态保护：快速切换项目/月份时丢弃过期响应。
  const loadSeq = useRef(0)
  const monthOptionsSeq = useRef(0)
  const monthRef = useRef(month)
  const setMonthRef = useRef(setMonth)
  monthRef.current = month
  setMonthRef.current = setMonth

  // Data states
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null)
  const [trend, setTrend] = useState<TrendResponse | null>(null)
  const [summaryRows, setSummaryRows] = useState<LedgerSummaryResponse | null>(null)
  const [detailRows, setDetailRows] = useState<LedgerDetailResponse | null>(null)
  const [batches, setBatches] = useState<IngestBatchesResponse | null>(null)
  const [consistency, setConsistency] = useState<ConsistencyCheckResult | null>(null)

  // Project options stay in the page's existing managed-project scope.
  useEffect(() => {
    let active = true
    if (sessionStatus === 'loading') {
      setProjectsLoading(true)
      return () => {
        active = false
      }
    }
    if (!session) {
      setProjects([])
      setProjectsLoading(false)
      setProjectsError(null)
      return () => {
        active = false
      }
    }

    setProjectsLoading(true)
    setProjectsError(null)
    const request = projectRetryKey === 0
      ? fetchManagedProjectsCached<ProjectOption[]>()
      : fetchManagedProjectsCached<ProjectOption[]>(undefined, false, { force: true })

    request
      .then((items) => {
        if (active) setProjects(items)
      })
      .catch((err) => {
        if (active) {
          setProjects([])
          setProjectsError(err instanceof Error ? err.message : '项目列表加载失败')
        }
      })
      .finally(() => {
        if (active) setProjectsLoading(false)
      })

    return () => {
      active = false
    }
  }, [projectRetryKey, session, sessionStatus])

  const retryProjects = useCallback(() => {
    setProjectsLoading(true)
    setProjectsError(null)
    setProjectRetryKey((key) => key + 1)
  }, [])

  useAutoSelectFirstProject(projects, projectId, setProjectId)

  // Ignore late month-option responses after a project switch or retry.
  useEffect(() => {
    const seq = ++monthOptionsSeq.current
    if (!projectId) {
      setMonths([])
      setMonthsLoading(false)
      setMonthsError(null)
      return () => {
        if (monthOptionsSeq.current === seq) monthOptionsSeq.current += 1
      }
    }

    setMonths([])
    setMonthsLoading(true)
    setMonthsError(null)
    fetchLedgerJson<{ months?: string[] }>(
      `${API_BASE}/inventory-ledger/months?project_id=${projectId}`,
    )
      .then((data) => {
        if (seq !== monthOptionsSeq.current) return
        const list = data.months ?? []
        setMonths(list)
        if (!monthRef.current && list.length > 0) {
          setMonthRef.current(list[0])
        }
      })
      .catch((err) => {
        if (seq !== monthOptionsSeq.current) return
        setMonths([])
        setMonthsError(err instanceof Error ? err.message : '月份列表加载失败')
      })
      .finally(() => {
        if (seq === monthOptionsSeq.current) setMonthsLoading(false)
      })
    return () => {
      if (monthOptionsSeq.current === seq) monthOptionsSeq.current += 1
    }
  }, [projectId, monthRetryKey])

  const retryMonths = useCallback(() => {
    setMonthsLoading(true)
    setMonthsError(null)
    setMonthRetryKey((key) => key + 1)
  }, [])

  // 切换项目/月份时重置维度筛选（首次挂载不重置，保住深链分享）
  const prevScope = useRef<{ project: string; month: string } | null>(null)
  useEffect(() => {
    const prev = prevScope.current
    prevScope.current = { project: projectId, month }
    if (prev && (prev.project !== projectId || prev.month !== month)) {
      setFilters(ALL_FILTERS)
    }
  }, [projectId, month, setFilters])

  // Load data when month changes
  const loadData = useCallback(async () => {
    if (!projectId || !month) return
    const seq = ++loadSeq.current
    setLoading(true)
    setAnalysisError(null)
    try {
      const base = `${API_BASE}/inventory-ledger`
      const params = `project_id=${projectId}&period=${month}`
      const data = await fetchLedgerJson<LedgerMonthAnalysisResponse>(
        `${base}/month-analysis?${params}`,
      )
      if (seq !== loadSeq.current) return

      setSnapshot(data.snapshot)
      setTrend(data.trend)
      setSummaryRows({ report_month: data.report_month, rows: data.summary_rows })
      setDetailRows({ report_month: data.report_month, rows: data.detail_rows })
      setBatches({ project_id: data.project_id, batches: data.batches })
      setConsistency(data.consistency)
      setAnalysisData(data)
      setAnalysisRequestScope({ projectId, month })
    } catch (err) {
      if (seq === loadSeq.current) {
        setAnalysisError(err instanceof Error ? err.message : '加载失败')
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [projectId, month])

  useEffect(() => {
    loadData()
  }, [loadData])

  // —— Header 化：head 插槽 + 全局刷新（operations header 迁移 §1.4） ——
  // 刷新语义：本页无缓存，重拉整月聚合数据（页面与 Excel 共用同一全量口径）。
  // handler 用 ref 桥接——projectId/month 变化后触发刷新仍执行最新闭包，不过期。
  const loadDataRef = useRef(loadData)
  loadDataRef.current = loadData
  useHeaderRefresh(() => loadDataRef.current(), { loading })

  // project/month 切换后，取数 effect 设置 loading 前会先渲染一次；范围校验同时保护展示和导出，
  // 避免新范围取数失败时展示或导出旧数据；同范围刷新失败时仍可导出保留的数据。
  const selectedMonthKey = getLedgerMonthKey(month)
  const analysisMonthKey = analysisData ? getLedgerMonthKey(analysisData.report_month) : null
  const analysisMatchesScope = Boolean(
    analysisData &&
      analysisRequestScope &&
      analysisRequestScope.projectId === projectId &&
      analysisRequestScope.month === month &&
      String(analysisData.project_id) === projectId &&
      analysisMonthKey !== null &&
      (selectedMonthKey === null || analysisMonthKey === selectedMonthKey),
  )

  const handleExport = useCallback(async () => {
    if (!analysisData || !analysisMatchesScope || exporting) return
    setExporting(true)
    setExportError(null)
    try {
      await exportLedgerAnalysisToExcel(analysisData)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : '导出 Excel 失败')
    } finally {
      setExporting(false)
    }
  }, [analysisData, analysisMatchesScope, exporting])

  // ── 筛选选项（从原始行派生） ────────────────────────────────────────────
  const rawSummary = useMemo(
    () => (analysisMatchesScope ? summaryRows?.rows ?? [] : []),
    [analysisMatchesScope, summaryRows],
  )
  const rawDetail = useMemo(
    () => (analysisMatchesScope ? detailRows?.rows ?? [] : []),
    [analysisMatchesScope, detailRows],
  )

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

  const hasAnyData =
    analysisMatchesScope &&
    (rawSummary.length > 0 || rawDetail.length > 0 || snapshot !== null)
  const activeFilterCount = [filters.msku, filters.fc, filters.disp, filters.evt].filter(
    (v) => v !== ALL,
  ).length

  const projectOptions = projects.map((project) => ({
    value: String(project.id),
    label: project.name,
  }))
  const projectPlaceholder = projectsLoading
    ? '加载项目…'
    : projectsError
      ? '项目列表加载失败'
      : projects.length === 0
        ? '暂无可用项目'
        : '选择项目'
  const monthOptions = months.map((value) => ({ value, label: formatLedgerMonthLabel(value) }))
  const selectedDisplayMonthKey = analysisMatchesScope ? analysisMonthKey : selectedMonthKey
  const selectedMonthOption = selectedDisplayMonthKey === null
    ? undefined
    : monthOptions.find((option) => getLedgerMonthKey(option.value) === selectedDisplayMonthKey)
  const fallbackMonthDisplayValue = analysisMatchesScope && analysisData
    ? analysisData.report_month
    : month
  const displayMonthOption = selectedMonthOption ?? (
    selectedDisplayMonthKey !== null && fallbackMonthDisplayValue
      ? {
          value: fallbackMonthDisplayValue,
          label: formatLedgerMonthLabel(fallbackMonthDisplayValue),
        }
      : undefined
  )
  const displayMonthOptions = displayMonthOption && !selectedMonthOption
    ? [...monthOptions, displayMonthOption]
    : monthOptions
  const displayMonthValue = selectedDisplayMonthKey === null ? '' : displayMonthOption?.value ?? ''
  const monthPlaceholder = monthsLoading
    ? '加载月份…'
    : monthsError
      ? '月份列表加载失败'
      : months.length === 0
        ? '暂无可选月份'
        : '选择月份'

  const renderProjectFilter = (id: string) => (
    <div
      className={`${styles.filterField} ${styles.projectField}`}
      aria-busy={projectsLoading || undefined}
    >
      <WarmSelect
        id={id}
        label="项目筛选"
        value={projectId}
        options={projectOptions}
        placeholder={projectPlaceholder}
        disabled={projectsLoading || Boolean(projectsError) || projects.length === 0}
        error={projectsError}
        onChange={setProjectId}
      />
      {projectsError && (
        <WarmButton
          className={styles.filterRetry}
          variant="quiet"
          aria-label="重试加载项目列表"
          onClick={retryProjects}
        >
          重试
        </WarmButton>
      )}
    </div>
  )

  const renderMonthFilter = (id: string) => (
    <div
      className={`${styles.filterField} ${styles.monthField}`}
      aria-busy={monthsLoading || undefined}
    >
      <WarmSelect
        id={id}
        label="月份筛选"
        value={displayMonthValue}
        options={displayMonthOptions}
        placeholder={monthPlaceholder}
        disabled={!projectId || monthsLoading || Boolean(monthsError) || months.length === 0}
        error={monthsError}
        onChange={setMonth}
      />
      {monthsError && (
        <WarmButton
          className={styles.filterRetry}
          variant="quiet"
          aria-label="重试加载月份列表"
          onClick={retryMonths}
        >
          重试
        </WarmButton>
      )}
    </div>
  )

  const renderDimensionFilter = (
    id: string,
    label: string,
    value: string,
    options: Array<{ value: string; label: string }>,
    onChange: (next: string) => void,
    className: string,
  ) => (
    <div className={`${styles.filterField} ${className}`}>
      <WarmSelect
        id={id}
        label={label}
        value={value}
        options={options}
        onChange={onChange}
      />
    </div>
  )

  const clearFilters = () => setFilters(ALL_FILTERS)
  const renderDimensionFilters = (suffix: string, mobile = false) => (
    <>
      {renderDimensionFilter(
        `inventory-ledger-msku-${suffix}`,
        'SKU 筛选',
        filters.msku,
        [
          { value: ALL, label: '全部 SKU' },
          ...filterOptions.mskus.map((value) => ({ value, label: value })),
        ],
        (value) => setFilters({ msku: value }),
        styles.mskuField,
      )}
      {renderDimensionFilter(
        `inventory-ledger-location-${suffix}`,
        '仓库筛选',
        filters.fc,
        [
          { value: ALL, label: '全部仓库' },
          ...filterOptions.locations.map((value) => ({ value, label: value })),
        ],
        (value) => setFilters({ fc: value }),
        styles.locationField,
      )}
      {renderDimensionFilter(
        `inventory-ledger-disposition-${suffix}`,
        '状态筛选',
        filters.disp,
        [
          { value: ALL, label: '全部状态' },
          ...filterOptions.dispositions.map((value) => ({
            value,
            label: dispositionLabel(value),
          })),
        ],
        (value) => setFilters({ disp: value }),
        styles.dispositionField,
      )}
      {renderDimensionFilter(
        `inventory-ledger-event-${suffix}`,
        '事件类型筛选',
        filters.evt,
        [
          { value: ALL, label: '全部事件类型' },
          ...filterOptions.eventTypes.map((value) => ({ value, label: eventTypeLabel(value) })),
        ],
        (value) => setFilters({ evt: value }),
        styles.eventField,
      )}
      {activeFilterCount > 0 && (
        mobile ? (
          <MobileFilterWide className={styles.mobileFilterWide}>
            <WarmButton className={styles.filterClear} variant="quiet" onClick={clearFilters}>
              清除筛选（{activeFilterCount}）
            </WarmButton>
          </MobileFilterWide>
        ) : (
          <WarmButton className={styles.filterClear} variant="quiet" onClick={clearFilters}>
            清除筛选（{activeFilterCount}）
          </WarmButton>
        )
      )}
    </>
  )

  const primaryFilterSlot = usePrimaryFilterSlot(
    <div
      className={styles.primaryFilters}
      role="group"
      aria-label="项目和月份筛选"
      aria-busy={projectsLoading || monthsLoading || undefined}
    >
      {renderProjectFilter('inventory-ledger-project-primary')}
      {renderMonthFilter('inventory-ledger-month-primary')}
    </div>,
  )
  const secondaryHeaderSlot = useSecondaryHeaderSlot(
    <div className={styles.secondaryFilters} role="group" aria-label="库存维度筛选">
      {renderDimensionFilters('secondary')}
    </div>,
  )

  const mobileProjectLabel = projects.find((project) => String(project.id) === projectId)?.name
    ?? (projectId || '未选择项目')
  const mobileMonthLabel = month ? formatLedgerMonthLabel(month) : '未选月份'
  const mobileFilterSummary = `${mobileProjectLabel} · ${mobileMonthLabel} · ${activeFilterCount} 个筛选`
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      className={styles.mobileFilterStrip}
      controls={
        <>
          {renderProjectFilter('inventory-ledger-project-mobile')}
          {renderMonthFilter('inventory-ledger-month-mobile')}
          {renderDimensionFilters('mobile', true)}
        </>
      }
    />
  )
  const canShowEmptyMonth =
    !loading &&
    !hasAnyData &&
    !analysisError &&
    Boolean(projectId) &&
    !monthsLoading &&
    !monthsError &&
    (Boolean(month) || months.length === 0)
  const noProjectsAvailable =
    !projectsLoading && !projectsError && projects.length === 0 && !projectId

  return (
    <div className={styles.page}>
      {primaryFilterSlot}
      {secondaryHeaderSlot}
      {mobileFilterStrip}

      {analysisError && (
        <div className={styles.pageError} role="alert">
          <span className={styles.pageErrorMessage}>{analysisError}</span>
          <WarmButton variant="secondary" onClick={() => void loadData()}>
            重试
          </WarmButton>
        </div>
      )}

      {loading && !hasAnyData && (
        <div className={styles.initialLoading} role="status" aria-busy="true">
          <span className={styles.loadingLabel}>正在加载所选月份库存分类账</span>
          <div className={styles.skeletonKpiGrid} aria-hidden="true">
            {Array.from({ length: 8 }, (_, index) => (
              <div className={styles.skeletonKpi} key={index} />
            ))}
          </div>
          <div className={styles.skeletonMain} aria-hidden="true" />
          <div className={styles.skeletonTable} aria-hidden="true" />
        </div>
      )}

      {noProjectsAvailable && (
        <div className={styles.emptyState} role="status">
          <p className={styles.emptyTitle}>暂无可用项目</p>
        </div>
      )}

      {canShowEmptyMonth && (
        <div className={styles.emptyState} role="status">
          <Clock4 className={styles.emptyIcon} aria-hidden="true" />
          <p className={styles.emptyTitle}>暂无库存分类账数据</p>
          <p className={styles.emptyHelp}>
            请通过「报表上传」页面上传 Amazon Inventory Ledger CSV（Summary / Detailed 视图均可自动识别）
          </p>
        </div>
      )}

      {hasAnyData && (
        <>
          <div className={styles.exportRow}>
            <div className={styles.exportControls}>
              <WarmButton
                className={styles.exportButton}
                variant="secondary"
                disabled={!analysisMatchesScope || loading}
                loading={exporting}
                loadingLabel="正在导出库存分析 Excel"
                onClick={() => void handleExport()}
              >
                <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
                {exporting ? '导出中…' : '导出库存分析 Excel'}
              </WarmButton>
              <p className={styles.exportNote}>
                Excel 按所选月份全量导出，不受页面维度筛选影响
              </p>
            </div>
            <div
              className={styles.healthStates}
              aria-label="所选项目与月份的数据完整性与对账状态"
            >
              {(snapshot?.integrity || consistency) && (
                <span className={styles.healthScope}>项目 / 月份范围</span>
              )}
              {snapshot?.integrity && <IntegrityBadge integrity={snapshot.integrity} />}
              {consistency && <ConsistencyBadge consistency={consistency} />}
            </div>
          </div>
          {exportError && (
            <p className={styles.exportError} role="alert">
              {exportError}
            </p>
          )}
          <LazyLedgerOverview
            snapshot={snapshot}
            trend={trend}
            summaryRows={filteredSummary}
            detailRows={filteredDetail}
            mskuFilter={filters.msku}
          />

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className={styles.tabsFrame}>
              <TabsList
                variant="term"
                aria-label="库存分类账视图"
                className={styles.tabsList}
              >
                <TabsTrigger value="summary" variant="term" className={styles.tabsTrigger}>
                  <LayoutGrid aria-hidden />
                  汇总视图 Summary
                </TabsTrigger>
                <TabsTrigger value="detail" variant="term" className={styles.tabsTrigger}>
                  <List aria-hidden />
                  明细视图 Detail
                </TabsTrigger>
                <TabsTrigger value="batches" variant="term" className={styles.tabsTrigger}>
                  <UploadCloud aria-hidden />
                  上传批次
                </TabsTrigger>
              </TabsList>

              <TabsContent value="summary" className={styles.tabContent}>
                <LedgerSummaryTab
                  rows={filteredSummary}
                  failed={analysisError !== null && summaryRows === null}
                />
              </TabsContent>
              <TabsContent value="detail" className={styles.tabContent}>
                <LedgerDetailTab
                  rows={filteredDetail}
                  failed={analysisError !== null && detailRows === null}
                />
              </TabsContent>
              <TabsContent value="batches" className={styles.tabContent}>
                <LedgerBatchesTab
                  batches={batches?.batches ?? []}
                  failed={analysisError !== null && batches === null}
                />
              </TabsContent>
            </div>
          </Tabs>
        </>
      )}
    </div>
  )
}
