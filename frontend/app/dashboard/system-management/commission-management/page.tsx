'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { MonthNavigation, RefreshButton, YearNavigation } from '@/components/dashboard/console'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { formatMonthInputValue, parseMonthInputValue } from '@/components/ui/date-picker'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { buildBackendHeaders } from '@/lib/backend-auth'
import { useNotifications } from '@/components/notifications'
import { DetailTab } from './detail-tab'
import { MonthlySummaryTab } from './monthly-summary-tab'
import { ProjectSummaryTab } from './project-summary-tab'
import { MonthlyCollectionTab } from './monthly-collection-tab'
import { CommissionRulesCard } from './commission-rules-card'
import { groupProjectsBySites, formatRmb, formatUsd, SITE_INFO } from './utils'
import type { CommissionProjectMonth, ExchangeRate, ProjectMeta, PaymentStatus, SiteCode, ProjectRow } from './types'
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
    const payload = JSON.parse(text) as { detail?: string | unknown[] | Record<string, unknown>; error?: string }
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
        headers: buildBackendHeaders(session),
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
      const response = await fetch(`${API_BASE}/api/v1/system-management/commission-management/project-months?${params.toString()}`, {
        cache: 'no-store',
        headers: buildBackendHeaders(session),
      })
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
      notify({ type: 'error', title: '佣金数据加载失败', message: loadError instanceof Error ? loadError.message : '佣金数据加载失败' })
      setRows([])
      setReceivedDraftById({})
    } finally {
      setLoading(false)
    }
  }, [month, session, countryFilter])

  const loadProjectMeta = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/manage`, {
        cache: 'no-store',
        headers: buildBackendHeaders(session),
      })
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as ProjectMeta[]
      const nextMap = (Array.isArray(payload) ? payload : []).reduce<Record<number, ProjectMeta>>((acc, item) => {
        if (!item || typeof item.id !== 'number') return acc
        acc[item.id] = {
          id: item.id,
          commission_basis: item.commission_basis ?? null,
          commission_rate: item.commission_rate ?? null,
        }
        return acc
      }, {})
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
        fetch(`${API_BASE}/api/v1/system-management/commission-management/summary/monthly?${monthlyParams.toString()}`, {
          cache: 'no-store',
          headers: buildBackendHeaders(session),
        }),
        fetch(`${API_BASE}/api/v1/system-management/commission-management/summary/project?${projectParams.toString()}`, {
          cache: 'no-store',
          headers: buildBackendHeaders(session),
        }),
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
      notify({ type: 'error', title: '汇总数据加载失败', message: loadError instanceof Error ? loadError.message : '佣金数据加载失败' })
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
    if (activeTab === 'monthly' || activeTab === 'projectSummary' || activeTab === 'monthlyCollection') {
      void loadYearlySummary()
    }
  }, [activeTab, loadYearlySummary])

  const totalFactoryCommissionRmb = useMemo(() => {
    return sortedRows.reduce((sum, row) => sum + getOverviewCommissionRmb(row), 0)
  }, [getOverviewCommissionRmb, sortedRows])

  const totalReceivedRmb = useMemo(() => rows.reduce((sum, row) => sum + row.received_rmb, 0), [rows])

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

  const patchProjectMonthPayment = async (row: CommissionProjectMonth, paymentStatus: PaymentStatus, receivedRmb: number) => {
    const response = await fetch(`${API_BASE}/api/v1/system-management/commission-management/project-months/${row.id}/payment`, {
      method: 'PATCH',
      headers: buildBackendHeaders(session, { contentType: 'application/json' }),
      body: JSON.stringify({
        payment_status: paymentStatus,
        received_rmb: receivedRmb,
        note: row.note,
      }),
    })
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
      const normalizedDraft = Number.isFinite(draftValue) ? Math.max(0, draftValue) : row.received_rmb
      const receivedRmb = status === 'paid' ? getOverviewCommissionRmb(row) : status === 'unpaid' ? 0 : normalizedDraft
      await patchProjectMonthPayment(row, status, receivedRmb)
    } catch (updateError) {
      notify({ type: 'error', title: '回款状态更新失败', message: updateError instanceof Error ? updateError.message : '回款状态更新失败' })
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
      notify({ type: 'error', title: '已回款金额更新失败', message: updateError instanceof Error ? updateError.message : '已回款金额更新失败' })
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
        headers: buildBackendHeaders(session, { contentType: 'application/json' }),
        body: JSON.stringify({ report_month: month }),
      })
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }

      await response.json()
      await Promise.all([
        loadData(),
        loadProjectMeta(),
        activeTab === 'monthly' || activeTab === 'projectSummary' ? loadYearlySummary() : Promise.resolve(),
      ])
      notify({ type: 'success', title: '佣金重新核算完成' })
    } catch (recomputeError) {
      notify({ type: 'error', title: '佣金核算失败', message: recomputeError instanceof Error ? recomputeError.message : '佣金核算失败' })
    } finally {
      setRecomputing(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1520px] flex-col gap-4 pb-6">
      <div className="flex">
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as CommissionViewTab)} className="w-full">
          <TabsList className="min-h-12 rounded-2xl p-1.5">
            <TabsTrigger value="detail" className="min-h-10 px-5 py-2 text-sm">
              总览
            </TabsTrigger>
            <TabsTrigger value="monthly" className="min-h-10 px-5 py-2 text-sm">
              年-月汇总
            </TabsTrigger>
            <TabsTrigger value="projectSummary" className="min-h-10 px-5 py-2 text-sm">
              项目汇总
            </TabsTrigger>
            <TabsTrigger value="monthlyCollection" className="min-h-10 px-5 py-2 text-sm">
              月度回款
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <Card className="shrink-0 border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)] dark:border-border/80 dark:bg-[hsl(var(--surface-panel))] dark:shadow-[0_24px_50px_-30px_rgba(0,0,0,0.45)]">
        <CardHeader className="hidden" />
        <CardContent className="space-y-3 p-6 md:p-7">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-3">
              {activeTab === 'detail' ? (
                <>
                  <MonthNavigation
                    value={parseMonthInputValue(month)}
                    onChange={(date) => setMonth(formatMonthInputValue(date))}
                  />
                </>
              ) : (
                <YearNavigation
                  value={Number(summaryYear)}
                  onChange={(year) => setSummaryYear(String(year))}
                />
              )}

              <RefreshButton
                onClick={handleRefresh}
                loading={activeTab === 'detail' ? loading : summaryLoading}
                disabled={recomputing}
              />

              {activeTab === 'detail' ? (
                <Select
                  value={countryFilter}
                  onValueChange={(value) => setCountryFilter(value as SiteCode | 'all')}
                >
                  <SelectTrigger className="w-[100px]">
                    <SelectValue placeholder="站点" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部站点</SelectItem>
                    {SITE_ORDER.map((code) => (
                      <SelectItem key={code} value={code}>
                        <span className="flex items-center gap-2">
                          <span className={`h-1.5 w-1.5 rounded-full ${SITE_INFO[code].dotClass}`} />
                          {SITE_INFO[code].label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}

              {activeTab === 'detail' ? (
                <Button
                  onClick={() => void handleRecompute()}
                  disabled={recomputing || loading}
                >
                  {recomputing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  核算
                </Button>
              ) : null}
            </div>

            <div className="grid min-w-[280px] grid-cols-[112px_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-sm">
              {activeTab === 'detail' ? (
                <>
                  <div className="col-span-2 text-xs font-medium tracking-[0.18em] text-muted-foreground/70">本月统计</div>
                  <div className="text-muted-foreground">工厂佣金合计</div>
                  <div className="font-semibold tabular-nums text-foreground">{formatRmb(totalFactoryCommissionRmb)}</div>
                  <div className="text-muted-foreground">已回款</div>
                  <div className="font-semibold tabular-nums text-foreground">{formatRmb(totalReceivedRmb)}</div>
                </>
              ) : null}
              {(activeTab === 'monthly' || activeTab === 'projectSummary') ? (
                <>
                  <div className="col-span-2 text-xs font-medium tracking-[0.18em] text-muted-foreground/70">年度统计</div>
                  <div className="text-muted-foreground">年度销售</div>
                  <div className="font-semibold tabular-nums text-foreground">{formatUsd(yearlyTotals.income)}</div>
                  <div className="text-muted-foreground">年度工厂佣金</div>
                  <div className="font-semibold tabular-nums text-foreground">{formatRmb(yearlyTotals.commission)}</div>
                  <div className="text-muted-foreground">年度回款</div>
                  <div className="font-semibold tabular-nums text-foreground">{formatRmb(yearlyTotals.received)}</div>
                </>
              ) : null}
            </div>
          </div>

        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)] dark:border-border/80 dark:bg-[hsl(var(--surface-panel))] dark:shadow-[0_24px_50px_-30px_rgba(0,0,0,0.45)]">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          {activeTab === 'detail' ? (
            <DetailTab
              projectRows={projectRows}
              exchangeRates={exchangeRates}
              projectMetaById={projectMetaById}
              loading={loading}
              updatingId={updatingId}
              receivedDraftById={receivedDraftById}
              onUpdateDraft={(id, value) => setReceivedDraftById((prev) => ({ ...prev, [id]: value }))}
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
        </CardContent>
      </Card>

      <CommissionRulesCard />
    </div>
  )
}