'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { MonthPicker, formatMonthInputValue, parseMonthInputValue } from '@/components/ui/date-picker'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { buildBackendHeaders } from '@/lib/backend-auth'

type PaymentStatus = 'paid' | 'partial' | 'unpaid'
type IncomeCategory = 'operator' | 'assistant'

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

type CommissionRecord = {
  id: number
  report_month: string
  project_id: number
  project_name: string
  person_name: string
  income_category: IncomeCategory
  income_total_usd: number
  factory_commission_rate: number
  operator_bonus_ratio: number
  bonus_amount_rmb: number
  payment_status: 'paid' | 'unpaid'
}

type CommissionRecordsResponse = {
  report_month: string
  items: CommissionRecord[]
}

type CommissionViewTab = 'detail' | 'monthly' | 'projectSummary' | 'operation'

type ProjectMeta = {
  id: number
  commission_basis: string | null
  commission_rate: number | null
}

const API_BASE = '/api/backend'

function lastMonthString(): string {
  const now = new Date()
  now.setMonth(now.getMonth() - 1)
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function shiftMonth(value: string, offset: number): string {
  const matched = value.match(/^(\d{4})-(\d{2})$/)
  if (!matched) return value

  const year = Number(matched[1])
  const monthIndex = Number(matched[2]) - 1
  const date = new Date(year, monthIndex + offset, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
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

function toCategoryLabel(value: IncomeCategory): string {
  return value === 'operator' ? '运营' : '助理'
}

const OPERATOR_PUBLIC_COMMISSION_TIERS: Array<{ range: string; ratio: string; note?: string }> = [
  { range: '0 - 10,000 USD', ratio: '12%', note: '新店铺开售3个月内' },
  { range: '10,001 - 50,000 USD', ratio: '14%' },
  { range: '50,001 - 150,000 USD', ratio: '16%' },
  { range: '150,001 - 450,000 USD', ratio: '18%' },
  { range: '450,001 USD 以上', ratio: '20%' },
] as const

const PROJECT_COMMISSION_RULES = [
  {
    code: 'Rule 01',
    title: '销售额佣金计算',
    tag: '按销售额',
    description: '项目设置为按销售额计算时，按当月销售收入与项目佣金点数核算工厂佣金。',
  },
  {
    code: 'Rule 02',
    title: '回款佣金核算',
    tag: '按回款率',
    description: '项目设置为按回款核算时，按回款率阶梯自动计算项目佣金。',
    tiers: [
      '40% - 50% -> 7%',
      '50% - 60% -> 10%',
      '60% - 70% -> 13%',
      '70% 以上 -> 15%',
    ],
  },
] as const

export default function CommissionOverviewPage() {
  const { data: session } = useSession()
  const [month, setMonth] = useState(lastMonthString())
  const [summaryYear, setSummaryYear] = useState(getCurrentYear())
  const [activeTab, setActiveTab] = useState<CommissionViewTab>('detail')

  const [loading, setLoading] = useState(true)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [operationLoading, setOperationLoading] = useState(false)
  const [recomputing, setRecomputing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [rows, setRows] = useState<CommissionProjectMonth[]>([])
  const [monthlySummary, setMonthlySummary] = useState<CommissionYearlyMonthlySummaryItem[]>([])
  const [projectSummary, setProjectSummary] = useState<CommissionProjectYearlySummaryItem[]>([])
  const [operationRows, setOperationRows] = useState<CommissionRecord[]>([])
  const [operationPersonFilter, setOperationPersonFilter] = useState('all')
  const [projectMetaById, setProjectMetaById] = useState<Record<number, ProjectMeta>>({})

  const [updatingId, setUpdatingId] = useState<number | null>(null)
  const [receivedDraftById, setReceivedDraftById] = useState<Record<number, string>>({})

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
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
      setError(loadError instanceof Error ? loadError.message : '佣金数据加载失败')
      setRows([])
      setReceivedDraftById({})
    } finally {
      setLoading(false)
    }
  }, [month, session])

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
    setError(null)
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
      setError(loadError instanceof Error ? loadError.message : '汇总数据加载失败')
      setMonthlySummary([])
      setProjectSummary([])
    } finally {
      setSummaryLoading(false)
    }
  }, [session, summaryYear])

  const loadOperationRows = useCallback(async () => {
    setOperationLoading(true)
    setError(null)
    try {
      const response = await fetch(`${API_BASE}/api/v1/system-management/commission-management/records?report_month=${month}`, {
        cache: 'no-store',
        headers: buildBackendHeaders(session),
      })
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as CommissionRecordsResponse
      setOperationRows(Array.isArray(payload.items) ? payload.items : [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '运营提成数据加载失败')
      setOperationRows([])
    } finally {
      setOperationLoading(false)
    }
  }, [month, session])

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

  useEffect(() => {
    if (activeTab === 'operation') {
      void loadOperationRows()
    }
  }, [activeTab, loadOperationRows])

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

  const projectPaymentStatusByProjectId = useMemo(() => {
    return new Map<number, PaymentStatus>(rows.map((row) => [row.project_id, row.payment_status]))
  }, [rows])

  const operationPeople = useMemo(() => {
    return Array.from(new Set(operationRows.map((row) => row.person_name))).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [operationRows])

  const filteredOperationRows = useMemo(() => {
    if (operationPersonFilter === 'all') return operationRows
    return operationRows.filter((row) => row.person_name === operationPersonFilter)
  }, [operationPersonFilter, operationRows])

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
    setError(null)
    try {
      const draftValue = Number(receivedDraftById[row.id] ?? row.received_rmb)
      const normalizedDraft = Number.isFinite(draftValue) ? Math.max(0, draftValue) : row.received_rmb
      const receivedRmb = status === 'paid' ? getOverviewCommissionRmb(row) : status === 'unpaid' ? 0 : normalizedDraft
      await patchProjectMonthPayment(row, status, receivedRmb)
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '回款状态更新失败')
    } finally {
      setUpdatingId(null)
    }
  }

  const updateReceivedAmount = async (row: CommissionProjectMonth) => {
    setUpdatingId(row.id)
    setError(null)
    try {
      const parsed = Number(receivedDraftById[row.id])
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error('已回款金额必须是大于等于0的数字')
      }
      await patchProjectMonthPayment(row, row.payment_status, parsed)
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '已回款金额更新失败')
    } finally {
      setUpdatingId(null)
    }
  }

  const handleRefresh = () => {
    if (activeTab === 'detail') {
      void Promise.all([loadData(), loadProjectMeta()])
      return
    }
    if (activeTab === 'operation') {
      void loadOperationRows()
      return
    }
    void loadYearlySummary()
  }

  const handleRecompute = async () => {
    setRecomputing(true)
    setError(null)
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
        activeTab === 'operation' ? loadOperationRows() : Promise.resolve(),
        activeTab === 'monthly' || activeTab === 'projectSummary' ? loadYearlySummary() : Promise.resolve(),
      ])
    } catch (recomputeError) {
      setError(recomputeError instanceof Error ? recomputeError.message : '佣金核算失败')
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
    <div className="rounded-lg border border-border/70 flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 overflow-auto">
        <Table>
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
    <div className="rounded-lg border border-border/70 flex-1 flex flex-col min-h-0 overflow-hidden">
        <Table containerClassName="h-full overflow-auto">
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

  const renderOperationTable = () => (
    <div className="flex flex-col flex-1 min-h-0 space-y-3">
      <div className="rounded-lg border border-border/70 flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="flex-1 overflow-auto">
          <Table>
            <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45 sticky top-0 z-10">
              <TableRow>
                <TableHead className="font-semibold text-foreground">人员</TableHead>
                <TableHead className="font-semibold text-foreground">项目</TableHead>
                <TableHead className="font-semibold text-foreground">角色</TableHead>
                <TableHead className="text-right font-semibold text-foreground">销售收入(USD)</TableHead>
                <TableHead className="text-right font-semibold text-foreground">项目佣金率</TableHead>
                <TableHead className="text-right font-semibold text-foreground">运营提成比例</TableHead>
                <TableHead className="text-right font-semibold text-foreground">运营提成金额(RMB)</TableHead>
                <TableHead className="font-semibold text-foreground">项目回款状态(只读)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {operationLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">加载中...</TableCell>
                </TableRow>
              ) : filteredOperationRows.length === 0 ? (
                <EmptyTableState colSpan={8} message="当前筛选条件无数据" />
              ) : (
                filteredOperationRows.map((row) => {
                  const projectPaymentStatus = projectPaymentStatusByProjectId.get(row.project_id) ?? (row.payment_status === 'paid' ? 'paid' : 'unpaid')
                  return (
                    <TableRow key={row.id}>
                      <TableCell>{row.person_name}</TableCell>
                      <TableCell>{row.project_name}</TableCell>
                      <TableCell>{toCategoryLabel(row.income_category)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatUsd(row.income_total_usd)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPercent(row.factory_commission_rate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPercent(row.operator_bonus_ratio)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatRmb(row.bonus_amount_rmb)}</TableCell>
                      <TableCell>{toPaymentLabel(projectPaymentStatus)}</TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )

  return (
    <div className="mx-auto flex h-[calc(100dvh-6.5rem)] w-full max-w-[1520px] flex-col space-y-4 md:h-[calc(100dvh-8rem)] lg:h-[calc(100dvh-9rem)]">
      <Card className="flex flex-1 flex-col border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)] dark:border-border/80 dark:bg-[hsl(var(--surface-panel))] dark:shadow-[0_24px_50px_-30px_rgba(0,0,0,0.45)]">
        <CardHeader className="space-y-2 pb-4 shrink-0">
          <Badge variant="outline" className="w-fit rounded-md border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
            系统管理
          </Badge>
          <CardTitle className="text-2xl tracking-tight">佣金管理</CardTitle>
          <CardDescription className="dark:text-muted-foreground/80">回款确认状态与回款金额只允许在“总览”Sheet编辑，其余Sheet均只读。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col space-y-3 pt-1 min-h-0">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-4">
              {activeTab === 'detail' || activeTab === 'operation' ? (
                <div className="flex flex-wrap items-end gap-4">
                  <div className="space-y-1.5">
                    <label htmlFor="commission_month" className="text-xs text-muted-foreground">年度月份</label>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => setMonth((prev) => shiftMonth(prev, -1))}
                        aria-label="上一个月份"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <MonthPicker
                        value={parseMonthInputValue(month)}
                        onChange={(date) => setMonth(formatMonthInputValue(date))}
                        className="w-[190px]"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => setMonth((prev) => shiftMonth(prev, 1))}
                        aria-label="下一个月份"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  {activeTab === 'operation' ? (
                    <div className="space-y-1.5">
                      <label htmlFor="operation_person" className="text-xs text-muted-foreground">筛选人员</label>
                      <Select value={operationPersonFilter} onValueChange={setOperationPersonFilter}>
                        <SelectTrigger id="operation_person" className="w-[200px]">
                          <SelectValue placeholder="请选择人员" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">全部人员</SelectItem>
                          {operationPeople.map((person) => (
                            <SelectItem key={person} value={person}>
                              {person}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">年度</label>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => setSummaryYear((prev) => String(Number(prev) - 1))}
                      aria-label="上一年"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <div className="h-10 w-[100px] flex items-center justify-center rounded-md border border-input bg-background text-sm font-medium dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                      {summaryYear}年
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => setSummaryYear((prev) => String(Number(prev) + 1))}
                      aria-label="下一年"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}

              <Button
                variant="outline"
                onClick={handleRefresh}
                disabled={loading || summaryLoading || operationLoading || recomputing}
              >
                {loading || summaryLoading || operationLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                刷新
              </Button>
              {(activeTab === 'detail' || activeTab === 'operation') ? (
                <Button
                  onClick={() => void handleRecompute()}
                  disabled={recomputing || loading || operationLoading}
                >
                  {recomputing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  核算
                </Button>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              {activeTab === 'detail' ? (
                <div className="text-sm text-muted-foreground">
                  工厂佣金合计：{formatRmb(totalFactoryCommissionRmb)}，已回款：{formatRmb(totalReceivedRmb)}
                </div>
              ) : null}
              {(activeTab === 'monthly' || activeTab === 'projectSummary') ? (
                <div className="text-sm text-muted-foreground">
                  年度销售：{formatUsd(yearlyTotals.income)}，年度工厂佣金：{formatRmb(yearlyTotals.commission)}，年度回款：{formatRmb(yearlyTotals.received)}
                </div>
              ) : null}

              <div className="inline-flex rounded-md border bg-muted/20 p-1 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                <button
                  type="button"
                  className={`rounded px-3.5 py-1.5 text-xs font-semibold transition ${activeTab === 'detail' ? 'bg-background text-foreground shadow-sm dark:bg-[hsl(var(--surface-panel))]' : 'text-muted-foreground dark:text-muted-foreground/80'}`}
                  onClick={() => setActiveTab('detail')}
                >
                  总览
                </button>
                <button
                  type="button"
                  className={`rounded px-3.5 py-1.5 text-xs font-semibold transition ${activeTab === 'monthly' ? 'bg-background text-foreground shadow-sm dark:bg-[hsl(var(--surface-panel))]' : 'text-muted-foreground dark:text-muted-foreground/80'}`}
                  onClick={() => setActiveTab('monthly')}
                >
                  年-月汇总
                </button>
                <button
                  type="button"
                  className={`rounded px-3.5 py-1.5 text-xs font-semibold transition ${activeTab === 'projectSummary' ? 'bg-background text-foreground shadow-sm dark:bg-[hsl(var(--surface-panel))]' : 'text-muted-foreground dark:text-muted-foreground/80'}`}
                  onClick={() => setActiveTab('projectSummary')}
                >
                  项目汇总
                </button>
                <button
                  type="button"
                  className={`rounded px-3.5 py-1.5 text-xs font-semibold transition ${activeTab === 'operation' ? 'bg-background text-foreground shadow-sm dark:bg-[hsl(var(--surface-panel))]' : 'text-muted-foreground dark:text-muted-foreground/80'}`}
                  onClick={() => setActiveTab('operation')}
                >
                  运营提成
                </button>
              </div>
            </div>
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive dark:border-destructive/30 dark:bg-destructive/12">{error}</div>
          ) : null}

          {activeTab === 'detail' ? (
            <div className="rounded-lg border border-border/70 flex-1 flex flex-col min-h-0 overflow-hidden">
              <div className="flex-1 overflow-auto">
                <Table>
                  <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45 sticky top-0 z-10">
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
          ) : (
            renderOperationTable()
          )}

          <section className="shrink-0 overflow-hidden rounded-2xl border border-slate-200/80 bg-[linear-gradient(145deg,rgba(248,250,252,0.96),rgba(255,255,255,0.98)),radial-gradient(circle_at_top_right,rgba(245,158,11,0.12),transparent_32%),radial-gradient(circle_at_bottom_left,rgba(14,165,233,0.1),transparent_26%)] shadow-[0_20px_45px_-30px_rgba(15,23,42,0.28)] dark:border-border/80 dark:bg-[linear-gradient(180deg,hsl(var(--surface-panel)),hsl(var(--surface-soft)))] dark:shadow-[0_24px_50px_-30px_rgba(0,0,0,0.45)]">
            {activeTab === 'operation' ? (
              <div className="space-y-4 p-5">
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-amber-700/80 dark:text-amber-300/80">Bonus Rules</p>
                  <h3 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-foreground">运营提成备注</h3>
                  <p className="text-sm leading-6 text-slate-600 dark:text-muted-foreground/80">
                    运营提成在项目佣金基础上再次核算。只有运营时，运营按阶梯提成；有助理时，助理默认按项目佣金基数的 2% 核算，手工 override 存在时优先按 override。
                  </p>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {OPERATOR_PUBLIC_COMMISSION_TIERS.map((item, index) => (
                    <article
                      key={item.range}
                      className="rounded-2xl border border-white/80 bg-white/85 p-4 shadow-[0_16px_30px_-24px_rgba(15,23,42,0.45)] backdrop-blur-sm dark:border-border/80 dark:bg-[hsl(var(--surface-soft))] dark:shadow-none"
                    >
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400 dark:text-muted-foreground/70">Tier {index + 1}</p>
                      <p className="mt-3 text-sm font-medium text-slate-500 dark:text-muted-foreground/80">月销售额</p>
                      <p className="mt-1 text-base font-semibold text-slate-900 dark:text-foreground">{item.range}</p>
                      <div className="mt-4 inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-200/80 dark:bg-emerald-500/12 dark:text-emerald-300 dark:ring-emerald-500/30">
                        运营提成比例 {item.ratio}
                      </div>
                      {item.note ? (
                        <p className="mt-3 rounded-xl border border-amber-200/80 bg-amber-50/90 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/12 dark:text-amber-300">
                          备注：{item.note}
                        </p>
                      ) : null}
                    </article>
                  ))}
                </div>
              </div>
            ) : (
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
            )}
          </section>
        </CardContent>
      </Card>
    </div>
  )
}
