'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Coins, PlusCircle, Save, TrendingUp, Users } from 'lucide-react'
import { useSession } from 'next-auth/react'

import {
  WarmBadge,
  WarmButton,
  WarmSelect,
  type WarmSelectOption,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { buildBackendClientHeaders } from '@/lib/backend-auth'
import {
  fetchManagedProjectsCached,
  fetchProjectOperatorOptionsCached,
} from '@/lib/project-client-cache'
import { useNotifications } from '@/components/notifications'
import styles from './operator-management-warm.module.css'

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
const WEEK_OPTIONS: WarmSelectOption[] = [1, 2, 3, 4, 5].map((week) => ({
  value: String(week),
  label: `第 ${week} 周`,
}))

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
  // 已访问过的 tab（BEL-424）：performance / commission 首次激活才拉数，
  // 之后月份切换 / 手动刷新跟随已访问集合重拉，保持"看过即新鲜"语义。
  const [visitedTabs, setVisitedTabs] = useState<OperatorPageTab[]>(['role-info'])
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
  const [commissionDrafts, setCommissionDrafts] = useState<Record<string, CommissionEditableDraft>>(
    {}
  )

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
      peopleCount: new Set(performanceRows.map((item) => `${item.project_id}-${item.person_name}`))
        .size,
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
  }, [
    commissionOverrideMap,
    commissionRows,
    performanceSummaryByProjectPerson,
    roleMapByProjectPerson,
  ])

  const loadBaseOptions = useCallback(async () => {
    // 复用 projects/manage + operator-options 的 2min 客户端缓存（BEL-424）：
    // 与其他页面共享同一份项目/运营者元数据，warm 复访 0 请求。
    const [projectPayload, operatorPayload] = await Promise.all([
      fetchManagedProjectsCached<ManageProject[]>(session),
      fetchProjectOperatorOptionsCached(),
    ])
    setProjects(Array.isArray(projectPayload) ? projectPayload : [])
    setOperatorOptions(Array.isArray(operatorPayload) ? operatorPayload : [])
  }, [session])

  const loadRoleInfo = useCallback(async () => {
    setRoleLoading(true)
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/system-management/commission-management/role-assignments?report_month=${month}`,
        {
          cache: 'no-store',
          headers: buildBackendClientHeaders(session),
        }
      )
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
      const response = await fetch(
        `${API_BASE}/api/v1/system-management/operator-management/performance?report_month=${month}`,
        {
          cache: 'no-store',
          headers: buildBackendClientHeaders(session),
        }
      )
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
        fetch(
          `${API_BASE}/api/v1/system-management/commission-management/records?report_month=${month}`,
          {
            cache: 'no-store',
            headers: buildBackendClientHeaders(session),
          }
        ),
        fetch(
          `${API_BASE}/api/v1/system-management/commission-management/ratio-overrides?report_month=${month}`,
          {
            cache: 'no-store',
            headers: buildBackendClientHeaders(session),
          }
        ),
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
          const override = nextOverrides.find(
            (row) =>
              row.project_id === item.project_id &&
              row.person_name === item.person_name &&
              row.income_category === item.income_category
          )
          acc[key] = {
            ratio: (
              (override?.override_ratio ?? item.manual_bonus_ratio ?? item.operator_bonus_ratio) *
              100
            ).toFixed(2),
            reason: override?.reason ?? '',
          }
          return acc
        }, {})
      )
    } finally {
      setCommissionLoading(false)
    }
  }, [month, session])

  const refreshAll = useCallback(async () => {
    try {
      await loadBaseOptions()
      const loads: Array<Promise<unknown>> = [loadRoleInfo()]
      if (visitedTabs.includes('performance')) loads.push(loadPerformance())
      if (visitedTabs.includes('commission')) loads.push(loadCommission())
      await Promise.all(loads)
    } catch (loadError) {
      notify({
        type: 'error',
        title: '数据加载失败',
        message: loadError instanceof Error ? loadError.message : '加载失败',
      })
    }
  }, [loadBaseOptions, loadCommission, loadPerformance, loadRoleInfo, notify, visitedTabs])

  // —— BLF-997: head 插槽 + 全局刷新 ——
  const refreshRef = useRef(refreshAll)
  refreshRef.current = refreshAll
  const isLoading = roleLoading || performanceLoading || commissionLoading
  useHeaderRefresh(() => refreshRef.current(), { loading: isLoading })

  const monthOptions = useMemo(() => {
    const options: WarmSelectOption[] = []
    const now = new Date()
    for (let i = 0; i < 24; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      options.push({ value: `${y}-${m}`, label: `${y}-${m}` })
    }
    return options
  }, [])

  // 首次 mount / 月份变化：只拉基础选项 + 当前激活的 role-info；
  // performance / commission 推迟到各自 tab 首次激活（见下方门控 effect）。
  useEffect(() => {
    void (async () => {
      try {
        await loadBaseOptions()
        await loadRoleInfo()
      } catch (loadError) {
        notify({
          type: 'error',
          title: '数据加载失败',
          message: loadError instanceof Error ? loadError.message : '加载失败',
        })
      }
    })()
  }, [loadBaseOptions, loadRoleInfo, notify])

  const visitedPerformance = visitedTabs.includes('performance')
  const visitedCommission = visitedTabs.includes('commission')

  useEffect(() => {
    if (!visitedPerformance) return
    void loadPerformance().catch((loadError) => {
      notify({
        type: 'error',
        title: '数据加载失败',
        message: loadError instanceof Error ? loadError.message : '加载失败',
      })
    })
  }, [visitedPerformance, loadPerformance, notify])

  useEffect(() => {
    if (!visitedCommission) return
    void loadCommission().catch((loadError) => {
      notify({
        type: 'error',
        title: '数据加载失败',
        message: loadError instanceof Error ? loadError.message : '加载失败',
      })
    })
  }, [visitedCommission, loadCommission, notify])

  const handleTabChange = useCallback((value: OperatorPageTab) => {
    setActiveTab(value)
    setVisitedTabs((prev) => (prev.includes(value) ? prev : [...prev, value]))
  }, [])

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
    const validRows = roleDraftRows.filter(
      (item) =>
        item.project_id &&
        item.person_name.trim() &&
        item.role_type.trim() &&
        item.effective_from_month.trim()
    )
    if (validRows.length === 0) {
      notify({ type: 'error', title: '请至少填写一条完整的运营信息' })
      return
    }

    setSavingRoles(true)
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/system-management/commission-management/role-assignments/upsert`,
        {
          method: 'POST',
          headers: {
            ...buildBackendClientHeaders(session),
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
        }
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as RoleAssignmentsResponse
      setRoleRows(payload.items ?? [])
      setRoleDraftRows(buildRoleDraft(payload.items ?? []))
      notify({ type: 'success', title: '运营信息已保存' })
    } catch (submitError) {
      notify({
        type: 'error',
        title: '运营信息保存失败',
        message: submitError instanceof Error ? submitError.message : '运营信息保存失败',
      })
    } finally {
      setSavingRoles(false)
    }
  }

  const savePerformance = async () => {
    const validRows = performanceDraftRows.filter(
      (item) =>
        item.project_id && item.person_name.trim() && item.role_type.trim() && item.score.trim()
    )
    if (validRows.length === 0) {
      notify({ type: 'error', title: '请至少填写一条完整的运营绩效' })
      return
    }

    setSavingPerformance(true)
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/system-management/operator-management/performance/upsert`,
        {
          method: 'POST',
          headers: {
            ...buildBackendClientHeaders(session),
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
        }
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as PerformanceResponse
      setPerformanceRows(payload.items ?? [])
      setPerformanceDraftRows(buildPerformanceDraft(payload.items ?? []))
      notify({ type: 'success', title: '运营绩效已保存' })
    } catch (submitError) {
      notify({
        type: 'error',
        title: '运营绩效保存失败',
        message: submitError instanceof Error ? submitError.message : '运营绩效保存失败',
      })
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
      const response = await fetch(
        `${API_BASE}/api/v1/system-management/commission-management/ratio-overrides/upsert`,
        {
          method: 'POST',
          headers: {
            ...buildBackendClientHeaders(session),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            report_month: month,
            items,
          }),
        }
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as RatioOverridesResponse
      setRatioOverrideRows(payload.items ?? [])
      notify({ type: 'success', title: '运营佣金比例与备注已保存' })
    } catch (submitError) {
      notify({
        type: 'error',
        title: '运营佣金保存失败',
        message: submitError instanceof Error ? submitError.message : '运营佣金保存失败',
      })
    } finally {
      setSavingCommission(false)
    }
  }


  return (
    <div className={styles.page} data-warm-operator-management="true">
      <div className={styles.toolbar}>
        <Tabs
          value={activeTab}
          onValueChange={(value) => handleTabChange(value as OperatorPageTab)}
          className={styles.tabs}
        >
          <TabsList className={styles.tabList} aria-label="运营管理">
            <TabsTrigger className={styles.tabTrigger} value="role-info">
              <Users aria-hidden="true" />
              运营信息
            </TabsTrigger>
            <TabsTrigger className={styles.tabTrigger} value="performance">
              <TrendingUp aria-hidden="true" />
              运营绩效
            </TabsTrigger>
            <TabsTrigger className={styles.tabTrigger} value="commission">
              <Coins aria-hidden="true" />
              运营佣金
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <WarmSelect
          id="operator-report-month"
          label="核算月份"
          value={month}
          options={monthOptions}
          onChange={setMonth}
          className={styles.monthSelect}
        />
      </div>

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

      {activeTab === 'role-info' && (
        <section className={styles.panel} aria-label="运营信息">
          <header className={styles.panelHeader}>
            <div className={styles.panelLead}>
              <h2 className={styles.panelTitle}>运营信息</h2>
              {COMMON_ROLE_OPTIONS.map((item) => (
                <WarmBadge key={item} className={styles.roleChip}>
                  {toRoleLabel(item)}
                </WarmBadge>
              ))}
            </div>
            <div className={styles.actions}>
              <WarmButton
                type="button"
                variant="secondary"
                className={styles.actionButton}
                onClick={addRoleRow}
              >
                <PlusCircle aria-hidden="true" />
                新增岗位
              </WarmButton>
              <WarmButton
                type="button"
                variant="primary"
                className={styles.actionButton}
                onClick={() => void saveRoleInfo()}
                loading={savingRoles}
                loadingLabel="正在保存运营信息"
              >
                <Save aria-hidden="true" />
                保存运营信息
              </WarmButton>
            </div>
          </header>

          <div className={styles.tableWrap}>
            <table className={`${styles.dataTable} ${styles.roleTable}`} aria-label="运营岗位列表">
              <thead>
                <tr>
                  <th scope="col">人员</th>
                  <th scope="col">项目</th>
                  <th scope="col">岗位</th>
                  <th scope="col">生效月份</th>
                  <th scope="col">截止月份</th>
                </tr>
              </thead>
              <tbody>
                {roleLoading ? (
                  <tr>
                    <td className={styles.stateCell} colSpan={5} role="status">
                      加载中...
                    </td>
                  </tr>
                ) : roleDraftRows.length === 0 ? (
                  <tr>
                    <td className={styles.stateCell} colSpan={5}>
                      当前月份还没有岗位记录，点击右上角新增岗位即可开始维护。
                    </td>
                  </tr>
                ) : (
                  roleDraftRows.map((row, index) => (
                    <tr key={row.localId}>
                      <td>
                        <Input
                          aria-label={`第 ${index + 1} 行人员`}
                          value={row.person_name}
                          list="operator-name-options"
                          className={styles.rowInput}
                          onChange={(event) => {
                            const value = event.target.value
                            setRoleDraftRows((prev) =>
                              prev.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, person_name: value } : item
                              )
                            )
                          }}
                        />
                      </td>
                      <td>
                        <WarmSelect
                          id={`operator-role-project-${row.localId}`}
                          label="项目"
                          value={row.project_id ? String(row.project_id) : ''}
                          options={projects.map((project) => ({
                            value: String(project.id),
                            label: project.name,
                          }))}
                          placeholder="选择项目"
                          className={styles.rowSelect}
                          onChange={(value) => {
                            setRoleDraftRows((prev) =>
                              prev.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, project_id: Number(value) }
                                  : item
                              )
                            )
                          }}
                        />
                      </td>
                      <td>
                        <Input
                          aria-label={`第 ${index + 1} 行岗位`}
                          value={row.role_type}
                          list="operator-role-options"
                          className={styles.rowInput}
                          onChange={(event) => {
                            const value = event.target.value
                            setRoleDraftRows((prev) =>
                              prev.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, role_type: value } : item
                              )
                            )
                          }}
                        />
                      </td>
                      <td>
                        <Input
                          aria-label={`第 ${index + 1} 行生效月份`}
                          value={row.effective_from_month}
                          placeholder="YYYY-MM"
                          className={styles.rowInput}
                          onChange={(event) => {
                            const value = event.target.value
                            setRoleDraftRows((prev) =>
                              prev.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, effective_from_month: value }
                                  : item
                              )
                            )
                          }}
                        />
                      </td>
                      <td>
                        <Input
                          aria-label={`第 ${index + 1} 行截止月份`}
                          value={row.effective_to_month}
                          placeholder="空代表持续有效"
                          className={styles.rowInput}
                          onChange={(event) => {
                            const value = event.target.value
                            setRoleDraftRows((prev) =>
                              prev.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, effective_to_month: value }
                                  : item
                              )
                            )
                          }}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {activeTab === 'performance' && (
        <section className={styles.panel} aria-label="运营绩效">
          <header className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>运营绩效</h2>
            <div className={styles.actions}>
              <WarmButton
                type="button"
                variant="secondary"
                className={styles.actionButton}
                onClick={addPerformanceRow}
              >
                <PlusCircle aria-hidden="true" />
                新增绩效
              </WarmButton>
              <WarmButton
                type="button"
                variant="primary"
                className={styles.actionButton}
                onClick={() => void savePerformance()}
                loading={savingPerformance}
                loadingLabel="正在保存运营绩效"
              >
                <Save aria-hidden="true" />
                保存绩效
              </WarmButton>
            </div>
          </header>

          <div className={styles.metricStrip} aria-busy={performanceLoading || undefined}>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>本月绩效记录</span>
              <strong className={styles.metricValue}>{performanceStats.recordCount}</strong>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>覆盖人员</span>
              <strong className={styles.metricValue}>{performanceStats.peopleCount}</strong>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>平均分</span>
              <strong className={styles.metricValue}>
                {performanceStats.averageScore.toFixed(1)}
              </strong>
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table
              className={`${styles.dataTable} ${styles.performanceTable}`}
              aria-label="运营绩效列表"
            >
              <thead>
                <tr>
                  <th scope="col">人员</th>
                  <th scope="col">项目</th>
                  <th scope="col">岗位</th>
                  <th scope="col">周次</th>
                  <th scope="col" className={styles.numericCell}>
                    绩效分
                  </th>
                  <th scope="col">备注</th>
                </tr>
              </thead>
              <tbody>
                {performanceLoading ? (
                  <tr>
                    <td className={styles.stateCell} colSpan={6} role="status">
                      加载中...
                    </td>
                  </tr>
                ) : performanceDraftRows.length === 0 ? (
                  <tr>
                    <td className={styles.stateCell} colSpan={6}>
                      当前月份还没有绩效记录，新增后即可按周打分。
                    </td>
                  </tr>
                ) : (
                  performanceDraftRows.map((row, index) => (
                    <tr key={row.localId}>
                      <td>
                        <Input
                          aria-label={`第 ${index + 1} 行绩效人员`}
                          value={row.person_name}
                          list="operator-name-options"
                          className={styles.rowInput}
                          onChange={(event) => {
                            const value = event.target.value
                            setPerformanceDraftRows((prev) =>
                              prev.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, person_name: value } : item
                              )
                            )
                          }}
                        />
                      </td>
                      <td>
                        <WarmSelect
                          id={`operator-performance-project-${row.localId}`}
                          label="项目"
                          value={row.project_id ? String(row.project_id) : ''}
                          options={projects.map((project) => ({
                            value: String(project.id),
                            label: project.name,
                          }))}
                          placeholder="选择项目"
                          className={styles.rowSelect}
                          onChange={(value) => {
                            setPerformanceDraftRows((prev) =>
                              prev.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, project_id: Number(value) }
                                  : item
                              )
                            )
                          }}
                        />
                      </td>
                      <td>
                        <Input
                          aria-label={`第 ${index + 1} 行绩效岗位`}
                          value={row.role_type}
                          list="operator-role-options"
                          className={styles.rowInput}
                          onChange={(event) => {
                            const value = event.target.value
                            setPerformanceDraftRows((prev) =>
                              prev.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, role_type: value } : item
                              )
                            )
                          }}
                        />
                      </td>
                      <td>
                        <WarmSelect
                          id={`operator-performance-week-${row.localId}`}
                          label="周次"
                          value={String(row.week_index)}
                          options={WEEK_OPTIONS}
                          className={`${styles.rowSelect} ${styles.rowSelectWide}`}
                          onChange={(value) => {
                            setPerformanceDraftRows((prev) =>
                              prev.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, week_index: Number(value) }
                                  : item
                              )
                            )
                          }}
                        />
                      </td>
                      <td>
                        <Input
                          aria-label={`第 ${index + 1} 行绩效分`}
                          type="number"
                          min="0"
                          max="100"
                          value={row.score}
                          className={`${styles.rowInput} ${styles.numericInput}`}
                          onChange={(event) => {
                            const value = event.target.value
                            setPerformanceDraftRows((prev) =>
                              prev.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, score: value } : item
                              )
                            )
                          }}
                        />
                      </td>
                      <td>
                        <Input
                          aria-label={`第 ${index + 1} 行绩效备注`}
                          value={row.note}
                          placeholder="补充说明"
                          className={styles.rowInput}
                          onChange={(event) => {
                            const value = event.target.value
                            setPerformanceDraftRows((prev) =>
                              prev.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, note: value } : item
                              )
                            )
                          }}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {activeTab === 'commission' && (
        <section className={styles.panel} aria-label="运营佣金">
          <header className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>运营佣金</h2>
            <div className={styles.actions}>
              <WarmButton
                type="button"
                variant="primary"
                className={styles.actionButton}
                onClick={() => void saveCommissionOverrides()}
                loading={savingCommission}
                loadingLabel="正在保存佣金调整"
              >
                <Save aria-hidden="true" />
                保存佣金调整
              </WarmButton>
            </div>
          </header>

          <div className={styles.metricStrip} aria-busy={commissionLoading || undefined}>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>已关联绩效人员</span>
              <strong className={styles.metricValue}>
                {commissionTableRows.filter((row) => row.performanceSummary.weekCount > 0).length}
              </strong>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>平均绩效点</span>
              <strong className={styles.metricValue}>
                {commissionTableRows.length > 0
                  ? (
                      commissionTableRows.reduce(
                        (sum, row) => sum + row.performanceSummary.averageScore,
                        0
                      ) / commissionTableRows.length
                    ).toFixed(1)
                  : '0.0'}
              </strong>
            </div>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>总绩效点</span>
              <strong className={styles.metricValue}>
                {commissionTableRows.reduce(
                  (sum, row) => sum + row.performanceSummary.totalScore,
                  0
                )}
              </strong>
            </div>
          </div>

          <div className={`${styles.tableWrap} ${styles.tableWrapCommission}`}>
            <table
              className={`${styles.dataTable} ${styles.commissionTable}`}
              aria-label="运营佣金列表"
            >
              <thead>
                <tr>
                  <th scope="col">人员</th>
                  <th scope="col">项目</th>
                  <th scope="col">岗位</th>
                  <th scope="col">佣金类别</th>
                  <th scope="col" className={styles.numericCell}>
                    绩效总分
                  </th>
                  <th scope="col" className={styles.numericCell}>
                    绩效均分
                  </th>
                  <th scope="col" className={styles.numericCell}>
                    绩效周数
                  </th>
                  <th scope="col" className={styles.numericCell}>
                    销售收入(USD)
                  </th>
                  <th scope="col" className={styles.numericCell}>
                    项目佣金率
                  </th>
                  <th scope="col" className={styles.numericCell}>
                    提成比例
                  </th>
                  <th scope="col" className={styles.numericCell}>
                    提成金额(RMB)
                  </th>
                  <th scope="col">比例来源</th>
                  <th scope="col">备注</th>
                </tr>
              </thead>
              <tbody>
                {commissionLoading ? (
                  <tr>
                    <td className={styles.stateCell} colSpan={13} role="status">
                      加载中...
                    </td>
                  </tr>
                ) : commissionTableRows.length === 0 ? (
                  <tr>
                    <td className={styles.stateCell} colSpan={13}>
                      当前月份暂无佣金记录，请先完成佣金核算。
                    </td>
                  </tr>
                ) : (
                  commissionTableRows.map((row) => {
                    const key = `${row.project_id}::${row.person_name}::${row.income_category}`
                    const draft = commissionDrafts[key] ?? {
                      ratio: (row.operator_bonus_ratio * 100).toFixed(2),
                      reason: '',
                    }
                    return (
                      <tr key={row.id}>
                        <td>{row.person_name}</td>
                        <td>{row.project_name}</td>
                        <td>{toRoleLabel(row.role_type)}</td>
                        <td>{toIncomeCategoryLabel(row.income_category)}</td>
                        <td className={styles.numericCell}>
                          {row.performanceSummary.weekCount > 0
                            ? row.performanceSummary.totalScore
                            : '-'}
                        </td>
                        <td className={styles.numericCell}>
                          {row.performanceSummary.weekCount > 0
                            ? row.performanceSummary.averageScore.toFixed(1)
                            : '-'}
                        </td>
                        <td className={styles.numericCell}>
                          {row.performanceSummary.weekCount > 0
                            ? row.performanceSummary.weekCount
                            : '-'}
                        </td>
                        <td className={styles.numericCell}>
                          {formatUsd(row.income_total_usd)}
                        </td>
                        <td className={styles.numericCell}>
                          {formatPercent(row.factory_commission_rate)}
                        </td>
                        <td>
                          <Input
                            aria-label={`${row.person_name} ${toIncomeCategoryLabel(row.income_category)}提成比例`}
                            type="number"
                            min="0"
                            max="100"
                            step="0.01"
                            value={draft.ratio}
                            className={`${styles.rowInput} ${styles.numericInput}`}
                            onChange={(event) => {
                              const value = event.target.value
                              setCommissionDrafts((prev) => ({
                                ...prev,
                                [key]: { ...draft, ratio: value },
                              }))
                            }}
                          />
                        </td>
                        <td className={styles.numericCell}>{formatRmb(row.bonus_amount_rmb)}</td>
                        <td>
                          <span
                            className={`${styles.sourcePill} ${
                              row.override ? styles.sourcePillManual : ''
                            }`}
                          >
                            {row.override ? '手动' : '规则'}
                          </span>
                        </td>
                        <td>
                          <Input
                            aria-label={`${row.person_name} ${toIncomeCategoryLabel(row.income_category)}备注`}
                            value={draft.reason}
                            placeholder="填写说明"
                            className={styles.rowInput}
                            onChange={(event) => {
                              const value = event.target.value
                              setCommissionDrafts((prev) => ({
                                ...prev,
                                [key]: { ...draft, reason: value },
                              }))
                            }}
                          />
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className={styles.notePanel}>
            <h2 className={styles.noteTitle}>运营佣金备注</h2>
            <div className={styles.tierGrid}>
              {OPERATOR_PUBLIC_COMMISSION_TIERS.map((item, index) => (
                <article key={item.range} className={styles.tier}>
                  <span className={styles.tierIndex}>Tier {index + 1}</span>
                  <span className={styles.tierLabel}>月销售额</span>
                  <span className={styles.tierRange}>{item.range}</span>
                  <span className={styles.tierRatio}>运营提成比例 {item.ratio}</span>
                  {item.note ? <p className={styles.tierNote}>备注：{item.note}</p> : null}
                </article>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
