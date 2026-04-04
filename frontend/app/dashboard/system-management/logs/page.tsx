'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Eye,
  Loader2,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DataCard,
  DataCardHeader,
  DataTableCard,
  DataTableCardBody,
  DataTableCardHeader,
  DataTableCardStatBar,
} from '@/components/ui/data-card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { buildBackendHeaders } from '@/lib/backend-auth'
import { normalizeErrorMessage, parseResponseError } from '@/lib/error-utils'
import { useNotifications } from '@/components/notifications'

type OperationAuditLogItem = {
  id: number
  created_at: string
  operator: string | null
  action: string
  target_type: string
  target_id: string | null
  result: string
  trace_id: string | null
  request_method: string | null
  request_path: string | null
  ip_address: string | null
  user_agent: string | null
  before_json: Record<string, unknown> | unknown[] | null
  after_json: Record<string, unknown> | unknown[] | null
  error_message: string | null
}

type OperationAuditLogsResponse = {
  items: OperationAuditLogItem[]
  total: number
  page: number
  page_size: number
  has_next: boolean
}

type OperationAuditLogModuleSummaryItem = {
  key: string
  label: string
  count: number
  success_count: number
  failure_count: number
}

type OperationAuditLogActionSummaryItem = {
  action: string
  count: number
}

type OperationAuditLogsSummaryResponse = {
  total: number
  success_count: number
  failure_count: number
  unique_operator_count: number
  modules: OperationAuditLogModuleSummaryItem[]
  top_actions: OperationAuditLogActionSummaryItem[]
}

type CategoryKey =
  | 'all'
  | 'commission'
  | 'shipment'
  | 'sku'
  | 'project'
  | 'account'
  | 'inventory'
  | 'system'
  | 'report'
  | 'other'

type CategoryMeta = {
  key: Exclude<CategoryKey, 'all'>
  label: string
  description: string
  prefixes: string[]
  className: string
}

const API_BASE = '/api/backend'

