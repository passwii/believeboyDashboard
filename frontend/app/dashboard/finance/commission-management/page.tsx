'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarRange, FolderKanban, LayoutDashboard, Loader2, RefreshCw, Wallet } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { TermPanel } from '@/components/terminal/term-panel'
import {
  MonthPicker,
  formatMonthInputValue,
  parseMonthInputValue,
} from '@/components/ui/date-picker'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { HeaderSlotButton, TERM_HEADER_W_SM } from '@/components/terminal/header-filter-suite'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { cn } from '@/lib/utils'
import { buildBackendClientHeaders } from '@/lib/backend-auth'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useNotifications } from '@/components/notifications'
import { DetailTab } from './detail-tab'
import { MonthlySummaryTab } from './monthly-summary-tab'
import { ProjectSummaryTab } from './project-summary-tab'
import { MonthlyCollectionTab } from './monthly-collection-tab'
import { CommissionRulesCard } from './commission-rules-card'
import { groupProjectsBySites, formatRmb, formatUsd, SITE_INFO } from './utils'
import type {
  CommissionProjectMonth,
  ExchangeRate,
  ProjectMeta,
  PaymentStatus,
  SiteCode,
  ProjectRow,
} from './types'
import { SITE_ORDER } from './types'

type CommissionProjectMonthsResponse = {
  report_month: string
  items: CommissionProjectMonth[]
}

type CommissionYearlyMonthlySummaryItem = {
  report_month: string
  income_total_usd: number
  factory_commission_usd: number
  factory_commission_rmb: number
  received_rmb: number
  receive_rate: number
}

type CommissionYearlyMonthlySummaryResponse = {
  year: string
  items: CommissionYearlyMonthlySummaryItem[]
}

type CommissionProjectMonthlySummaryMonthItem = {
  report_month: string
  income_total_usd: number
  factory_commission_rmb: number
  received_rmb: number
  receive_rate: number
}

type CommissionProjectYearlySummaryItem = {
  project_id: number
  project_name: string
  months: Record<string, CommissionProjectMonthlySummaryMonthItem>
  total_income_usd: number
  total_commission_rmb: number
  total_received_rmb: number
  receive_rate: number
}

type CommissionProjectYearlySummaryResponse = {
  year: string
  items: CommissionProjectYearlySummaryItem[]
}

type CommissionViewTab = 'detail' | 'monthly' | 'projectSummary' | 'monthlyCollection'

const API_BASE = '/api/backend'

function lastMonthString(): string {
  const now = new Date()
  now.setMonth(now.getMonth() - 1)
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function parseErrorBody(text: string, status: number): string {
  if (!text) return `请求失败 (${status})`
  try {
    const payload = JSON.parse(text) as {
      detail?: string | unknown[] | Record<string, unknown>
      error?: string
    }
    if (typeof payload.detail === 'string') return payload.detail
    if (typeof payload.error === 'string') return payload.error
    if (Array.isArray(payload.detail)) {
      return payload.detail
        .map((item: unknown) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object') {
            const maybeMsg = (item as { msg?: unknown }).msg
            return typeof maybeMsg === 'string' ? maybeMsg : JSON.stringify(item)
          }
          return String(item)
        })
        .join('; ')
    }
    if (payload.detail && typeof payload.detail === 'object') return JSON.stringify(payload.detail)
    return text
  } catch {
    return text
  }
}

function getCurrentYear(): string {
  return new Date().getFullYear().toString()
}

