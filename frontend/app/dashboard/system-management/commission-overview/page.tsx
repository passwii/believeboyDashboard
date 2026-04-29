'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { MonthNavigation, RefreshButton, YearNavigation } from '@/components/dashboard/console'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { MonthPicker, formatMonthInputValue, parseMonthInputValue } from '@/components/ui/date-picker'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { buildBackendHeaders } from '@/lib/backend-auth'
import { useNotifications } from '@/components/notifications'

type PaymentStatus = 'paid' | 'partial' | 'unpaid'

type CommissionProjectMonth = {
  id: number
  report_month: string
  project_id: number
  project_name: string
  income_total_usd: number
  factory_commission_rate: number
  usd_to_rmb_rate: number
  factory_commission_usd: number
  factory_commission_rmb: number
  payment_status: PaymentStatus
  received_rmb: number
  payment_confirmed_at: string | null
  payment_confirmed_by: string | null
  note: string | null
  computed_at: string
  updated_at: string
}

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

type CommissionViewTab = 'detail' | 'monthly' | 'projectSummary'

type ProjectMeta = {
  id: number
  commission_basis: string | null
  commission_rate: number | null
}

const API_BASE = '/api/backend'
const FULL_BLEED_TABLE_CLASS = "[&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:py-3 sm:[&_th]:px-4 sm:[&_td]:px-4"
const FULL_BLEED_TABLE_CONTAINER_CLASS = "-m-px h-[calc(100%+2px)] w-[calc(100%+2px)] rounded-none"

