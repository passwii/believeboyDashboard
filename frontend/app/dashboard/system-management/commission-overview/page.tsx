'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { buildBackendHeaders } from '@/lib/backend-auth'
import { resolveOperationCommissionUsd } from '@/lib/commission'

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

type ProjectItem = {
  id: number
  commission_basis: string | null
  commission_rate: number | null
}

type FinancialSeriesRow = {
  report_month: string
  income_total: number
  amazon_pay_back: number
}

type FinancialSeriesResponse = {
  rows: FinancialSeriesRow[]
}

type DerivedCommission = {
  rate: number | null
  usd: number | null
  rmb: number | null
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''

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

export default function CommissionOverviewPage() {
  const { data: session } = useSession()
  const [month, setMonth] = useState(lastMonthString())
  const [loading, setLoading] = useState(true)
  const [updatingId, setUpdatingId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<CommissionProjectMonth[]>([])
  const [derivedByRowId, setDerivedByRowId] = useState<Record<number, DerivedCommission>>({})

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

      const projectsResp = await fetch(`${API_BASE}/api/v1/projects/manage`, {
        cache: 'no-store',
        headers: buildBackendHeaders(session),
      })
      if (!projectsResp.ok) {
        throw new Error(parseErrorBody(await projectsResp.text(), projectsResp.status))
      }
      const projects = (await projectsResp.json()) as ProjectItem[]
      const projectMap = new Map<number, ProjectItem>(projects.map((project) => [project.id, project]))

      const uniqueProjectIds = Array.from(new Set(nextRows.map((item) => item.project_id)))
      const monthQuery = new URLSearchParams({
        start_month: month,
        end_month: month,
        fill_missing: 'true',
      }).toString()
      const financialByProject = new Map<number, FinancialSeriesRow | null>()
      await Promise.all(
        uniqueProjectIds.map(async (projectId) => {
          const financialResp = await fetch(
            `${API_BASE}/api/v1/monthly-reports/financial-series?project_id=${projectId}&${monthQuery}`,
            {
              cache: 'no-store',
              headers: buildBackendHeaders(session),
            }
          )
          if (!financialResp.ok) {
            throw new Error(parseErrorBody(await financialResp.text(), financialResp.status))
          }
          const financialPayload = (await financialResp.json()) as FinancialSeriesResponse
          const monthRow = financialPayload.rows.find((item) => item.report_month === month) ?? null
          financialByProject.set(projectId, monthRow)
        })
      )

      const nextDerivedByRowId: Record<number, DerivedCommission> = {}
      for (const row of nextRows) {
        const project = projectMap.get(row.project_id)
        if (!project?.commission_basis) {
          nextDerivedByRowId[row.id] = { rate: null, usd: null, rmb: null }
          continue
        }
        const monthRow = financialByProject.get(row.project_id)
        const operationCommission = resolveOperationCommissionUsd({
          commissionBasis: project.commission_basis,
          configuredCommissionRate: Number(project.commission_rate ?? 0),
          incomeTotalUsd: Number(monthRow?.income_total ?? row.income_total_usd),
          amazonPaybackUsd: Number(monthRow?.amazon_pay_back ?? 0),
        })
        const commissionUsd = operationCommission.commissionUsd
        nextDerivedByRowId[row.id] = {
          rate: operationCommission.commissionRate,
          usd: commissionUsd,
          rmb: commissionUsd * row.usd_to_rmb_rate,
        }
      }
      setDerivedByRowId(nextDerivedByRowId)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '佣金数据加载失败')
      setRows([])
      setDerivedByRowId({})
    } finally {
      setLoading(false)
    }
  }, [month, session])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const totalFactoryCommissionRmb = useMemo(() => {
    return rows.reduce((sum, row) => sum + (derivedByRowId[row.id]?.rmb ?? 0), 0)
  }, [rows, derivedByRowId])
  const totalReceivedRmb = useMemo(() => rows.reduce((sum, row) => sum + row.received_rmb, 0), [rows])

  const updatePaymentStatus = async (row: CommissionProjectMonth, status: PaymentStatus) => {
    setUpdatingId(row.id)
    setError(null)
    try {
      const currentCommissionRmb = derivedByRowId[row.id]?.rmb ?? 0
      const receivedRmb = status === 'paid' ? currentCommissionRmb : status === 'unpaid' ? 0 : row.received_rmb
      const response = await fetch(`${API_BASE}/api/v1/system-management/commission-management/project-months/${row.id}/payment`, {
        method: 'PATCH',
        headers: buildBackendHeaders(session, { contentType: 'application/json' }),
        body: JSON.stringify({
          payment_status: status,
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
      }
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '回款状态更新失败')
    } finally {
      setUpdatingId(null)
    }
  }

  return (
    <div className="mx-auto max-w-[1420px] space-y-6">
      <Card className="border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)]">
        <CardHeader className="space-y-3">
          <Badge variant="outline" className="w-fit rounded-md border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
            系统管理
          </Badge>
          <CardTitle>佣金总览</CardTitle>
          <CardDescription>按项目和月份统计工厂佣金与回款状态，支持财务回款确认。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-1.5">
              <label htmlFor="commission_overview_month" className="text-xs text-muted-foreground">年度月份</label>
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
                <input
                  id="commission_overview_month"
                  type="month"
                  value={month}
                  onChange={(event) => setMonth(event.target.value)}
                  className="h-10 w-[180px] rounded-md border border-input bg-background px-3 text-sm"
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

            <div className="flex items-center gap-2">
              <div className="text-sm text-muted-foreground">
                工厂佣金合计：{formatRmb(totalFactoryCommissionRmb)}，已回款：{formatRmb(totalReceivedRmb)}
              </div>
              <Button variant="outline" onClick={() => void loadData()} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                刷新
              </Button>
            </div>
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
          ) : null}

          <div className="rounded-lg border border-border/70">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>项目名称</TableHead>
                  <TableHead className="text-right">收入合计(USD)</TableHead>
                  <TableHead className="text-right">工厂佣金比例</TableHead>
                  <TableHead className="text-right">工厂佣金(USD)</TableHead>
                  <TableHead className="text-right">汇率(USD→RMB)</TableHead>
                  <TableHead className="text-right">工厂佣金(RMB)</TableHead>
                  <TableHead className="text-right">已回款(RMB)</TableHead>
                  <TableHead>回款状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">加载中...</TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">当前月份暂无数据，请先在提成管理页面刷新核算</TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.project_name}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatUsd(row.income_total_usd)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {derivedByRowId[row.id]?.rate == null ? '-' : formatPercent(derivedByRowId[row.id].rate ?? 0)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {derivedByRowId[row.id]?.usd == null ? '-' : formatUsd(derivedByRowId[row.id].usd ?? 0)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.usd_to_rmb_rate.toFixed(4)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {derivedByRowId[row.id]?.rmb == null ? '-' : formatRmb(derivedByRowId[row.id].rmb ?? 0)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatRmb(row.received_rmb)}</TableCell>
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
        </CardContent>
      </Card>
    </div>
  )
}
