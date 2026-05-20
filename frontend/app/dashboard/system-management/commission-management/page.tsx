'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { MonthNavigation, RefreshButton, YearNavigation } from '@/components/dashboard/console'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { formatMonthInputValue, parseMonthInputValue } from '@/components/ui/date-picker'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { buildBackendHeaders } from '@/lib/backend-auth'
import { useNotifications } from '@/components/notifications'
import { DetailTab } from './detail-tab'
import { MonthlySummaryTab } from './monthly-summary-tab'
import { ProjectSummaryTab } from './project-summary-tab'
import { MonthlyCollectionTab } from './monthly-collection-tab'
import { CommissionRulesCard } from './commission-rules-card'

type PaymentStatus = 'paid' | 'partial' | 'unpaid'

type CommissionProjectMonth = {
  id: number
  report_month: string
  country: string
  project_id: number
  project_name: string
  income_total_usd: number
  factory_commission_rate: number
  factory_commission_rmb: number
  payment_status: PaymentStatus
  received_rmb: number
  note: string | null
}

type CommissionProjectMonthsResponse = {
  report_month: string
  items: CommissionProjectMonth[]
}

type ExchangeRate = {
  currency: string
  rate: number
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

type ProjectMeta = {
  id: number
  commission_basis: string | null
  commission_rate: number | null
}

type SiteCode = "US" | "UK" | "DE"

const API_BASE = '/api/backend'
const CURRENCY_MAP: Record<string, string> = {
  US: 'USD',
  UK: 'GBP',
  DE: 'EUR',
}

function lastMonthString(): string {
  const now = new Date()
  now.setMonth(now.getMonth() - 1)
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function getCurrentYear(): string {
  return new Date().getFullYear().toString()
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

function formatRmb(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}¥${text}`
}

function formatUsd(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}$${text}`
}

export default function CommissionManagementPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const [month, setMonth] = useState(lastMonthString())
  const [summaryYear, setSummaryYear] = useState(getCurrentYear())
  const [activeTab, setActiveTab] = useState<CommissionViewTab>('detail')
  const [site, setSite] = useState<SiteCode>("US")

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

  // 展开状态管理
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set())

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
      const response = await fetch(`${API_BASE}/api/v1/system-management/commission-management/project-months?report_month=${month}`, {
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
  }, [month, session, notify])

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
      const [monthlyResp, projectResp] = await Promise.all([
        fetch(`${API_BASE}/api/v1/system-management/commission-management/summary/monthly?year=${summaryYear}&country=${site}`, {
          cache: 'no-store',
          headers: buildBackendHeaders(session),
        }),
        fetch(`${API_BASE}/api/v1/system-management/commission-management/summary/project?year=${summaryYear}&country=${site}`, {
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
  }, [session, summaryYear, notify, site])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    void loadProjectMeta()
  }, [loadProjectMeta])

  useEffect(() => {
    void loadExchangeRates()
  }, [loadExchangeRates])

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => a.project_id - b.project_id)
  }, [rows])

  // 获取汇率
  const getExchangeRate = useCallback((currency: string): number => {
    const rate = exchangeRates.find(r => r.currency === currency)
    return rate?.rate ?? 1
  }, [exchangeRates])

  // 将金额转换为 USD（通过 CNY 中间转换）
  const convertToUsd = useCallback((amountRmb: number, country: string): number => {
    if (country === 'US') return amountRmb // US 已经是 USD，直接使用原值（这里假设原值是 USD）
    // EU/UK: 需要将 amountRmb 转换为 USD
    // amountRmb 是以目的地货币计的价值，需要先确定它是哪种货币
    // 根据数据结构，factory_commission_rmb 是人民币
    // income_total_usd 是美元
    // factory_commission_usd 应该也是美元（如果已计算）
    // 这里我们需要知道汇率来转换
    const targetCurrency = CURRENCY_MAP[country] || 'USD'
    const rate = getExchangeRate(targetCurrency)
    if (rate && rate > 0) {
      return amountRmb / rate
    }
    return amountRmb
  }, [getExchangeRate])

  // 按项目分组数据
  const projectGroups = useMemo(() => {
    const groups: Record<number, {
      project_id: number
      project_name: string
      rows: CommissionProjectMonth[]
      totalIncomeUsd: number
      totalCommissionRmb: number
      totalIncomeUsdConverted: number
    }> = {}

    for (const row of rows) {
      if (!groups[row.project_id]) {
        groups[row.project_id] = {
          project_id: row.project_id,
          project_name: row.project_name,
          rows: [],
          totalIncomeUsd: 0,
          totalCommissionRmb: 0,
          totalIncomeUsdConverted: 0,
        }
      }
      groups[row.project_id].rows.push(row)
      groups[row.project_id].totalIncomeUsd += row.income_total_usd
      groups[row.project_id].totalCommissionRmb += row.factory_commission_rmb
    }

    // 计算转换后的 USD 合计
    for (const group of Object.values(groups)) {
      let totalConverted = 0
      for (const row of group.rows) {
        // income_total_usd 已经是 USD，所以需要根据 country 判断
        // 但从 API 返回的数据来看，income_total_usd 已经是美元的销售额
        // 而 factory_commission_rmb 是人民币
        // 为了计算合计，我们需要将所有收入转换为美元
        // 汇率转换：CNY -> USD
        const usdToCnyRate = getExchangeRate('CNY') || 7.2 // 假设默认 7.2
        if (row.country === 'US') {
          totalConverted += row.income_total_usd
        } else {
          // DE/UK: 假设 income_total_usd 是以目的地货币计的销售额
          // 需要转换为 USD
          const countryCurrency = CURRENCY_MAP[row.country]
          const countryRate = getExchangeRate(countryCurrency)
          if (countryRate && countryRate > 0) {
            // 假设 income_total_usd 实际是以目的地货币计的销售额
            // 需要先转为 CNY，再转为 USD
            // CNY = income * country_rate
            // USD = CNY / usdToCnyRate
            const cnyAmount = row.income_total_usd * countryRate
            totalConverted += cnyAmount / usdToCnyRate
          } else {
            totalConverted += row.income_total_usd
          }
        }
      }
      group.totalIncomeUsdConverted = totalConverted
    }

    // 检查哪些项目有多站点
    const multiSiteProjects = new Set<number>()
    for (const group of Object.values(groups)) {
      const countries = new Set(group.rows.map(r => r.country))
      if (countries.size > 1) {
        multiSiteProjects.add(group.project_id)
      }
    }

    return {
      groups: Object.values(groups).sort((a, b) => a.project_id - b.project_id),
      multiSiteProjects,
    }
  }, [rows, getExchangeRate])

  // 切换项目展开状态
  const toggleProject = useCallback((projectId: number) => {
    setExpandedProjects(prev => {
      const next = new Set(prev)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

  // 初始展开所有多站点项目
  useEffect(() => {
    if (projectGroups.multiSiteProjects.size > 0) {
      setExpandedProjects(projectGroups.multiSiteProjects)
    }
  }, [projectGroups.multiSiteProjects])

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
      const response = await fetch(`${API_BASE}/api/v1/system-management/commission-management/recompute`, {
        method: 'POST',
        headers: buildBackendHeaders(session, { contentType: 'application/json' }),
        body: JSON.stringify({ report_month: month, country: site }),
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

                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="rounded bg-blue-100 px-2 py-1 font-medium text-blue-700">🇺🇸 US</span>
                    <span className="rounded bg-green-100 px-2 py-1 font-medium text-green-700">🇬🇧 UK</span>
                    <span className="rounded bg-purple-100 px-2 py-1 font-medium text-purple-700">🇩🇪 DE</span>
                    <span className="ml-1">显示所有站点</span>
                  </div>
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
              projectGroups={projectGroups}
              exchangeRates={exchangeRates}
              projectMetaById={projectMetaById}
              loading={loading}
              updatingId={updatingId}
              expandedProjects={expandedProjects}
              onToggleProject={toggleProject}
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