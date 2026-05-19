'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, PlusCircle, Save } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { RefreshButton } from '@/components/dashboard/console'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MonthPicker, formatMonthInputValue, parseMonthInputValue } from '@/components/ui/date-picker'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DirectionalTabTransition, SlidingTabsTrigger, TabsMotionGroup } from '@/components/ui/tab-motion'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { buildBackendHeaders } from '@/lib/backend-auth'
import { useNotifications } from '@/components/notifications'
import { DataCard, DataCardContent, DataCardHeader } from '@/components/ui/data-card'
import { DataTableCard, DataTableCardBody, DataTableCardHeader, DataTableCardStatBar } from '@/components/ui/data-card'

type ManageProject = {
  id: number
  name: string
}

type RoleAssignmentItem = {
  id: number
  project_id: number
  role_type: string
  person_name: string
  effective_from_month: string
  effective_to_month: string | null
  updated_at: string
}

type RoleAssignmentsResponse = {
  items: RoleAssignmentItem[]
}

type PerformanceItem = {
  id: number
  report_month: string
  week_index: number
  project_id: number
  project_name: string
  person_name: string
  role_type: string
  score: number
  note: string | null
  updated_by: string | null
  updated_at: string
}

type PerformanceResponse = {
  report_month: string
  items: PerformanceItem[]
}

type IncomeCategory = 'operator' | 'assistant'
type BonusRatioSource = 'rule' | 'manual'

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
  bonus_amount_usd: number
  usd_to_rmb_rate: number
  bonus_amount_rmb: number
  bonus_ratio_source: BonusRatioSource
  manual_bonus_ratio: number | null
  payment_status: 'paid' | 'unpaid'
}

type CommissionRecordsResponse = {
  report_month: string
  items: CommissionRecord[]
}

type RatioOverrideItem = {
  id: number
  report_month: string
  project_id: number
  project_name: string
  person_name: string
  income_category: IncomeCategory
  override_ratio: number
  reason: string | null
  updated_by: string | null
  updated_at: string
}

type RatioOverridesResponse = {
  report_month: string
  items: RatioOverrideItem[]
}

type OperatorPageTab = 'role-info' | 'performance' | 'commission'

type EditableRoleRow = {
  localId: string
  id?: number
  project_id: number | null
  person_name: string
  role_type: string
  effective_from_month: string
  effective_to_month: string
}

type EditablePerformanceRow = {
  localId: string
  id?: number
  project_id: number | null
  person_name: string
  role_type: string
  week_index: number
  score: string
  note: string
}

type CommissionEditableDraft = {
  ratio: string
  reason: string
}

type PerformanceSummary = {
  totalScore: number
  averageScore: number
  weekCount: number
}

const API_BASE = '/api/backend'
const COMMON_ROLE_OPTIONS = ['operator', 'assistant', 'trainee', 'manager']
const TAB_ORDER: readonly OperatorPageTab[] = ['role-info', 'performance', 'commission'] as const

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
    return text
  } catch {
    return text
  }
}

