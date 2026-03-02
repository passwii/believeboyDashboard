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

type ProjectItem = {
  id: number
  name: string
  project_operator: string | null
  assistant_operator: string | null
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

type ExchangeRatesResponse = {
  data?: Array<{
    rate: number
  }>
}

type IncomeCategory = 'operator' | 'assistant'
type PaymentStatus = 'paid' | 'unpaid'
type RatioSource = 'rule' | 'manual'

type CommissionRecord = {
  id: number
  report_month: string
  project_id: number
  project_name: string
  person_name: string
  income_category: IncomeCategory
  income_total_usd: number
  factory_commission_rate: number
  public_commission_ratio: number
  commission_amount_usd: number
  usd_to_rmb_rate: number
  commission_amount_rmb: number
  ratio_source?: RatioSource
  manual_ratio?: number | null
  payment_status: PaymentStatus
}

type UpsertPayloadItem = {
  project_id: number
  project_name: string
  person_name: string
  income_category: IncomeCategory
  income_total_usd: number
  factory_commission_rate: number
  public_commission_ratio: number
  commission_amount_usd: number
  usd_to_rmb_rate: number
  commission_amount_rmb: number
  ratio_source?: RatioSource
  manual_ratio?: number | null
}

type CommissionRecordsResponse = {
  report_month: string
  items: CommissionRecord[]
}

type RoleAssignmentItem = {
  id: number
  project_id: number
  role_type: IncomeCategory
  person_name: string
  effective_from_month: string
  effective_to_month: string | null
  updated_at: string
}

type RoleAssignmentsResponse = {
  items: RoleAssignmentItem[]
}

type RatioOverrideItem = {
  id: number
  report_month: string
  project_id: number
  project_name: string
  person_name: string
  income_category: IncomeCategory
  override_ratio: number
  reason?: string | null
}

type RatioOverridesResponse = {
  report_month: string
  items: RatioOverrideItem[]
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const ASSISTANT_FIXED_RATIO = 0.02

const OPERATOR_RULES = [
  { ratio: 0.12, label: '0–10,000' },
  { ratio: 0.14, label: '10,001–50,000' },
  { ratio: 0.16, label: '50,001–150,000' },
  { ratio: 0.18, label: '150,001–450,000' },
  { ratio: 0.2, label: '450,001–1,000,000' },
] as const

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

function formatUsd(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}$${text}`
}

function formatRmb(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}¥${text}`
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function getOperatorRatioByIncome(incomeTotalUsd: number): number {
  if (incomeTotalUsd <= 10000) return 0.12
  if (incomeTotalUsd <= 50000) return 0.14
  if (incomeTotalUsd <= 150000) return 0.16
  if (incomeTotalUsd <= 450000) return 0.18
  return 0.2
}

function toCategoryLabel(value: IncomeCategory): string {
  return value === 'operator' ? '运营' : '助理'
}

export default function CommissionManagementPage() {
  const { data: session, status } = useSession()
  const [month, setMonth] = useState(lastMonthString())
  const [personFilter, setPersonFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<CommissionRecord[]>([])
  const [currentExchangeRate, setCurrentExchangeRate] = useState(0)
  const [projectPayableCommissionRmb, setProjectPayableCommissionRmb] = useState<Record<number, number | null>>({})

  const rebuildAndLoad = useCallback(async () => {
    if (status === 'loading') {
      return
    }

    setLoading(true)
    setError(null)
    try {
      const exchangeResp = await fetch(`/api/exchange-rates?currency=USD&year_month=${month}&page=1&pageSize=1`, {
        cache: 'no-store',
      })
      if (!exchangeResp.ok) {
        throw new Error(parseErrorBody(await exchangeResp.text(), exchangeResp.status))
      }
      const exchangePayload = (await exchangeResp.json()) as ExchangeRatesResponse
      const exchangeRate = Number(exchangePayload.data?.[0]?.rate ?? 0)
      setCurrentExchangeRate(exchangeRate)

      const projectsResp = await fetch(`${API_BASE}/api/v1/projects/manage`, {
        cache: 'no-store',
        headers: buildBackendHeaders(session),
      })
      if (!projectsResp.ok) {
        throw new Error(parseErrorBody(await projectsResp.text(), projectsResp.status))
      }
      const projects = (await projectsResp.json()) as ProjectItem[]
      const [roleAssignmentsResp, ratioOverridesResp] = await Promise.all([
        fetch(`${API_BASE}/api/v1/system-management/commission-management/role-assignments?report_month=${month}`, {
          cache: 'no-store',
          headers: buildBackendHeaders(session),
        }),
        fetch(`${API_BASE}/api/v1/system-management/commission-management/ratio-overrides?report_month=${month}`, {
          cache: 'no-store',
          headers: buildBackendHeaders(session),
        }),
      ])
      if (!roleAssignmentsResp.ok) {
        throw new Error(parseErrorBody(await roleAssignmentsResp.text(), roleAssignmentsResp.status))
      }
      if (!ratioOverridesResp.ok) {
        throw new Error(parseErrorBody(await ratioOverridesResp.text(), ratioOverridesResp.status))
      }
      const roleAssignmentsPayload = (await roleAssignmentsResp.json()) as RoleAssignmentsResponse
      const ratioOverridesPayload = (await ratioOverridesResp.json()) as RatioOverridesResponse
      const roleAssignments = Array.isArray(roleAssignmentsPayload.items) ? roleAssignmentsPayload.items : []
      const ratioOverrides = Array.isArray(ratioOverridesPayload.items) ? ratioOverridesPayload.items : []

      const roleMap = new Map<string, string[]>()
      for (const assignment of roleAssignments) {
        const person = assignment.person_name.trim()
        if (!person) continue
        const key = `${assignment.project_id}::${assignment.role_type}`
        const list = roleMap.get(key) ?? []
        if (!list.includes(person)) list.push(person)
        roleMap.set(key, list)
      }

      const ratioOverrideMap = new Map<string, number>()
      for (const override of ratioOverrides) {
        ratioOverrideMap.set(
          `${override.project_id}::${override.person_name.trim()}::${override.income_category}`,
          Number(override.override_ratio)
        )
      }

      const monthQuery = new URLSearchParams({
        start_month: month,
        end_month: month,
        fill_missing: 'true',
      }).toString()

      const calculatedByProject = await Promise.all(
        projects.map(async (project) => {
          const search = `project_id=${project.id}&${monthQuery}`
          const response = await fetch(`${API_BASE}/api/v1/monthly-reports/financial-series?${search}`, {
            cache: 'no-store',
            headers: buildBackendHeaders(session),
          })
          if (!response.ok) {
            throw new Error(parseErrorBody(await response.text(), response.status))
          }

          const payload = (await response.json()) as FinancialSeriesResponse
          const monthRow = payload.rows.find((item) => item.report_month === month)
          const incomeTotalUsd = Number(monthRow?.income_total ?? 0)
          const amazonPaybackUsd = Number(monthRow?.amazon_pay_back ?? 0)
          const factoryCommissionRate = Number(project.commission_rate ?? 0)
          const defaultOperatorRatio = getOperatorRatioByIncome(incomeTotalUsd)
          const operatorPeople = roleMap.get(`${project.id}::operator`) ?? (project.project_operator ? [project.project_operator] : [])
          const assistantPeople = roleMap.get(`${project.id}::assistant`) ?? (project.assistant_operator ? [project.assistant_operator] : [])

          const items: UpsertPayloadItem[] = []
          for (const personName of operatorPeople) {
            const normalizedPerson = personName.trim()
            if (!normalizedPerson) continue
            const overrideRatio = ratioOverrideMap.get(`${project.id}::${normalizedPerson}::operator`)
            const ratio = overrideRatio ?? defaultOperatorRatio
            const commissionAmountUsd = incomeTotalUsd * factoryCommissionRate * ratio
            items.push({
              project_id: project.id,
              project_name: project.name,
              person_name: normalizedPerson,
              income_category: 'operator',
              income_total_usd: incomeTotalUsd,
              factory_commission_rate: factoryCommissionRate,
              public_commission_ratio: ratio,
              commission_amount_usd: commissionAmountUsd,
              usd_to_rmb_rate: exchangeRate,
              commission_amount_rmb: commissionAmountUsd * exchangeRate,
              ratio_source: overrideRatio !== undefined ? 'manual' : 'rule',
              manual_ratio: overrideRatio ?? null,
            })
          }
          for (const personName of assistantPeople) {
            const normalizedPerson = personName.trim()
            if (!normalizedPerson) continue
            const overrideRatio = ratioOverrideMap.get(`${project.id}::${normalizedPerson}::assistant`)
            const ratio = overrideRatio ?? ASSISTANT_FIXED_RATIO
            const commissionAmountUsd = incomeTotalUsd * factoryCommissionRate * ratio
            items.push({
              project_id: project.id,
              project_name: project.name,
              person_name: normalizedPerson,
              income_category: 'assistant',
              income_total_usd: incomeTotalUsd,
              factory_commission_rate: factoryCommissionRate,
              public_commission_ratio: ratio,
              commission_amount_usd: commissionAmountUsd,
              usd_to_rmb_rate: exchangeRate,
              commission_amount_rmb: commissionAmountUsd * exchangeRate,
              ratio_source: overrideRatio !== undefined ? 'manual' : 'rule',
              manual_ratio: overrideRatio ?? null,
            })
          }
          return {
            project,
            incomeTotalUsd,
            amazonPaybackUsd,
            items,
          }
        })
      )

      const payableMap: Record<number, number | null> = {}
      for (const { project, incomeTotalUsd, amazonPaybackUsd } of calculatedByProject) {
        if (!project.commission_basis) {
          payableMap[project.id] = null
          continue
        }
        const operationCommission = resolveOperationCommissionUsd({
          commissionBasis: project.commission_basis,
          configuredCommissionRate: Number(project.commission_rate ?? 0),
          incomeTotalUsd,
          amazonPaybackUsd,
        })
        payableMap[project.id] = operationCommission.commissionUsd * exchangeRate
      }
      setProjectPayableCommissionRmb(payableMap)

      const upsertResp = await fetch(`${API_BASE}/api/v1/system-management/commission-management/records/upsert`, {
        method: 'POST',
        headers: buildBackendHeaders(session, { contentType: 'application/json' }),
        body: JSON.stringify({
          report_month: month,
          items: calculatedByProject.flatMap((item) => item.items),
        }),
      })
      if (!upsertResp.ok) {
        throw new Error(parseErrorBody(await upsertResp.text(), upsertResp.status))
      }
      const upsertPayload = (await upsertResp.json()) as CommissionRecordsResponse
      setRows(Array.isArray(upsertPayload.items) ? upsertPayload.items : [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '提成数据加载失败')
      setRows([])
      setProjectPayableCommissionRmb({})
    } finally {
      setLoading(false)
    }
  }, [month, session, status])

  useEffect(() => {
    void rebuildAndLoad()
  }, [rebuildAndLoad])

  const people = useMemo(() => {
    return Array.from(new Set(rows.map((row) => row.person_name))).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [rows])

  const filteredRows = useMemo(() => {
    if (personFilter === 'all') return rows
    return rows.filter((row) => row.person_name === personFilter)
  }, [rows, personFilter])

  const totalCommissionRmb = useMemo(() => {
    return filteredRows.reduce((sum, row) => sum + row.commission_amount_rmb, 0)
  }, [filteredRows])

  const totalFactoryCommissionRmb = useMemo(() => {
    return filteredRows.reduce((sum, row) => {
      const payableRmb = projectPayableCommissionRmb[row.project_id]
      return sum + (payableRmb ?? 0)
    }, 0)
  }, [filteredRows, projectPayableCommissionRmb])

  const confirmedCommissionRmb = useMemo(() => {
    return filteredRows
      .filter((row) => row.payment_status === 'paid')
      .reduce((sum, row) => sum + row.commission_amount_rmb, 0)
  }, [filteredRows])

  const updatePaymentStatus = async (recordId: number, paymentStatus: PaymentStatus) => {
    const response = await fetch(`${API_BASE}/api/v1/system-management/commission-management/records/${recordId}/payment-status`, {
      method: 'PATCH',
      headers: buildBackendHeaders(session, { contentType: 'application/json' }),
      body: JSON.stringify({ payment_status: paymentStatus }),
    })
    if (!response.ok) {
      throw new Error(parseErrorBody(await response.text(), response.status))
    }
    const payload = (await response.json()) as { item?: CommissionRecord }
    if (payload.item) {
      setRows((prev) => prev.map((row) => (row.id === payload.item!.id ? payload.item! : row)))
    }
  }

  return (
    <div className="mx-auto max-w-[1320px] space-y-6">
      <Card className="border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)]">
        <CardHeader className="space-y-3">
          <Badge variant="outline" className="w-fit rounded-md border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
            系统管理
          </Badge>
          <CardTitle>提成管理</CardTitle>
          <CardDescription>按人员与月份核算提成，结果按人民币展示并保存到数据库。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <label htmlFor="commission_person" className="text-xs text-muted-foreground">筛选人员</label>
                <Select value={personFilter} onValueChange={setPersonFilter}>
                  <SelectTrigger id="commission_person" className="w-[200px]">
                    <SelectValue placeholder="请选择人员" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部人员</SelectItem>
                    {people.map((person) => (
                      <SelectItem key={person} value={person}>
                        {person}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
                  <input
                    id="commission_month"
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
            </div>

            <div className="flex items-center gap-2">
              <div className="text-sm text-muted-foreground">
                汇率(USD→RMB)：{currentExchangeRate > 0 ? currentExchangeRate.toFixed(4) : '-'}，工厂佣金合计：{formatRmb(totalFactoryCommissionRmb)}，提成合计：{formatRmb(totalCommissionRmb)}，已确认提成：{formatRmb(confirmedCommissionRmb)}
              </div>
              <Button variant="outline" onClick={() => void rebuildAndLoad()} disabled={loading}>
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
                  <TableHead>人员</TableHead>
                  <TableHead>项目名称</TableHead>
                  <TableHead>收入分类</TableHead>
                  <TableHead className="text-right">收入合计(USD)</TableHead>
                  <TableHead className="text-right">工厂佣金(RMB)</TableHead>
                  <TableHead className="text-right">提成比例</TableHead>
                  <TableHead className="text-right">提成核算(RMB)</TableHead>
                  <TableHead>回款确认</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">
                      加载中...
                    </TableCell>
                  </TableRow>
                ) : filteredRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">
                      当前筛选条件无数据
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredRows.map((row) => (
                    <TableRow
                      key={row.id}
                      className={row.payment_status === 'paid' ? 'bg-emerald-500/10 hover:bg-emerald-500/15' : ''}
                    >
                      <TableCell>{row.person_name}</TableCell>
                      <TableCell>{row.project_name}</TableCell>
                      <TableCell>{toCategoryLabel(row.income_category)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatUsd(row.income_total_usd)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {projectPayableCommissionRmb[row.project_id] == null
                          ? '-'
                          : formatRmb(projectPayableCommissionRmb[row.project_id] ?? 0)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatPercent(row.public_commission_ratio)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{formatRmb(row.commission_amount_rmb)}</TableCell>
                      <TableCell>
                        <Select
                          value={row.payment_status}
                          onValueChange={(value: PaymentStatus) => {
                            void updatePaymentStatus(row.id, value).catch((updateError) => {
                              setError(updateError instanceof Error ? updateError.message : '回款状态更新失败')
                            })
                          }}
                        >
                          <SelectTrigger className="w-[140px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="paid">已回款</SelectItem>
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

      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">提成比例规则</CardTitle>
          <CardDescription>运营按收入合计阶梯；助理固定 2%。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 text-sm text-muted-foreground md:grid-cols-2 xl:grid-cols-5">
            {OPERATOR_RULES.map((rule) => (
              <div key={rule.label} className="rounded-md border border-border/70 bg-muted/30 px-3 py-2">
                <div className="font-medium text-foreground">{rule.label}</div>
                <div>运营提成比例：{formatPercent(rule.ratio)}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-sm text-muted-foreground">助理提成比例（固定）：{formatPercent(ASSISTANT_FIXED_RATIO)}</div>
        </CardContent>
      </Card>
    </div>
  )
}