export default function CommissionManagementPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const [month, setMonth] = useState(lastMonthString())
  const [summaryYear, setSummaryYear] = useState(getCurrentYear())
  const [activeTab, setActiveTab] = useState<CommissionViewTab>('detail')
  const [countryFilter, setCountryFilter] = useState<SiteCode | 'all'>('all') // 'all', 'US', 'DE', 'UK'

  const [loading, setLoading] = useState(true)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [recomputing, setRecomputing] = useState(false)

  const [rows, setRows] = useState<CommissionProjectMonth[]>([])
  const [monthlySummary, setMonthlySummary] = useState<CommissionYearlyMonthlySummaryItem[]>([])
  const [projectSummary, setProjectSummary] = useState<CommissionProjectYearlySummaryItem[]>([])
  const [projectMetaById, setProjectMetaById] = useState<Record<number, ProjectMeta>>({})
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([])

  const [updatingId, setUpdatingId] = useState<number | null>(null)
  const [receivedDraftById, setReceivedDraftById] = useState<Record<number, string>>({})

  const loadExchangeRates = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/v1/exchange-rates?year_month=${month}`, {
        cache: 'no-store',
        headers: buildBackendClientHeaders(session),
      })
      if (response.ok) {
        const payload = (await response.json()) as { data?: ExchangeRate[] }
        setExchangeRates(payload.data || [])
      }
    } catch {
      setExchangeRates([])
    }
  }, [month, session])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ report_month: month })
      if (countryFilter !== 'all') {
        params.set('country', countryFilter)
      }
      const response = await fetch(
        `${API_BASE}/api/v1/system-management/commission-management/project-months?${params.toString()}`,
        {
          cache: 'no-store',
          headers: buildBackendClientHeaders(session),
        }
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as CommissionProjectMonthsResponse
      const nextRows = Array.isArray(payload.items) ? payload.items : []
      setRows(nextRows)
      setReceivedDraftById(
        nextRows.reduce<Record<number, string>>((acc, item) => {
          acc[item.id] = item.received_rmb.toFixed(2)
          return acc
        }, {})
      )
    } catch (loadError) {
      notify({
        type: 'error',
        title: '佣金数据加载失败',
        message: loadError instanceof Error ? loadError.message : '佣金数据加载失败',
      })
      setRows([])
      setReceivedDraftById({})
    } finally {
      setLoading(false)
    }
  }, [month, session, countryFilter])

  const loadProjectMeta = useCallback(async () => {
    try {
      // 复用 projects/manage 2min 客户端缓存（BEL-424）：项目佣金元数据跨页共享。
      const payload = await fetchManagedProjectsCached<
        Array<{ id: number; commission_basis?: string | null; commission_rate?: number | null }>
      >(session)
      const nextMap = (Array.isArray(payload) ? payload : []).reduce<Record<number, ProjectMeta>>(
        (acc, item) => {
          if (!item || typeof item.id !== 'number') return acc
          acc[item.id] = {
            id: item.id,
            commission_basis: item.commission_basis ?? null,
            commission_rate: item.commission_rate ?? null,
          }
          return acc
        },
        {}
      )
      setProjectMetaById(nextMap)
    } catch {
      setProjectMetaById({})
    }
  }, [session])

  const loadYearlySummary = useCallback(async () => {
    setSummaryLoading(true)
    try {
      const monthlyParams = new URLSearchParams({ year: summaryYear })
      const projectParams = new URLSearchParams({ year: summaryYear })
      if (countryFilter !== 'all') {
        monthlyParams.set('country', countryFilter)
        projectParams.set('country', countryFilter)
      }
      const [monthlyResp, projectResp] = await Promise.all([
        fetch(
          `${API_BASE}/api/v1/system-management/commission-management/summary/monthly?${monthlyParams.toString()}`,
          {
            cache: 'no-store',
            headers: buildBackendClientHeaders(session),
          }
        ),
        fetch(
          `${API_BASE}/api/v1/system-management/commission-management/summary/project?${projectParams.toString()}`,
          {
            cache: 'no-store',
            headers: buildBackendClientHeaders(session),
          }
        ),
      ])

      if (!monthlyResp.ok) {
        throw new Error(parseErrorBody(await monthlyResp.text(), monthlyResp.status))
      }
      if (!projectResp.ok) {
        throw new Error(parseErrorBody(await projectResp.text(), projectResp.status))
      }

      const monthlyPayload = (await monthlyResp.json()) as CommissionYearlyMonthlySummaryResponse
      const projectPayload = (await projectResp.json()) as CommissionProjectYearlySummaryResponse
      setMonthlySummary(Array.isArray(monthlyPayload.items) ? monthlyPayload.items : [])
      setProjectSummary(Array.isArray(projectPayload.items) ? projectPayload.items : [])
    } catch (loadError) {
      notify({
        type: 'error',
        title: '汇总数据加载失败',
        message: loadError instanceof Error ? loadError.message : '佣金数据加载失败',
      })
      setMonthlySummary([])
      setProjectSummary([])
    } finally {
      setSummaryLoading(false)
    }
  }, [session, summaryYear, notify, countryFilter])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    void loadProjectMeta()
  }, [loadProjectMeta])

  useEffect(() => {
    void loadExchangeRates()
  }, [loadExchangeRates])

  // Reload when country filter changes (but not for 'all' since we already have all data)
  useEffect(() => {
    if (countryFilter !== 'all') {
      void loadData()
    }
  }, [countryFilter, loadData])

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => a.project_id - b.project_id)
  }, [rows])

  const projectRows = useMemo((): ProjectRow[] => {
    return groupProjectsBySites(rows)
  }, [rows])

  const getOverviewCommissionRmb = useCallback((row: CommissionProjectMonth) => {
    return row.factory_commission_rmb
  }, [])

  useEffect(() => {
    if (
      activeTab === 'monthly' ||
      activeTab === 'projectSummary' ||
      activeTab === 'monthlyCollection'
    ) {
      void loadYearlySummary()
    }
  }, [activeTab, loadYearlySummary])

  const totalFactoryCommissionRmb = useMemo(() => {
    return sortedRows.reduce((sum, row) => sum + getOverviewCommissionRmb(row), 0)
  }, [getOverviewCommissionRmb, sortedRows])

  const totalReceivedRmb = useMemo(
    () => rows.reduce((sum, row) => sum + row.received_rmb, 0),
    [rows]
  )

  const yearlyTotals = useMemo(() => {
    return monthlySummary.reduce(
      (acc, item) => ({
        income: acc.income + item.income_total_usd,
        commission: acc.commission + item.factory_commission_rmb,
        received: acc.received + item.received_rmb,
      }),
      { income: 0, commission: 0, received: 0 }
    )
  }, [monthlySummary])

  const patchProjectMonthPayment = async (
    row: CommissionProjectMonth,
    paymentStatus: PaymentStatus,
    receivedRmb: number
  ) => {
    const response = await fetch(
      `${API_BASE}/api/v1/system-management/commission-management/project-months/${row.id}/payment`,
      {
        method: 'PATCH',
        headers: buildBackendClientHeaders(session, { contentType: 'application/json' }),
        body: JSON.stringify({
          payment_status: paymentStatus,
          received_rmb: receivedRmb,
          note: row.note,
        }),
      }
    )
    if (!response.ok) {
      throw new Error(parseErrorBody(await response.text(), response.status))
    }
    const payload = (await response.json()) as { item?: CommissionProjectMonth }
    if (payload.item) {
      setRows((prev) => prev.map((item) => (item.id === payload.item!.id ? payload.item! : item)))
      setReceivedDraftById((prev) => ({
        ...prev,
        [payload.item!.id]: payload.item!.received_rmb.toFixed(2),
      }))
    }
  }

  const updatePaymentStatus = async (row: CommissionProjectMonth, status: PaymentStatus) => {
    setUpdatingId(row.id)
    try {
      const draftValue = Number(receivedDraftById[row.id] ?? row.received_rmb)
      const normalizedDraft = Number.isFinite(draftValue)
        ? Math.max(0, draftValue)
        : row.received_rmb
      const receivedRmb =
        status === 'paid'
          ? getOverviewCommissionRmb(row)
          : status === 'unpaid'
            ? 0
            : normalizedDraft
      await patchProjectMonthPayment(row, status, receivedRmb)
    } catch (updateError) {
      notify({
        type: 'error',
        title: '回款状态更新失败',
        message: updateError instanceof Error ? updateError.message : '回款状态更新失败',
      })
    } finally {
      setUpdatingId(null)
    }
  }

  const updateReceivedAmount = async (row: CommissionProjectMonth) => {
    setUpdatingId(row.id)
    try {
      const parsed = Number(receivedDraftById[row.id])
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error('已回款金额必须是大于等于0的数字')
      }
      await patchProjectMonthPayment(row, row.payment_status, parsed)
    } catch (updateError) {
      notify({
        type: 'error',
        title: '已回款金额更新失败',
        message: updateError instanceof Error ? updateError.message : '已回款金额更新失败',
      })
    } finally {
      setUpdatingId(null)
    }
  }

  const handleRefresh = () => {
    if (activeTab === 'detail') {
      void Promise.all([loadData(), loadProjectMeta(), loadExchangeRates()])
      return
    }
    void loadYearlySummary()
  }

  // —— BLF-826 阶段 B/C：head 插槽 + 全局刷新 ——
  // 刷新语义：当前月份/年份与站点筛选下重新拉取。
  const refreshRef = useRef(handleRefresh)
  refreshRef.current = handleRefresh
  useHeaderRefresh(() => refreshRef.current())

  const handleRecompute = async () => {
    setRecomputing(true)
    try {
      const params = new URLSearchParams()
      if (countryFilter !== 'all') {
        params.set('country', countryFilter)
      }
      const url = `${API_BASE}/api/v1/system-management/commission-management/recompute${params.toString() ? '?' + params.toString() : ''}`
      const response = await fetch(url, {
        method: 'POST',
        headers: buildBackendClientHeaders(session, { contentType: 'application/json' }),
        body: JSON.stringify({ report_month: month }),
      })
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }

      await response.json()
      await Promise.all([
        loadData(),
        loadProjectMeta(),
        activeTab === 'monthly' || activeTab === 'projectSummary'
          ? loadYearlySummary()
          : Promise.resolve(),
      ])
      notify({ type: 'success', title: '佣金重新核算完成' })
    } catch (recomputeError) {
      notify({
        type: 'error',
        title: '佣金核算失败',
        message: recomputeError instanceof Error ? recomputeError.message : '佣金核算失败',
      })
    } finally {
      setRecomputing(false)
    }
  }

  const resetFilters = () => {
    setMonth(lastMonthString())
    setSummaryYear(getCurrentYear())
    setCountryFilter('all')
  }

  const filterControls = (
    <>
      {activeTab === 'detail' ? (
        <MonthPicker
          value={parseMonthInputValue(month)}
          onChange={(date) => setMonth(date ? formatMonthInputValue(date) : month)}
          className={cn('h-10 w-full justify-start border-term-border bg-term-panel px-2 font-mono text-xs shadow-none', TERM_HEADER_W_SM)}
        />
      ) : (
        <Select
          value={summaryYear}
          onValueChange={(value) => setSummaryYear(value)}
        >
          <SelectTrigger className={cn('h-10 w-full rounded-none border-term-border bg-term-panel text-xs shadow-none', TERM_HEADER_W_SM)}>
            <SelectValue placeholder="年份" />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - i).map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}年
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Select
        value={countryFilter}
        onValueChange={(value) => setCountryFilter(value as SiteCode | 'all')}
      >
        <SelectTrigger className={cn('h-10 w-full rounded-none border-term-border bg-term-panel text-xs shadow-none', TERM_HEADER_W_SM)}>
          <SelectValue placeholder="站点" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部站点</SelectItem>
          {SITE_ORDER.map((code) => (
            <SelectItem key={code} value={code}>
              {SITE_INFO[code].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {activeTab === 'detail' ? (
        <>
          <HeaderSlotButton variant="muted" onClick={resetFilters}>重置</HeaderSlotButton>
          <HeaderSlotButton variant="primary" onClick={() => void handleRecompute()} disabled={recomputing || loading}>
            {recomputing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            核算
          </HeaderSlotButton>
        </>
      ) : null}

      {/* 本月/年度统计：head 内 mono 元信息（不占页面纵向空间） */}
      {activeTab === 'detail' ? (
        <div className="hidden h-10 items-center gap-3 border border-term-border bg-term-panel px-2 font-mono text-xs tabular-nums xl:flex">
          <span className="uppercase tracking-wider text-term-faint">本月</span>
          <span className="text-term-muted">
            工厂佣金 <span className="text-term-text">{formatRmb(totalFactoryCommissionRmb)}</span>
          </span>
          <span className="text-term-muted">
            已回款 <span className="text-term-text">{formatRmb(totalReceivedRmb)}</span>
          </span>
        </div>
      ) : null}
      {(activeTab === 'monthly' || activeTab === 'projectSummary') ? (
        <div className="hidden h-10 items-center gap-3 border border-term-border bg-term-panel px-2 font-mono text-xs tabular-nums xl:flex">
          <span className="uppercase tracking-wider text-term-faint">{summaryYear}</span>
          <span className="text-term-muted">
            销售 <span className="text-term-text">{formatUsd(yearlyTotals.income)}</span>
          </span>
          <span className="text-term-muted">
            佣金 <span className="text-term-text">{formatRmb(yearlyTotals.commission)}</span>
          </span>
          <span className="text-term-muted">
            回款 <span className="text-term-text">{formatRmb(yearlyTotals.received)}</span>
          </span>
        </div>
      ) : null}
    </>
  )

  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={filterControls} />
  )

  // BLF-931 · 移动端：筛选控件下迁为正文顶部可折叠筛选条
  const mobileMonthLabel = activeTab === 'detail' ? month : `${summaryYear} 年`
  const mobileCountryLabel = countryFilter === 'all' ? '全部站点' : (SITE_INFO[countryFilter]?.label ?? countryFilter)
  const mobileFilterSummary = `${mobileMonthLabel} · ${mobileCountryLabel}`
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      controls={
        <>
          <MobileFilterWide>
            {activeTab === 'detail' ? (
              <MonthPicker
                value={parseMonthInputValue(month)}
                onChange={(date) => setMonth(date ? formatMonthInputValue(date) : month)}
                className="h-10 w-full justify-start border-term-border bg-term-panel px-2 font-mono text-xs shadow-none"
              />
            ) : (
              <Select
                value={summaryYear}
                onValueChange={(value) => setSummaryYear(value)}
              >
                <SelectTrigger className="h-10 w-full rounded-none border-term-border bg-term-panel text-xs shadow-none">
                  <SelectValue placeholder="年份" />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - i).map((y) => (
                    <SelectItem key={y} value={String(y)}>
                      {y}年
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </MobileFilterWide>
          <Select
            value={countryFilter}
            onValueChange={(value) => setCountryFilter(value as SiteCode | 'all')}
          >
            <SelectTrigger className="h-10 w-full rounded-none border-term-border bg-term-panel text-xs shadow-none">
              <SelectValue placeholder="站点" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部站点</SelectItem>
              {SITE_ORDER.map((code) => (
                <SelectItem key={code} value={code}>
                  {SITE_INFO[code].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {activeTab === 'detail' ? (
            <MobileFilterWide>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleRecompute()}
                disabled={recomputing || loading}
                className="h-10 w-full gap-1 rounded-none border-term-border px-2 text-xs shadow-none hover:bg-term-hover hover:text-term-text"
              >
                {recomputing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
                )}
                核算
              </Button>
            </MobileFilterWide>
          ) : null}
        </>
      }
    />
  )

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* BLF-826 阶段 C：月份/年份 + 站点 + 核算已上移 Top Header 中段插槽 */}
      {headerSlotPortal}
      {/* BLF-931：移动端折叠筛选条（正文顶部，md:hidden 挂载点内） */}
      {mobileFilterStrip}

      {/* Tab 切换：BLF-883 全局统一 variant="term" + 前置 icon */}
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as CommissionViewTab)}
        className="w-full"
      >
        <TabsList variant="term" className="w-fit justify-start">
          {(
            [
              ['detail', '总览', LayoutDashboard],
              ['monthly', '年-月汇总', CalendarRange],
              ['projectSummary', '项目汇总', FolderKanban],
              ['monthlyCollection', '月度回款', Wallet],
            ] as Array<[CommissionViewTab, string, typeof LayoutDashboard]>
          ).map(([key, label, Icon]) => (
            <TabsTrigger key={key} value={key} variant="term">
              <Icon aria-hidden />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <TermPanel bodyClassName="flex min-h-0 flex-col overflow-hidden">
        {loading && activeTab === 'detail' ? null : null}
        {activeTab === 'detail' ? (
          <DetailTab
            projectRows={projectRows}
            exchangeRates={exchangeRates}
            projectMetaById={projectMetaById}
            loading={loading}
            updatingId={updatingId}
            receivedDraftById={receivedDraftById}
            onUpdateDraft={(id, value) =>
              setReceivedDraftById((prev) => ({ ...prev, [id]: value }))
            }
            onUpdatePaymentStatus={updatePaymentStatus}
            onUpdateReceivedAmount={updateReceivedAmount}
          />
        ) : activeTab === 'monthly' ? (
          <MonthlySummaryTab
            items={monthlySummary}
            year={summaryYear}
            loading={summaryLoading}
          />
        ) : activeTab === 'projectSummary' ? (
          <ProjectSummaryTab
            items={projectSummary}
            year={summaryYear}
            loading={summaryLoading}
          />
        ) : activeTab === 'monthlyCollection' ? (
          <MonthlyCollectionTab
            items={projectSummary}
            year={summaryYear}
            loading={summaryLoading}
          />
        ) : null}
      </TermPanel>

      <CommissionRulesCard />
    </div>
  )
}