const CATEGORY_OPTIONS: CategoryMeta[] = [
  {
    key: 'commission',
    label: '提成与绩效',
    description: '提成管理',
    prefixes: ['commission.', 'operator.performance.'],
    className: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300',
  },
  {
    key: 'shipment',
    label: '发货管理',
    description: '发货管理',
    prefixes: ['shipment_schedules.'],
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  {
    key: 'sku',
    label: 'SKU资料',
    description: 'SKU资料',
    prefixes: ['sku_info.'],
    className: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  },
  {
    key: 'project',
    label: '项目资料',
    description: '项目管理',
    prefixes: ['projects.'],
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  {
    key: 'account',
    label: '账号权限',
    description: '账号权限',
    prefixes: ['users.'],
    className: 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300',
  },
  {
    key: 'inventory',
    label: '库存补货',
    description: '库存补货',
    prefixes: ['inventory_analysis.', 'inventory_replenishment.', 'inventory_replenishment_settings.'],
    className: 'border-lime-500/30 bg-lime-500/10 text-lime-700 dark:text-lime-300',
  },
  {
    key: 'system',
    label: '系统运维',
    description: '系统运维',
    prefixes: ['system.'],
    className: 'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300',
  },
  {
    key: 'report',
    label: '报表中心',
    description: '报表中心',
    prefixes: ['daily_reports.', 'daily_analysis.', 'monthly_reports.', 'financial_data.', 'product_analysis.', 'product_analysis_reports.', 'pricing_calculation.', 'report_upload.'],
    className: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300',
  },
  {
    key: 'other',
    label: '其他',
    description: '其他',
    prefixes: [],
    className: 'border-border/70 bg-muted/40 text-muted-foreground',
  },
]

const CATEGORY_FILTER_ACTIONS: Record<Exclude<CategoryKey, 'all' | 'other'>, string> = {
  commission: 'commission.',
  shipment: 'shipment_schedules.',
  sku: 'sku_info.',
  project: 'projects.',
  account: 'users.',
  inventory: 'inventory_',
  system: 'system.',
  report: 'report',
}

const ACTION_LABELS: Record<string, string> = {
  'users.list': '查看账号列表',
  'users.create': '创建账号',
  'users.update': '更新账号',
  'projects.list': '查看项目列表',
  'projects.create': '创建项目',
  'projects.update': '更新项目',
  'projects.options.view': '查看项目选项',
  'projects.operator_options.view': '查看项目运营人选项',
  'sku_info.list': '查看 SKU 资料',
  'sku_info.upsert': '新增或更新 SKU 资料',
  'sku_info.bulk_upsert': '批量新增或更新 SKU 资料',
  'sku_info.update': '更新 SKU 资料',
  'sku_info.move_sort': '调整 SKU 排序',
  'sku_info.import_csv': '导入 SKU CSV',
  'sku_info.export': '导出 SKU 数据',
  'sku_info.import_default_file': '导入默认 SKU 文件',
  'sku_info.recalculate_first_leg_costs': '重算头程成本',
  'shipment_schedules.list': '查看发货计划列表',
  'shipment_schedules.detail.view': '查看发货计划详情',
  'shipment_schedules.cost_summary.view': '查看发货成本汇总',
  'shipment_schedules.sku_summary.view': '查看 SKU 头程均价汇总',
  'shipment_schedules.fba_box_details.view': '查看箱规明细',
  'shipment_schedules.create': '创建发货计划',
  'shipment_schedules.import_csv': '导入发货计划 CSV',
  'shipment_schedules.update': '更新发货计划',
  'shipment_schedules.delete': '删除发货计划',
  'shipment_schedules.import_items_csv': '导入发货明细 CSV',
  'shipment_schedules.calculate_costs': '计算发货成本',
  'shipment_schedules.overview.export': '导出船期批次总览',
  'shipment_schedules.costs.export': '导出发货费用',
  'shipment_schedules.sku_summary.export': '导出 SKU 汇总',
  'shipment_schedules.fba_box_details.export': '导出 FBA 箱单明细',
  'inventory_analysis.view': '查看库存分析',
  'inventory_analysis.export': '导出库存分析',
  'inventory_replenishment.list': '查看补货分析列表',
  'inventory_replenishment.shipments.view': '查看补货在途记录',
  'inventory_replenishment.export': '导出补货分析',
  'inventory_replenishment_settings.upsert': '维护补货参数',
  'system.data_management.status.view': '查看数据状态',
  'system.data_management.overview.view': '查看系统数据总览',
  'system.data_status.update': '更新数据状态',
  'commission.bonus_records.view': '查看提成明细',
  'commission.bonus_records.upsert': '导入提成明细',
  'commission.bonus.recompute': '重算提成数据',
  'commission.bonus_record.payment_status.update': '更新个人提成打款状态',
  'commission.project_months.view': '查看项目提成汇总',
  'commission.summary.monthly.view': '查看年度月度汇总',
  'commission.summary.project.view': '查看项目年度汇总',
  'commission.project_commission.payment.update': '更新项目回款状态',
  'commission.ratio_overrides.view': '查看提成比例覆盖',
  'commission.ratio_overrides.upsert': '维护提成比例覆盖',
  'commission.role_assignments.view': '查看项目角色分配',
  'commission.role_assignments.upsert': '维护项目角色分配',
  'operator.performance.view': '查看运营绩效',
  'operator.performance.upsert': '维护运营绩效',
  'daily_reports.create': '生成日报',
  'daily_reports.result.view': '查看日报结果',
  'daily_reports.result.export': '导出日报结果',
  'daily_analysis.export': '导出销售数据分析',
  'monthly_reports.create': '生成月报',
  'monthly_reports.result.view': '查看月报结果',
  'monthly_reports.result.export': '导出月报任务结果',
  'monthly_reports.export': '导出月报',
  'financial_data.export': '导出月度财务分析',
  'product_analysis.weekly.recompute': '重新核算周报',
  'product_analysis.weekly.export': '导出周报分析',
  'product_analysis_reports.create': '生成产品分析报表',
  'product_analysis_reports.result.view': '查看产品分析报表',
  'product_analysis_reports.result.export': '导出产品分析报表',
  'pricing_calculation.run.create': '发起报价测算',
  'pricing_calculation.run.delete': '删除报价测算',
  'pricing_calculation.run.recalculate': '重新核算报价测算',
  'pricing_calculation.run.view': '查看报价测算结果',
  'pricing_calculation.comparison.export': '导出测算对比矩阵',
  'pricing_calculation.store_table.export': '导出店铺 SKU 核算表',
  'pricing_calculation.store_snapshot.upsert': '保存店铺 SKU 核算快照',
  'report_upload.status.view': '查看报表上传状态',
  'report_upload.recognize': '识别报表内容',
  'report_upload.commit': '提交报表入库',
}

const TARGET_TYPE_LABELS: Record<string, string> = {
  user_account: '账号',
  project: '项目',
  project_operator: '项目运营人',
  product_cost: 'SKU 资料',
  shipment_schedule: '发货计划',
  inventory_analysis: '库存分析',
  inventory_replenishment: '补货分析',
  inventory_replenishment_setting: '补货参数',
  system_management: '系统管理',
  system_management_data_state: '数据状态',
  commission_bonus_record: '提成记录',
  commission_project_month: '项目提成汇总',
  commission_ratio_override: '提成比例覆盖',
  project_role_assignment: '项目角色分配',
  operator_performance_record: '运营绩效',
  commission_summary: '提成汇总',
  daily_report_task: '日报任务',
  monthly_report_task: '月报任务',
  monthly_report: '月报',
  product_analysis_report_task: '产品分析任务',
  report_upload: '报表入库',
  report_upload_temp_file: '报表临时文件',
  pricing_calculation_run: '定价测算',
  store_sku_pricing_snapshot: '店铺 SKU 核算快照',
  product_analysis_weekly: '周报分析',
}

const RESULT_META = {
  success: { label: '成功', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  failure: { label: '失败', className: 'border-destructive/30 bg-destructive/10 text-destructive' },
} as const

function formatDateTime(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

async function parseError(response: Response): Promise<string> {
  return parseResponseError(response, '请求失败')
}

function renderJson(value: unknown): string {
  if (value == null) return '-'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function getCategoryMeta(action: string): CategoryMeta {
  const matched = CATEGORY_OPTIONS.find((item) => item.prefixes.some((prefix) => action.startsWith(prefix)))
  return matched || CATEGORY_OPTIONS.find((item) => item.key === 'other')!
}

function formatActionLabel(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action]

  const parts = action.split('.')
  const last = parts[parts.length - 1] || action
  const fallbackVerbLabels: Record<string, string> = {
    list: '查看列表',
    view: '查看详情',
    create: '新建',
    update: '更新',
    delete: '删除',
    upsert: '新增或更新',
    export: '导出',
    recompute: '重算',
  }

  return fallbackVerbLabels[last] ? `${getCategoryMeta(action).label} · ${fallbackVerbLabels[last]}` : action
}

function formatTargetTypeLabel(targetType: string): string {
  return TARGET_TYPE_LABELS[targetType] || targetType || '-'
}

function getResultMeta(result: string) {
  return result === 'failure' ? RESULT_META.failure : RESULT_META.success
}

export default function SystemOperationLogsPage() {
  const { notify } = useNotifications()
  const { data: session, status } = useSession()

  const [rows, setRows] = useState<OperationAuditLogItem[]>([])
  const [summary, setSummary] = useState<OperationAuditLogsSummaryResponse | null>(null)
  const [loading, setLoading] = useState(false)

  const [page, setPage] = useState(1)
  const pageSize = 20
  const [total, setTotal] = useState(0)
  const [hasNext, setHasNext] = useState(false)

  const [keywordInput, setKeywordInput] = useState('')
  const [operatorInput, setOperatorInput] = useState('')
  const [categoryInput, setCategoryInput] = useState<CategoryKey>('all')

  const [keyword, setKeyword] = useState('')
  const [operator, setOperator] = useState('')
  const [category, setCategory] = useState<CategoryKey>('all')

  const [activeRow, setActiveRow] = useState<OperationAuditLogItem | null>(null)

  const fetchLogs = useCallback(async () => {
    if (status === 'loading') return
    setLoading(true)

    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('page_size', String(pageSize))
      if (keyword) params.set('keyword', keyword)
      if (operator) params.set('operator', operator)
      if (category !== 'all' && category !== 'other') {
        params.set('action', CATEGORY_FILTER_ACTIONS[category])
      }

      const headers = buildBackendHeaders(session)
      const [logsResponse, summaryResponse] = await Promise.all([
        fetch(`${API_BASE}/api/v1/system-management/audit-logs?${params.toString()}`, {
          headers,
          cache: 'no-store',
        }),
        fetch(`${API_BASE}/api/v1/system-management/audit-logs/summary?${params.toString()}`, {
          headers,
          cache: 'no-store',
        }),
      ])

      if (!logsResponse.ok) throw new Error(await parseError(logsResponse))
      if (!summaryResponse.ok) throw new Error(await parseError(summaryResponse))

      const [logsPayload, summaryPayload] = (await Promise.all([
        logsResponse.json(),
        summaryResponse.json(),
      ])) as [OperationAuditLogsResponse, OperationAuditLogsSummaryResponse]

      setRows(
        category === 'other'
          ? (logsPayload.items || []).filter((item) => getCategoryMeta(item.action).key === 'other')
          : logsPayload.items || []
      )
      setTotal(logsPayload.total || 0)
      setHasNext(Boolean(logsPayload.has_next))
      setSummary(summaryPayload)
    } catch (err) {
      notify({ type: 'error', title: '加载日志失败', message: normalizeErrorMessage(err, '加载日志失败') })
    } finally {
      setLoading(false)
    }
  }, [category, keyword, operator, page, session, status])

  useEffect(() => {
    void fetchLogs()
  }, [fetchLogs])

  const totalPages = useMemo(() => {
    if (total <= 0) return 1
    return Math.max(1, Math.ceil(total / pageSize))
  }, [total])

  const applyFilters = useCallback(() => {
    setPage(1)
    setKeyword(keywordInput.trim())
    setOperator(operatorInput.trim())
    setCategory(categoryInput)
  }, [categoryInput, keywordInput, operatorInput])

  const resetFilters = useCallback(() => {
    setKeywordInput('')
    setOperatorInput('')
    setCategoryInput('all')
    setPage(1)
    setKeyword('')
    setOperator('')
    setCategory('all')
  }, [])

  const summaryCards = useMemo(
    () => [
      {
        key: 'total',
        title: '全部日志',
        value: summary?.total ?? 0,
        detail: '当前筛选条件下的日志总量',
        icon: <Activity className="h-4 w-4" />,
        accent: 'from-slate-900/90 via-slate-700/80 to-slate-500/70 text-white',
      },
      {
        key: 'success',
        title: '成功反馈',
        value: summary?.success_count ?? 0,
        detail: '前端统一展示为中文成功状态',
        icon: <ShieldCheck className="h-4 w-4" />,
        accent: 'from-emerald-500 via-teal-500 to-cyan-500 text-white',
      },
      {
        key: 'failure',
        title: '失败反馈',
        value: summary?.failure_count ?? 0,
        detail: '便于快速筛查异常操作',
        icon: <Settings2 className="h-4 w-4" />,
        accent: 'from-rose-500 via-orange-500 to-amber-500 text-white',
      },
      {
        key: 'operators',
        title: '活跃操作人',
        value: summary?.unique_operator_count ?? 0,
        detail: '当前筛选条件下的去重人数',
        icon: <Users className="h-4 w-4" />,
        accent: 'from-indigo-500 via-sky-500 to-cyan-500 text-white',
      },
    ],
    [summary]
  )

  return (
    <div className="w-full space-y-6">
      <DataCard>
        <DataCardHeader
          title="统计概览"
          description="当前筛选条件下的日志统计"
        />
        <div className="px-6 py-5">
          <DataTableCardStatBar
            items={[
              { label: '日志总量', value: summary?.total ?? 0, highlight: true },
              { label: '成功', value: summary?.success_count ?? 0 },
              { label: '失败', value: summary?.failure_count ?? 0 },
              { label: '活跃操作人', value: summary?.unique_operator_count ?? 0 },
            ]}
          />
        </div>
      </DataCard>

      <DataTableCard>
        <DataCardHeader
          title="日志列表"
          action={
            <Button type="button" variant="outline" onClick={() => void fetchLogs()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {loading ? '刷新中...' : '刷新'}
            </Button>
          }
        />
        <DataTableCardBody>
          <div className="border border-white/45 bg-[hsl(var(--surface-subtle))] p-1.5 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[180px]">时间</TableHead>
                  <TableHead className="w-[120px]">操作人</TableHead>
                  <TableHead>分类 / 动作</TableHead>
                  <TableHead className="w-[140px]">资源类型</TableHead>
                  <TableHead className="w-[130px]">资源 ID</TableHead>
                  <TableHead className="w-[100px]">结果</TableHead>
                  <TableHead className="w-[100px] text-right">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  loading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        加载中...
                      </TableCell>
                    </TableRow>
                  ) : (
                    <EmptyTableState colSpan={7} message="暂无日志" />
                  )
                ) : (
                  rows.map((row) => {
                    const categoryMeta = getCategoryMeta(row.action)
                    const resultMeta = getResultMeta(row.result)

                    return (
                      <TableRow key={row.id}>
                        <TableCell>{formatDateTime(row.created_at)}</TableCell>
                        <TableCell>{row.operator || '-'}</TableCell>
                        <TableCell className="max-w-[420px]">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline" className={categoryMeta.className}>
                                {categoryMeta.label}
                              </Badge>
                              <span className="font-medium">{formatActionLabel(row.action)}</span>
                            </div>
                            <p className="truncate text-xs text-muted-foreground" title={row.action}>
                              {row.action}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>{formatTargetTypeLabel(row.target_type)}</TableCell>
                        <TableCell className="max-w-[130px] truncate" title={row.target_id || '-'}>
                          {row.target_id || '-'}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={resultMeta.className}>
                            {resultMeta.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => setActiveRow(row)}>
                            <Eye className="h-4 w-4" />
                            查看
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between px-4 py-3">
            <p className="text-sm text-muted-foreground">
              共 {total} 条，当前第 {page} / {totalPages} 页
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={page <= 1 || loading}>
                上一页
              </Button>
              <Button variant="outline" onClick={() => setPage((prev) => prev + 1)} disabled={!hasNext || loading}>
                下一页
              </Button>
            </div>
          </div>
        </DataTableCardBody>
      </DataTableCard>

      <Card className="dashboard-surface">
        <CardContent className="p-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Input
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              placeholder="关键词（动作/路径/资源ID/trace）"
            />
            <Input value={operatorInput} onChange={(event) => setOperatorInput(event.target.value)} placeholder="操作人" />
            <Select value={categoryInput} onValueChange={(value: CategoryKey) => setCategoryInput(value)}>
              <SelectTrigger>
                <SelectValue placeholder="日志分类" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部分类</SelectItem>
                {CATEGORY_OPTIONS.map((item) => (
                  <SelectItem key={item.key} value={item.key}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={applyFilters}>
                <Search className="h-4 w-4" />
                查询
              </Button>
              <Button type="button" variant="outline" onClick={resetFilters}>
                重置
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={Boolean(activeRow)} onOpenChange={(open) => (open ? null : setActiveRow(null))}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <DialogHeader>
            <DialogTitle>日志详情</DialogTitle>
          </DialogHeader>
          {activeRow ? (
            <div className="space-y-4 text-sm">
              <div className="grid gap-2 sm:grid-cols-2">
                <p>时间: {formatDateTime(activeRow.created_at)}</p>
                <p>操作人: {activeRow.operator || '-'}</p>
                <p>分类: {getCategoryMeta(activeRow.action).label}</p>
                <p>动作: {formatActionLabel(activeRow.action)}</p>
                <p>原始动作标识: {activeRow.action}</p>
                <p>结果: {getResultMeta(activeRow.result).label}</p>
                <p>资源类型: {formatTargetTypeLabel(activeRow.target_type)}</p>
                <p>资源 ID: {activeRow.target_id || '-'}</p>
                <p>请求: {activeRow.request_method || '-'} {activeRow.request_path || ''}</p>
                <p>Trace ID: {activeRow.trace_id || '-'}</p>
              </div>
              <div className="space-y-2">
                <p className="font-medium">变更前</p>
                <pre className="overflow-x-auto rounded-md border border-border/70 bg-muted/40 p-3 text-xs dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                  {renderJson(activeRow.before_json)}
                </pre>
              </div>
              <div className="space-y-2">
                <p className="font-medium">变更后 / 返回结果</p>
                <pre className="overflow-x-auto rounded-md border border-border/70 bg-muted/40 p-3 text-xs dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                  {renderJson(activeRow.after_json)}
                </pre>
              </div>
              {activeRow.error_message ? (
                <div className="space-y-2">
                  <p className="font-medium text-destructive">失败原因</p>
                  <pre className="overflow-x-auto rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive dark:border-destructive/30 dark:bg-destructive/12">
                    {activeRow.error_message}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