function formatRmb(value: number): string {
  return `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function toIncomeCategoryLabel(value: IncomeCategory): string {
  return value === 'operator' ? '运营' : '助理'
}

function toRoleLabel(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'operator') return '运营'
  if (normalized === 'assistant') return '助理'
  if (normalized === 'trainee') return '培训中'
  if (normalized === 'manager') return '主管'
  return value || '-'
}

function toProjectName(projects: ManageProject[], projectId: number | null): string {
  const match = projects.find((item) => item.id === projectId)
  return match?.name ?? ''
}

function buildRoleDraft(items: RoleAssignmentItem[]): EditableRoleRow[] {
  return items.map((item) => ({
    localId: `role-${item.id}`,
    id: item.id,
    project_id: item.project_id,
    person_name: item.person_name,
    role_type: item.role_type,
    effective_from_month: item.effective_from_month,
    effective_to_month: item.effective_to_month ?? '',
  }))
}

function buildPerformanceDraft(items: PerformanceItem[]): EditablePerformanceRow[] {
  return items.map((item) => ({
    localId: `performance-${item.id}`,
    id: item.id,
    project_id: item.project_id,
    person_name: item.person_name,
    role_type: item.role_type,
    week_index: item.week_index,
    score: String(item.score),
    note: item.note ?? '',
  }))
}

const OPERATOR_PUBLIC_COMMISSION_TIERS: Array<{ range: string; ratio: string; note?: string }> = [
  { range: '0 - 10,000 USD', ratio: '12%', note: '新店铺开售3个月内' },
  { range: '10,001 - 50,000 USD', ratio: '14%' },
  { range: '50,001 - 150,000 USD', ratio: '16%' },
  { range: '150,001 - 450,000 USD', ratio: '18%' },
  { range: '450,001 USD 以上', ratio: '20%' },
] as const

export default function OperatorManagementPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const [activeTab, setActiveTab] = useState<OperatorPageTab>('role-info')
  const [month, setMonth] = useState(lastMonthString())

  const [projects, setProjects] = useState<ManageProject[]>([])
  const [operatorOptions, setOperatorOptions] = useState<string[]>([])

  const [roleLoading, setRoleLoading] = useState(false)
  const [performanceLoading, setPerformanceLoading] = useState(false)
  const [commissionLoading, setCommissionLoading] = useState(false)
  const [savingRoles, setSavingRoles] = useState(false)
  const [savingPerformance, setSavingPerformance] = useState(false)
  const [savingCommission, setSavingCommission] = useState(false)

  const [roleRows, setRoleRows] = useState<RoleAssignmentItem[]>([])
  const [roleDraftRows, setRoleDraftRows] = useState<EditableRoleRow[]>([])

  const [performanceRows, setPerformanceRows] = useState<PerformanceItem[]>([])
  const [performanceDraftRows, setPerformanceDraftRows] = useState<EditablePerformanceRow[]>([])

  const [commissionRows, setCommissionRows] = useState<CommissionRecord[]>([])
  const [ratioOverrideRows, setRatioOverrideRows] = useState<RatioOverrideItem[]>([])
  const [commissionDrafts, setCommissionDrafts] = useState<Record<string, CommissionEditableDraft>>({})

  const roleMapByProjectPerson = useMemo(() => {
    return roleRows.reduce<Record<string, string>>((acc, item) => {
      acc[`${item.project_id}::${item.person_name.trim()}`] = item.role_type
      return acc
    }, {})
  }, [roleRows])

  const performanceStats = useMemo(() => {
    const scores = performanceRows.map((item) => item.score)
    const total = scores.reduce((sum, value) => sum + value, 0)
    return {
      recordCount: performanceRows.length,
      peopleCount: new Set(performanceRows.map((item) => `${item.project_id}-${item.person_name}`)).size,
      averageScore: scores.length > 0 ? total / scores.length : 0,
    }
  }, [performanceRows])

  const performanceSummaryByProjectPerson = useMemo(() => {
    const map: Record<string, PerformanceSummary> = {}
    for (const item of performanceRows) {
      const key = `${item.project_id}::${item.person_name.trim()}`
      const current = map[key]
      if (current) {
        const nextWeekCount = current.weekCount + 1
        const nextTotal = current.totalScore + item.score
        map[key] = {
          totalScore: nextTotal,
          averageScore: nextTotal / nextWeekCount,
          weekCount: nextWeekCount,
        }
        continue
      }
      map[key] = {
        totalScore: item.score,
        averageScore: item.score,
        weekCount: 1,
      }
    }
    return map
  }, [performanceRows])

  const commissionOverrideMap = useMemo(() => {
    return ratioOverrideRows.reduce<Record<string, RatioOverrideItem>>((acc, item) => {
      acc[`${item.project_id}::${item.person_name}::${item.income_category}`] = item
      return acc
    }, {})
  }, [ratioOverrideRows])

  const commissionTableRows = useMemo(() => {
    return commissionRows.map((item) => {
      const key = `${item.project_id}::${item.person_name}::${item.income_category}`
      const override = commissionOverrideMap[key]
      const projectPersonKey = `${item.project_id}::${item.person_name}`
      const roleType = roleMapByProjectPerson[projectPersonKey] ?? item.income_category
      const performanceSummary = performanceSummaryByProjectPerson[projectPersonKey] ?? {
        totalScore: 0,
        averageScore: 0,
        weekCount: 0,
      }
      return {
        ...item,
        role_type: roleType,
        override,
        performanceSummary,
      }
    })
  }, [commissionOverrideMap, commissionRows, performanceSummaryByProjectPerson, roleMapByProjectPerson])

  const loadBaseOptions = useCallback(async () => {
    const [projectsResponse, operatorsResponse] = await Promise.all([
      fetch(`${API_BASE}/api/v1/projects/manage`, {
        cache: 'no-store',
        headers: buildBackendHeaders(session),
      }),
      fetch(`${API_BASE}/api/v1/projects/operator-options`, {
        cache: 'no-store',
        headers: buildBackendHeaders(session),
      }),
    ])

    if (!projectsResponse.ok) {
      throw new Error(parseErrorBody(await projectsResponse.text(), projectsResponse.status))
    }
    if (!operatorsResponse.ok) {
      throw new Error(parseErrorBody(await operatorsResponse.text(), operatorsResponse.status))
    }

    const projectPayload = (await projectsResponse.json()) as Array<{ id: number; name: string }>
    const operatorPayload = (await operatorsResponse.json()) as string[]
    setProjects(projectPayload)
    setOperatorOptions(operatorPayload)
  }, [session])

  const loadRoleInfo = useCallback(async () => {
    setRoleLoading(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/system-management/commission-management/role-assignments?report_month=${month}`, {
        cache: 'no-store',
        headers: buildBackendHeaders(session),
      })
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as RoleAssignmentsResponse
      setRoleRows(payload.items ?? [])
      setRoleDraftRows(buildRoleDraft(payload.items ?? []))
    } finally {
      setRoleLoading(false)
    }
  }, [month, session])

  const loadPerformance = useCallback(async () => {
    setPerformanceLoading(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/system-management/operator-management/performance?report_month=${month}`, {
        cache: 'no-store',
        headers: buildBackendHeaders(session),
      })
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as PerformanceResponse
      setPerformanceRows(payload.items ?? [])
      setPerformanceDraftRows(buildPerformanceDraft(payload.items ?? []))
    } finally {
      setPerformanceLoading(false)
    }
  }, [month, session])

  const loadCommission = useCallback(async () => {
    setCommissionLoading(true)
    try {
      const [recordsResponse, overrideResponse] = await Promise.all([
        fetch(`${API_BASE}/api/v1/system-management/commission-management/records?report_month=${month}`, {
          cache: 'no-store',
          headers: buildBackendHeaders(session),
        }),
        fetch(`${API_BASE}/api/v1/system-management/commission-management/ratio-overrides?report_month=${month}`, {
          cache: 'no-store',
          headers: buildBackendHeaders(session),
        }),
      ])
      if (!recordsResponse.ok) {
        throw new Error(parseErrorBody(await recordsResponse.text(), recordsResponse.status))
      }
      if (!overrideResponse.ok) {
        throw new Error(parseErrorBody(await overrideResponse.text(), overrideResponse.status))
      }

      const recordPayload = (await recordsResponse.json()) as CommissionRecordsResponse
      const overridePayload = (await overrideResponse.json()) as RatioOverridesResponse
      const nextRows = recordPayload.items ?? []
      const nextOverrides = overridePayload.items ?? []
      setCommissionRows(nextRows)
      setRatioOverrideRows(nextOverrides)
      setCommissionDrafts(
        nextRows.reduce<Record<string, CommissionEditableDraft>>((acc, item) => {
          const key = `${item.project_id}::${item.person_name}::${item.income_category}`
          const override = nextOverrides.find((row) => row.project_id === item.project_id && row.person_name === item.person_name && row.income_category === item.income_category)
          acc[key] = {
            ratio: ((override?.override_ratio ?? item.manual_bonus_ratio ?? item.operator_bonus_ratio) * 100).toFixed(2),
            reason: override?.reason ?? '',
          }
          return acc
        }, {}),
      )
    } finally {
      setCommissionLoading(false)
    }
  }, [month, session])

  const refreshAll = useCallback(async () => {
    try {
      await loadBaseOptions()
      await Promise.all([loadRoleInfo(), loadPerformance(), loadCommission()])
    } catch (loadError) {
      notify({ type: 'error', title: '数据加载失败', message: loadError instanceof Error ? loadError.message : '加载失败' })
    }
  }, [loadBaseOptions, loadCommission, loadPerformance, loadRoleInfo, notify])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  const addRoleRow = () => {
    setRoleDraftRows((prev) => [
      ...prev,
      {
        localId: `new-role-${Date.now()}`,
        project_id: projects[0]?.id ?? null,
        person_name: operatorOptions[0] ?? '',
        role_type: 'assistant',
        effective_from_month: month,
        effective_to_month: '',
      },
    ])
  }

  const addPerformanceRow = () => {
    setPerformanceDraftRows((prev) => [
      ...prev,
      {
        localId: `new-performance-${Date.now()}`,
        project_id: projects[0]?.id ?? null,
        person_name: operatorOptions[0] ?? '',
        role_type: 'assistant',
        week_index: 1,
        score: '0',
        note: '',
      },
    ])
  }

  const saveRoleInfo = async () => {
    const validRows = roleDraftRows.filter((item) => item.project_id && item.person_name.trim() && item.role_type.trim() && item.effective_from_month.trim())
    if (validRows.length === 0) {
      notify({ type: 'error', title: '请至少填写一条完整的运营信息' })
      return
    }

    setSavingRoles(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/system-management/commission-management/role-assignments/upsert`, {
        method: 'POST',
        headers: {
          ...buildBackendHeaders(session),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          items: validRows.map((item) => ({
            id: item.id ?? null,
            project_id: item.project_id,
            role_type: item.role_type.trim(),
            person_name: item.person_name.trim(),
            effective_from_month: item.effective_from_month,
            effective_to_month: item.effective_to_month.trim() || null,
          })),
        }),
      })
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as RoleAssignmentsResponse
      setRoleRows(payload.items ?? [])
      setRoleDraftRows(buildRoleDraft(payload.items ?? []))
      notify({ type: 'success', title: '运营信息已保存' })
    } catch (submitError) {
      notify({ type: 'error', title: '运营信息保存失败', message: submitError instanceof Error ? submitError.message : '运营信息保存失败' })
    } finally {
      setSavingRoles(false)
    }
  }

  const savePerformance = async () => {
    const validRows = performanceDraftRows.filter((item) => item.project_id && item.person_name.trim() && item.role_type.trim() && item.score.trim())
    if (validRows.length === 0) {
      notify({ type: 'error', title: '请至少填写一条完整的运营绩效' })
      return
    }

    setSavingPerformance(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/system-management/operator-management/performance/upsert`, {
        method: 'POST',
        headers: {
          ...buildBackendHeaders(session),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          items: validRows.map((item) => ({
            id: item.id ?? null,
            report_month: month,
            week_index: item.week_index,
            project_id: item.project_id,
            project_name: toProjectName(projects, item.project_id),
            person_name: item.person_name.trim(),
            role_type: item.role_type.trim(),
            score: Number(item.score),
            note: item.note.trim() || null,
          })),
        }),
      })
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as PerformanceResponse
      setPerformanceRows(payload.items ?? [])
      setPerformanceDraftRows(buildPerformanceDraft(payload.items ?? []))
      notify({ type: 'success', title: '运营绩效已保存' })
    } catch (submitError) {
      notify({ type: 'error', title: '运营绩效保存失败', message: submitError instanceof Error ? submitError.message : '运营绩效保存失败' })
    } finally {
      setSavingPerformance(false)
    }
  }

  const saveCommissionOverrides = async () => {
    const items = commissionTableRows
      .map((row) => {
        const key = `${row.project_id}::${row.person_name}::${row.income_category}`
        const draft = commissionDrafts[key]
        if (!draft?.ratio.trim()) {
          return null
        }
        return {
          project_id: row.project_id,
          project_name: row.project_name,
          person_name: row.person_name,
          income_category: row.income_category,
          override_ratio: Number(draft.ratio) / 100,
          reason: draft.reason.trim() || null,
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)

    if (items.length === 0) {
      notify({ type: 'error', title: '没有可保存的佣金调整' })
      return
    }

    setSavingCommission(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/system-management/commission-management/ratio-overrides/upsert`, {
        method: 'POST',
        headers: {
          ...buildBackendHeaders(session),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          report_month: month,
          items,
        }),
      })
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as RatioOverridesResponse
      setRatioOverrideRows(payload.items ?? [])
      notify({ type: 'success', title: '运营佣金比例与备注已保存' })
    } catch (submitError) {
      notify({ type: 'error', title: '运营佣金保存失败', message: submitError instanceof Error ? submitError.message : '运营佣金保存失败' })
    } finally {
      setSavingCommission(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1560px] flex-col gap-4 md:h-[calc(100dvh-8rem)] md:overflow-y-auto lg:h-[calc(100dvh-9rem)]">
      <div className="flex flex-col gap-4">
        <DataCard>
          <DataCardHeader
            badge={
              <Badge variant="outline" className="w-fit rounded-md border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
                系统管理
              </Badge>
            }
            description="统一维护项目岗位、周度绩效和运营佣金分配。岗位按月份生效，佣金与绩效都围绕当前月份核算。"
            action={
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <label htmlFor="operator_management_month" className="text-xs text-muted-foreground">核算月份</label>
                  <MonthPicker
                    value={parseMonthInputValue(month)}
                    onChange={(date) => setMonth(formatMonthInputValue(date))}
                    className="w-[190px]"
                  />
                </div>
                <RefreshButton
                  onClick={() => void refreshAll()}
                  loading={roleLoading || performanceLoading || commissionLoading}
                />
              </div>
            }
          />
        </DataCard>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as OperatorPageTab)} className="w-full">
          <TabsList className="w-full justify-start rounded-2xl border border-border/70 bg-muted/25 p-1 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
            <TabsMotionGroup id="operator-management-tabs">
              <SlidingTabsTrigger value="role-info" activeValue={activeTab} layoutId="operator-management-tabs">
                运营信息
              </SlidingTabsTrigger>
              <SlidingTabsTrigger value="performance" activeValue={activeTab} layoutId="operator-management-tabs">
                运营绩效
              </SlidingTabsTrigger>
              <SlidingTabsTrigger value="commission" activeValue={activeTab} layoutId="operator-management-tabs">
                运营佣金
              </SlidingTabsTrigger>
            </TabsMotionGroup>
          </TabsList>
        </Tabs>
      </div>

      {activeTab === 'role-info' && (
        <DataCard>
          <DataCardContent className="flex flex-col gap-4">
            <DataTableCard className="flex flex-1 flex-col overflow-hidden">
              <DataTableCardHeader className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2">
                  {COMMON_ROLE_OPTIONS.map((item) => (
                    <Badge key={item} variant="secondary" className="rounded-full">{toRoleLabel(item)}</Badge>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" onClick={addRoleRow}>
                    <PlusCircle className="h-4 w-4" />
                    新增岗位
                  </Button>
                  <Button type="button" onClick={() => void saveRoleInfo()} disabled={savingRoles}>
                    {savingRoles ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    保存运营信息
                  </Button>
                </div>
              </DataTableCardHeader>
              <DataTableCardBody className="flex-1 min-h-0 overflow-auto">
                <Table>
                  <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45">
                    <TableRow>
                      <TableHead>人员</TableHead>
                      <TableHead>项目</TableHead>
                      <TableHead>岗位</TableHead>
                      <TableHead>生效月份</TableHead>
                      <TableHead>截止月份</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {roleLoading ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-muted-foreground">加载中...</TableCell>
                      </TableRow>
                    ) : roleDraftRows.length === 0 ? (
                      <EmptyTableState colSpan={5} message="当前月份还没有岗位记录，点击右上角新增岗位即可开始维护。" />
                    ) : (
                      roleDraftRows.map((row, index) => (
                        <TableRow key={row.localId}>
                          <TableCell>
                            <Input
                              value={row.person_name}
                              list="operator-name-options"
                              onChange={(event) => {
                                const value = event.target.value
                                setRoleDraftRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, person_name: value } : item))
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <Select
                              value={row.project_id ? String(row.project_id) : ''}
                              onValueChange={(value) => {
                                setRoleDraftRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, project_id: Number(value) } : item))
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="选择项目" />
                              </SelectTrigger>
                              <SelectContent>
                                {projects.map((project) => (
                                  <SelectItem key={project.id} value={String(project.id)}>
                                    {project.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Input
                              value={row.role_type}
                              list="operator-role-options"
                              onChange={(event) => {
                                const value = event.target.value
                                setRoleDraftRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, role_type: value } : item))
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={row.effective_from_month}
                              placeholder="YYYY-MM"
                              onChange={(event) => {
                                const value = event.target.value
                                setRoleDraftRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, effective_from_month: value } : item))
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={row.effective_to_month}
                              placeholder="空代表持续有效"
                              onChange={(event) => {
                                const value = event.target.value
                                setRoleDraftRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, effective_to_month: value } : item))
                              }}
                            />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </DataTableCardBody>
            </DataTableCard>

            <datalist id="operator-name-options">
              {operatorOptions.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
            <datalist id="operator-role-options">
              {COMMON_ROLE_OPTIONS.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </DataCardContent>
        </DataCard>
      )}

      {activeTab === 'performance' && (
        <DataCard>
          <DataCardContent className="flex flex-col gap-4">
            <DataTableCard>
              <DataTableCardStatBar
                items={[
                  { label: '本月绩效记录', value: performanceStats.recordCount },
                  { label: '覆盖人员', value: performanceStats.peopleCount },
                  { label: '平均分', value: performanceStats.averageScore.toFixed(1) },
                ]}
                className={performanceLoading ? 'opacity-60' : ''}
              />
            </DataTableCard>

            <DataTableCard className="flex flex-1 flex-col overflow-hidden">
              <DataTableCardHeader className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" onClick={addPerformanceRow}>
                    <PlusCircle className="h-4 w-4" />
                    新增绩效
                  </Button>
                  <Button type="button" onClick={() => void savePerformance()} disabled={savingPerformance}>
                    {savingPerformance ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    保存绩效
                  </Button>
                </div>
              </DataTableCardHeader>
              <DataTableCardBody className="flex-1 min-h-0 overflow-auto">
                <Table>
                  <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45">
                    <TableRow>
                      <TableHead>人员</TableHead>
                      <TableHead>项目</TableHead>
                      <TableHead>岗位</TableHead>
                      <TableHead>周次</TableHead>
                      <TableHead className="text-right">绩效分</TableHead>
                      <TableHead>备注</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {performanceLoading ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground">加载中...</TableCell>
                      </TableRow>
                    ) : performanceDraftRows.length === 0 ? (
                      <EmptyTableState colSpan={6} message="当前月份还没有绩效记录，新增后即可按周打分。" />
                    ) : (
                      performanceDraftRows.map((row, index) => (
                        <TableRow key={row.localId}>
                          <TableCell>
                            <Input
                              value={row.person_name}
                              list="operator-name-options"
                              onChange={(event) => {
                                const value = event.target.value
                                setPerformanceDraftRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, person_name: value } : item))
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <Select
                              value={row.project_id ? String(row.project_id) : ''}
                              onValueChange={(value) => {
                                setPerformanceDraftRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, project_id: Number(value) } : item))
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="选择项目" />
                              </SelectTrigger>
                              <SelectContent>
                                {projects.map((project) => (
                                  <SelectItem key={project.id} value={String(project.id)}>
                                    {project.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Input
                              value={row.role_type}
                              list="operator-role-options"
                              onChange={(event) => {
                                const value = event.target.value
                                setPerformanceDraftRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, role_type: value } : item))
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <Select
                              value={String(row.week_index)}
                              onValueChange={(value) => {
                                setPerformanceDraftRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, week_index: Number(value) } : item))
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="周次" />
                              </SelectTrigger>
                              <SelectContent>
                                {[1, 2, 3, 4, 5].map((week) => (
                                  <SelectItem key={week} value={String(week)}>
                                    第 {week} 周
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              min="0"
                              max="100"
                              value={row.score}
                              className="text-right"
                              onChange={(event) => {
                                const value = event.target.value
                                setPerformanceDraftRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, score: value } : item))
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={row.note}
                              placeholder="补充说明"
                              onChange={(event) => {
                                const value = event.target.value
                                setPerformanceDraftRows((prev) => prev.map((item, itemIndex) => itemIndex === index ? { ...item, note: value } : item))
                              }}
                            />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </DataTableCardBody>
            </DataTableCard>

            <datalist id="operator-name-options">
              {operatorOptions.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
            <datalist id="operator-role-options">
              {COMMON_ROLE_OPTIONS.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </DataCardContent>
        </DataCard>
      )}

      {activeTab === 'commission' && (
        <DataCard>
          <DataCardContent className="flex flex-col gap-4">
            <DataTableCard>
              <DataTableCardStatBar
                items={[
                  { label: '已关联绩效人员', value: commissionTableRows.filter((row) => row.performanceSummary.weekCount > 0).length },
                  { label: '平均绩效点', value: commissionTableRows.length > 0
                    ? (commissionTableRows.reduce((sum, row) => sum + row.performanceSummary.averageScore, 0) / commissionTableRows.length).toFixed(1)
                    : '0.0' },
                  { label: '总绩效点', value: commissionTableRows.reduce((sum, row) => sum + row.performanceSummary.totalScore, 0) },
                ]}
                className={commissionLoading ? 'opacity-60' : ''}
              />
            </DataTableCard>

            <DataTableCard className="flex flex-1 flex-col overflow-hidden">
              <DataTableCardHeader className="flex flex-wrap items-center justify-between gap-3">
                <Button type="button" onClick={() => void saveCommissionOverrides()} disabled={savingCommission}>
                  {savingCommission ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  保存佣金调整
                </Button>
              </DataTableCardHeader>
              <DataTableCardBody className="flex-1 min-h-0 overflow-auto">
                <Table>
                  <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45">
                    <TableRow>
                      <TableHead>人员</TableHead>
                      <TableHead>项目</TableHead>
                      <TableHead>岗位</TableHead>
                      <TableHead>佣金类别</TableHead>
                      <TableHead className="text-right">绩效总分</TableHead>
                      <TableHead className="text-right">绩效均分</TableHead>
                      <TableHead className="text-right">绩效周数</TableHead>
                      <TableHead className="text-right">销售收入(USD)</TableHead>
                      <TableHead className="text-right">项目佣金率</TableHead>
                      <TableHead className="text-right">提成比例</TableHead>
                      <TableHead className="text-right">提成金额(RMB)</TableHead>
                      <TableHead>比例来源</TableHead>
                      <TableHead>备注</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {commissionLoading ? (
                      <TableRow>
                        <TableCell colSpan={13} className="text-center text-muted-foreground">加载中...</TableCell>
                      </TableRow>
                    ) : commissionTableRows.length === 0 ? (
                      <EmptyTableState colSpan={13} message="当前月份暂无佣金记录，请先完成佣金核算。" />
                    ) : (
                      commissionTableRows.map((row) => {
                        const key = `${row.project_id}::${row.person_name}::${row.income_category}`
                        const draft = commissionDrafts[key] ?? {
                          ratio: (row.operator_bonus_ratio * 100).toFixed(2),
                          reason: '',
                        }
                        return (
                          <TableRow key={row.id}>
                            <TableCell>{row.person_name}</TableCell>
                            <TableCell>{row.project_name}</TableCell>
                            <TableCell>{toRoleLabel(row.role_type)}</TableCell>
                            <TableCell>{toIncomeCategoryLabel(row.income_category)}</TableCell>
                            <TableCell className="text-right tabular-nums font-medium">
                              {row.performanceSummary.weekCount > 0 ? row.performanceSummary.totalScore : '-'}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.performanceSummary.weekCount > 0 ? row.performanceSummary.averageScore.toFixed(1) : '-'}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.performanceSummary.weekCount > 0 ? row.performanceSummary.weekCount : '-'}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{formatUsd(row.income_total_usd)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatPercent(row.factory_commission_rate)}</TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                min="0"
                                max="100"
                                step="0.01"
                                value={draft.ratio}
                                className="min-w-[110px] text-right"
                                onChange={(event) => {
                                  const value = event.target.value
                                  setCommissionDrafts((prev) => ({ ...prev, [key]: { ...draft, ratio: value } }))
                                }}
                              />
                            </TableCell>
                            <TableCell className="text-right tabular-nums font-medium">{formatRmb(row.bonus_amount_rmb)}</TableCell>
                            <TableCell>{row.override ? '手动' : '规则'}</TableCell>
                            <TableCell>
                              <Input
                                value={draft.reason}
                                placeholder="填写说明"
                                onChange={(event) => {
                                  const value = event.target.value
                                  setCommissionDrafts((prev) => ({ ...prev, [key]: { ...draft, reason: value } }))
                                }}
                              />
                            </TableCell>
                          </TableRow>
                        )
                      })
                    )}
                  </TableBody>
                </Table>
              </DataTableCardBody>
            </DataTableCard>

            <DataCard>
              <DataCardHeader
                title="运营佣金备注"
                description='这里承接原"运营提成"页签的规则说明。当前仍沿用原有运营与助理的基础分配逻辑，后续可以在这个页面继续叠加绩效点、岗位差异和更多岗位类型。'
              />
              <DataCardContent className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
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
              </DataCardContent>
            </DataCard>
          </DataCardContent>
        </DataCard>
      )}
    </div>
  )
}