function lastMonthString(): string {
  const now = new Date()
  now.setMonth(now.getMonth() - 1)
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function getYearMonths(year: string): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
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

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function toPaymentLabel(value: PaymentStatus): string {
  if (value === 'paid') return '已回款'
  if (value === 'partial') return '部分回款'
  return '未回款'
}

const PROJECT_COMMISSION_RULES = [
  {
    code: 'Rule 01',
    title: '销售额佣金计算',
    tag: '按销售额',
    description: '按销售额提成',
  },
  {
    code: 'Rule 02',
    title: '回款佣金核算',
    tag: '按回款率',
    description: '按回款提成',
    tiers: [
      '40% - 50% -> 7%',
      '50% - 60% -> 10%',
      '60% - 70% -> 13%',
      '70% 以上 -> 15%',
    ],
  },
] as const

export default function CommissionOverviewPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const [month, setMonth] = useState(lastMonthString())
  const [summaryYear, setSummaryYear] = useState(getCurrentYear())
  const [activeTab, setActiveTab] = useState<CommissionViewTab>('detail')

  const [loading, setLoading] = useState(true)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [recomputing, setRecomputing] = useState(false)

  const [rows, setRows] = useState<CommissionProjectMonth[]>([])
  const [monthlySummary, setMonthlySummary] = useState<CommissionYearlyMonthlySummaryItem[]>([])
  const [projectSummary, setProjectSummary] = useState<CommissionProjectYearlySummaryItem[]>([])
  const [projectMetaById, setProjectMetaById] = useState<Record<number, ProjectMeta>>({})

  const [updatingId, setUpdatingId] = useState<number | null>(null)
  const [receivedDraftById, setReceivedDraftById] = useState<Record<number, string>>({})

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
        fetch(`${API_BASE}/api/v1/system-management/commission-management/summary/monthly?year=${summaryYear}`, {
          cache: 'no-store',
          headers: buildBackendHeaders(session),
        }),
        fetch(`${API_BASE}/api/v1/system-management/commission-management/summary/project?year=${summaryYear}`, {
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
      notify({ type: 'error', title: '汇总数据加载失败', message: loadError instanceof Error ? loadError.message : '汇总数据加载失败' })
      setMonthlySummary([])
      setProjectSummary([])
    } finally {
      setSummaryLoading(false)
    }
  }, [session, summaryYear, notify])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    void loadProjectMeta()
  }, [loadProjectMeta])

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => a.project_id - b.project_id)
  }, [rows])

  const getOverviewCommissionRmb = useCallback((row: CommissionProjectMonth) => {
    return row.factory_commission_rmb
  }, [])

  useEffect(() => {
    if (activeTab === 'monthly' || activeTab === 'projectSummary') {
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
      void Promise.all([loadData(), loadProjectMeta()])
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

  const getDetailCommissionRatioLabel = useCallback((row: CommissionProjectMonth): string => {
    const projectMeta = projectMetaById[row.project_id]
    if (!projectMeta) {
      return formatPercent(row.factory_commission_rate)
    }

    if (projectMeta.commission_basis === 'cash_received') {
      return '阶梯(7/10/13/15%)'
    }

    if (typeof projectMeta.commission_rate === 'number' && Number.isFinite(projectMeta.commission_rate)) {
      return formatPercent(projectMeta.commission_rate)
    }

    return formatPercent(row.factory_commission_rate)
  }, [projectMetaById])

  const renderMonthlySummaryTable = () => (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <div className="flex-1 overflow-auto">
        <Table className={FULL_BLEED_TABLE_CLASS} containerClassName={FULL_BLEED_TABLE_CONTAINER_CLASS}>
          <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45 sticky top-0 z-10">
            <TableRow>
              <TableHead className="font-semibold text-foreground">月份</TableHead>
              <TableHead className="text-right font-semibold text-foreground">销售收入(USD)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">工厂佣金(USD)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">工厂佣金(RMB)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">已回款(RMB)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">回款率</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaryLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">加载中...</TableCell>
              </TableRow>
            ) : monthlySummary.length === 0 ? (
              <EmptyTableState colSpan={6} message={`${summaryYear}年暂无数据`} />
            ) : (
              monthlySummary.map((item) => (
                <TableRow key={item.report_month}>
                  <TableCell className="font-medium">{item.report_month}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsd(item.income_total_usd)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsd(item.factory_commission_usd)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRmb(item.factory_commission_rmb)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRmb(item.received_rmb)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(item.receive_rate)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )

  const renderProjectSummaryTable = () => (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
        <Table className={FULL_BLEED_TABLE_CLASS} containerClassName={`${FULL_BLEED_TABLE_CONTAINER_CLASS} overflow-auto`}>
          <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45">
            <TableRow>
              <TableHead className="sticky left-0 top-0 z-30 whitespace-nowrap bg-slate-100/90 font-semibold text-foreground dark:bg-slate-900/60">项目名称</TableHead>
              {getYearMonths(summaryYear).map((m) => (
                <TableHead key={m} className="sticky top-0 z-20 bg-slate-100/90 text-right text-xs whitespace-nowrap font-semibold text-foreground dark:bg-slate-900/60">
                  {m.slice(5)}月佣金
                </TableHead>
              ))}
              <TableHead className="sticky top-0 z-20 bg-slate-100/90 text-right whitespace-nowrap font-semibold text-foreground dark:bg-slate-900/60">年度佣金合计</TableHead>
              <TableHead className="sticky top-0 z-20 bg-slate-100/90 text-right whitespace-nowrap font-semibold text-foreground dark:bg-slate-900/60">年度回款</TableHead>
              <TableHead className="sticky top-0 z-20 bg-slate-100/90 text-right whitespace-nowrap font-semibold text-foreground dark:bg-slate-900/60">回款率</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaryLoading ? (
              <TableRow>
                <TableCell colSpan={16} className="text-center text-muted-foreground">加载中...</TableCell>
              </TableRow>
            ) : projectSummary.length === 0 ? (
              <EmptyTableState colSpan={16} message={`${summaryYear}年暂无数据`} />
            ) : (
              projectSummary.map((project) => (
                <TableRow key={project.project_id}>
                  <TableCell className="sticky left-0 bg-background z-20 font-medium">{project.project_name}</TableCell>
                  {getYearMonths(summaryYear).map((m) => {
                    const monthData = project.months[m]
                    return (
                      <TableCell key={m} className="text-right tabular-nums text-xs">
                        {monthData ? formatRmb(monthData.factory_commission_rmb) : '-'}
                      </TableCell>
                    )
                  })}
                  <TableCell className="text-right tabular-nums font-medium">{formatRmb(project.total_commission_rmb)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRmb(project.total_received_rmb)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(project.receive_rate)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
    </div>
  )

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
          </TabsList>
        </Tabs>
      </div>

      <Card className="shrink-0 border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)] dark:border-border/80 dark:bg-[hsl(var(--surface-panel))] dark:shadow-[0_24px_50px_-30px_rgba(0,0,0,0.45)]">
        <CardHeader className="hidden" />
        <CardContent className="space-y-3 p-6 md:p-7">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-3">
              {activeTab === 'detail' ? (
                <MonthNavigation
                  value={parseMonthInputValue(month)}
                  onChange={(date) => setMonth(formatMonthInputValue(date))}
                />
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
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
              <div className="flex-1 overflow-auto">
                <Table className={FULL_BLEED_TABLE_CLASS} containerClassName={FULL_BLEED_TABLE_CONTAINER_CLASS}>
                  <TableHeader className="sticky top-0 z-10 bg-slate-100/80 dark:bg-slate-900/45">
                    <TableRow>
                      <TableHead className="font-semibold text-foreground">项目</TableHead>
                      <TableHead className="text-right font-semibold text-foreground">销售收入(USD)</TableHead>
                      <TableHead className="text-right font-semibold text-foreground">佣金比例</TableHead>
                      <TableHead className="text-right font-semibold text-foreground">工厂佣金(RMB)</TableHead>
                      <TableHead className="text-right font-semibold text-foreground">已回款(RMB，可编辑)</TableHead>
                      <TableHead className="font-semibold text-foreground">回款状态(可编辑)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">加载中...</TableCell>
                      </TableRow>
                    ) : rows.length === 0 ? (
                      <EmptyTableState colSpan={6} message="当前月份暂无数据，请先刷新核算" />
                    ) : (
                      sortedRows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>{row.project_name}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatUsd(row.income_total_usd)}</TableCell>
                          <TableCell className="text-right tabular-nums">{getDetailCommissionRatioLabel(row)}</TableCell>
                          <TableCell className="text-right tabular-nums font-medium">{formatRmb(getOverviewCommissionRmb(row))}</TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-2">
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                value={receivedDraftById[row.id] ?? ''}
                                className="h-9 w-[150px] text-right"
                                onChange={(event) => {
                                  const nextValue = event.target.value
                                  setReceivedDraftById((prev) => ({ ...prev, [row.id]: nextValue }))
                                }}
                                onBlur={() => {
                                  void updateReceivedAmount(row)
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    void updateReceivedAmount(row)
                                  }
                                }}
                                disabled={updatingId === row.id}
                              />
                            </div>
                          </TableCell>
                          <TableCell>
                            <Select
                              value={row.payment_status}
                              onValueChange={(value: PaymentStatus) => {
                                void updatePaymentStatus(row, value)
                              }}
                              disabled={updatingId === row.id}
                            >
                              <SelectTrigger className="w-[140px]">
                                <SelectValue placeholder={toPaymentLabel(row.payment_status)} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="paid">已回款</SelectItem>
                                <SelectItem value="partial">部分回款</SelectItem>
                                <SelectItem value="unpaid">未回款</SelectItem>
                              </SelectContent>
                            </Select>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : activeTab === 'monthly' ? (
            renderMonthlySummaryTable()
          ) : activeTab === 'projectSummary' ? (
            renderProjectSummaryTable()
          ) : null}
        </CardContent>
      </Card>

      <Card className="shrink-0 overflow-hidden border-border/80 bg-[linear-gradient(145deg,rgba(248,250,252,0.96),rgba(255,255,255,0.98)),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_32%),radial-gradient(circle_at_bottom_left,rgba(14,165,233,0.1),transparent_26%)] shadow-[0_20px_45px_-30px_rgba(15,23,42,0.28)] dark:border-border/80 dark:bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))] dark:shadow-[0_24px_50px_-30px_rgba(0,0,0,0.45)]">
        <div className="grid gap-4 p-5 xl:grid-cols-[0.92fr_1.45fr]">
            <aside className="relative overflow-hidden rounded-[28px] border border-slate-200/80 bg-[linear-gradient(180deg,rgba(14,165,233,0.08),rgba(255,255,255,0.92)),radial-gradient(circle_at_top_left,rgba(14,165,233,0.14),transparent_36%)] p-5 shadow-[0_18px_34px_-28px_rgba(15,23,42,0.45)] dark:border-border/80 dark:bg-[linear-gradient(180deg,hsl(var(--surface-soft)),hsl(var(--surface-panel)))] dark:shadow-none">
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-700/80 dark:text-sky-300/80">Project Commission</p>
                  <h3 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-foreground">工厂佣金结算备注</h3>
                  <p className="text-sm leading-6 text-slate-600 dark:text-muted-foreground/80">
                    这里展示的是项目与工厂之间的佣金结算口径。当前先引用现有两类规则作为说明，后续你可以继续补充更多结算规则。
                  </p>
                </div>

                <div className="rounded-2xl border border-white/80 bg-white/85 p-4 dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400 dark:text-muted-foreground/70">Rule Index</p>
                  <div className="mt-3 space-y-2">
                    {PROJECT_COMMISSION_RULES.map((item) => (
                      <div key={item.code} className="flex items-center justify-between rounded-2xl bg-slate-50/90 px-3 py-2.5 dark:bg-[hsl(var(--surface-soft))]">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-muted-foreground/70">{item.code}</p>
                          <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-foreground">{item.title}</p>
                        </div>
                        <span className="rounded-full border border-sky-200/80 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/12 dark:text-sky-300">
                          {item.tag}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl border border-dashed border-slate-300 bg-white/72 p-4 text-sm leading-6 text-slate-600 dark:border-border/70 dark:bg-[hsl(var(--surface-soft))] dark:text-muted-foreground/80">
                  当前区域作为结算手册占位。
                  <span className="font-medium text-slate-800 dark:text-foreground"> 未来新增规则 </span>
                  可以继续沿用右侧卡片结构补充。
                </div>
              </div>
            </aside>

            <div className="space-y-3">
              {PROJECT_COMMISSION_RULES.map((item) => (
                <article
                  key={item.title}
                  className="group relative overflow-hidden rounded-[28px] border border-white/85 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(248,250,252,0.9))] p-5 shadow-[0_20px_40px_-30px_rgba(15,23,42,0.42)] transition-colors duration-200 hover:border-sky-200/80 dark:border-border/80 dark:bg-[hsl(var(--surface-panel))] dark:hover:border-sky-500/25"
                >
                  <div className="absolute inset-y-5 left-0 w-1 rounded-full bg-gradient-to-b from-sky-500 via-cyan-400 to-emerald-400" />
                  <div className="pl-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400 dark:text-muted-foreground/70">{item.code}</p>
                        <h4 className="text-base font-semibold text-slate-900 dark:text-foreground">{item.title}</h4>
                      </div>
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 dark:border-slate-500/20 dark:bg-slate-500/12 dark:text-slate-200">
                        {item.tag}
                      </span>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-[0.9fr_1.5fr]">
                      <div className="rounded-2xl bg-slate-950/[0.035] p-4 dark:bg-[hsl(var(--surface-soft))]">
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400 dark:text-muted-foreground/70">适用口径</p>
                        <p className="mt-2 text-sm font-medium leading-6 text-slate-700 dark:text-foreground/90">
                          {item.tag === '按销售额' ? '按月销售收入与项目佣金点数核算' : '按回款率阶梯自动核算项目佣金'}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-slate-100 bg-white/82 p-4 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400 dark:text-muted-foreground/70">规则说明</p>
                        <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-muted-foreground/80">{item.description}</p>
                        {'tiers' in item ? (
                          <div className="mt-4 grid gap-2 sm:grid-cols-2">
                            {item.tiers.map((tier) => (
                              <div
                                key={tier}
                                className="rounded-xl border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-sm font-medium text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/12 dark:text-emerald-300"
                              >
                                {tier}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
        </div>
      </Card>
    </div>
  )
}
