'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { FilterX, Inbox, Loader2, Pencil, Play, Plus, Power, Sparkles, Trash2, X } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { FilterToolbar } from '@/components/ui/filter-toolbar'
import { useNotifications } from '@/components/notifications'
import { cn } from '@/lib/utils'
import { getCountryLabel, COUNTRY_OPTIONS } from '@/lib/country'
import { useConfirm } from '@/hooks/use-confirm'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useMobile } from '@/lib/hooks/use-mobile'
import type { Frequency, Subscription, AIModelConfig } from './types'
import { AiModelOptions } from './ai-model-options'
import {
  authHeaders,
  batchDeleteSubscriptions,
  batchPatchSubscriptions,
  deleteSubscription,
  fetchModelConfig,
  resolveApiUrl,
  resolveProjectNames,
  formatProjectNames,
  toggleSubscription,
  type BatchResult,
} from './api'
import { CreateSubscriptionDialog } from './CreateSubscriptionDialog'
import { EditSubscriptionDialog } from './EditSubscriptionDialog'
import { WarmFrequencyTag, WarmStatusPill } from './warm-shared'
import styles from '../scheduled-reports-warm.module.css'

const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}

/** 批量操作进行中的动作（同一时刻只允许一个，其余按钮进入禁用态） */
type BulkAction = 'model' | 'pause' | 'resume' | 'delete'

const WEEKDAY_CHARS = ['一', '二', '三', '四', '五', '六', '日']

/**
 * 发送时间文案：daily → `HH:MM`；weekly → `HH:MM 周X`；monthly → `HH:MM N日`。
 * 桌面表格与移动卡片共用，避免两端时间口径分叉。
 */
function formatDispatchText(sub: Subscription): string {
  const time = `${String(sub.dispatch_hour).padStart(2, '0')}:${String(sub.dispatch_minute).padStart(2, '0')}`
  if (sub.frequency === 'weekly') return `${time} 周${WEEKDAY_CHARS[sub.dispatch_weekday ?? 0]}`
  if (sub.frequency === 'monthly') return `${time} ${sub.dispatch_day ?? 2}日`
  return time
}

interface BulkBarProps {
  count: number
  modelConfig: AIModelConfig | null
  model: string
  onModelChange: (value: string) => void
  busy: BulkAction | null
  pauseDisabled: boolean
  resumeDisabled: boolean
  onApplyModel: () => void
  onPause: () => void
  onResume: () => void
  onDelete: () => void
  onClear: () => void
}

/**
 * 选择态命令条（BLF-1032）：选中 ≥1 行时出现，承载「批量改模型 / 暂停 / 启用 / 删除 / 清空」。
 * 桌面端嵌在面板工具栏内、移动端吸附在面板上方，两处复用同一实现（避免双份按钮逻辑漂移）。
 */
function BulkBar({
  count,
  modelConfig,
  model,
  onModelChange,
  busy,
  pauseDisabled,
  resumeDisabled,
  onApplyModel,
  onPause,
  onResume,
  onDelete,
  onClear,
}: BulkBarProps) {
  const idle = busy === null
  return (
    <div
      data-testid="subscriptions-bulk-bar"
      className={styles.bulkBar}
      role="group"
      aria-label="批量操作"
    >
      <span className={styles.bulkCount}>已选 {count} 条</span>
      <span aria-hidden className={styles.bulkDivider} />

      <Select value={model} onValueChange={onModelChange}>
        <SelectTrigger
          className={cn(styles.control, styles.bulkSelect)}
          aria-label="批量修改 AI 模型"
        >
          <SelectValue placeholder="选择 AI 模型" />
        </SelectTrigger>
        <SelectContent className={styles.selectContent}>
          <AiModelOptions config={modelConfig} />
        </SelectContent>
      </Select>
      <button
        type="button"
        onClick={onApplyModel}
        disabled={!model || !idle}
        className={styles.button}
        title="把所选订阅的 AI 模型统一改为上方模型"
      >
        {busy === 'model' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
        )}
        应用模型
      </button>

      <button
        type="button"
        onClick={onPause}
        disabled={pauseDisabled || !idle}
        className={styles.button}
        title="暂停所选订阅，不再生成与发送报告"
      >
        {busy === 'pause' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Power className="h-3.5 w-3.5" aria-hidden />
        )}
        暂停
      </button>
      <button
        type="button"
        onClick={onResume}
        disabled={resumeDisabled || !idle}
        className={styles.button}
        title="启用所选订阅，恢复定时生成与发送"
      >
        {busy === 'resume' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Play className="h-3.5 w-3.5" aria-hidden />
        )}
        启用
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={!idle}
        className={styles.buttonDanger}
        title="删除所选订阅（不可撤销）"
      >
        {busy === 'delete' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        )}
        删除
      </button>

      <button
        type="button"
        onClick={onClear}
        className={cn(styles.button, styles.bulkClear)}
        title="清空选择"
        aria-label="清空选择"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
        清空
      </button>
    </div>
  )
}

export default function SubscriptionsView({
  onRefreshReady,
}: {
  onRefreshReady?: (refresh: () => Promise<void>) => void
}) {
  const { data: session } = useSession()
  const { confirm } = useConfirm()
  const { notify } = useNotifications()

  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [loading, setLoading] = useState(true)
  const [projects, setProjects] = useState<Array<{ id?: number | null; name: string }>>([])
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editingSub, setEditingSub] = useState<Subscription | null>(null)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [filterFrequency, setFilterFrequency] = useState<string>('all')
  const [filterProject, setFilterProject] = useState<string>('all')
  const [filterEmail, setFilterEmail] = useState<string>('')
  const [filterCountry, setFilterCountry] = useState<string>('all')
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [modelConfig, setModelConfig] = useState<AIModelConfig | null>(null)
  const [isLoadingModelConfig, setIsLoadingModelConfig] = useState(false)
  const modelConfigRequested = useRef(false)

  // 多选 + 批量操作状态（BLF-1032）
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkModel, setBulkModel] = useState('')
  const [bulkBusy, setBulkBusy] = useState<BulkAction | null>(null)

  // BEL-422：模型配置只服务于新增/编辑弹窗的 AI 模型下拉，首次打开弹窗时才拉取，
  // 不再随页面 mount 无条件请求（削减首屏并发请求）。
  // BLF-1032：批量改模型的命令条也需要模型清单，故进入选择态时按需补齐同一次请求。
  const ensureModelConfig = useCallback(() => {
    if (modelConfigRequested.current) return
    modelConfigRequested.current = true
    setIsLoadingModelConfig(true)
    // 注意失败路径：fetchModelConfig 出错时不会回调 onConfig（只在控制台打日志并
    // 返回 null），所以复位哨兵 / 收尾 loading 必须挂在返回值上，不能只靠回调。
    void fetchModelConfig((cfg) => {
      setModelConfig(cfg)
    }).then((cfg) => {
      if (cfg) {
        setIsLoadingModelConfig(false)
      } else {
        // 请求失败：复位哨兵，下次进入选择态 / 打开弹窗可重试；同时收尾 loading，
        // 否则批量改模型的下拉会永久停在「加载模型中...」拿不到选项（review 修复 2）。
        modelConfigRequested.current = false
        setIsLoadingModelConfig(false)
      }
    })
  }, [])

  useEffect(() => {
    if (selectedIds.size > 0) ensureModelConfig()
  }, [selectedIds.size, ensureModelConfig])

  const refreshSubscriptions = useCallback(async () => {
    try {
      const [subRes, projectData] = await Promise.all([
        fetch(resolveApiUrl('/api/v1/scheduled-reports/subscriptions'), {
          headers: authHeaders(),
        }),
        fetchManagedProjectsCached<Array<{ id?: number | null; name: string }>>(session),
      ])
      if (!subRes.ok) {
        throw new Error(`订阅列表请求失败（HTTP ${subRes.status}）`)
      }
      const subs = await subRes.json()
      if (!Array.isArray(subs.items)) {
        throw new Error('订阅列表响应格式无效')
      }
      setSubscriptions(subs.items)
      setProjects(projectData.filter((p: { name: string }) => typeof p.name === 'string' && p.name.trim()))
    } catch (error) {
      notify({
        type: 'error',
        title: '订阅数据刷新失败',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }, [notify, session])

  useEffect(() => {
    onRefreshReady?.(refreshSubscriptions)
  }, [onRefreshReady, refreshSubscriptions])

  useEffect(() => {
    setLoading(true)
    void refreshSubscriptions().finally(() => setLoading(false))
  }, [refreshSubscriptions])

  // 过滤后的订阅列表
  const filteredSubscriptions = useMemo(
    () =>
      subscriptions.filter((sub) => {
        if (filterFrequency !== 'all' && sub.frequency !== filterFrequency) return false
        if (filterProject !== 'all') {
          const ids = sub.project_ids === '*' ? [] : sub.project_ids.split(',').map((id) => id.trim())
          if (!ids.includes(filterProject)) return false
        }
        if (filterEmail.trim() && !(sub.email || '').toLowerCase().includes(filterEmail.toLowerCase())) return false
        if (filterCountry !== 'all') {
          const subCountries = sub.country.split(',').map((c) => c.trim().toUpperCase())
          if (!subCountries.includes(filterCountry.toUpperCase())) return false
        }
        if (filterStatus !== 'all') {
          const isEnabled = sub.enabled
          if (filterStatus === 'enabled' && !isEnabled) return false
          if (filterStatus === 'disabled' && isEnabled) return false
        }
        return true
      }),
    [subscriptions, filterFrequency, filterProject, filterEmail, filterCountry, filterStatus],
  )

  // 已删除的订阅不该留在选择集里（否则命令条计数虚高、批量请求打到已不存在的行）
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const alive = new Set(subscriptions.map((s) => s.id))
      const next = new Set([...prev].filter((id) => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [subscriptions])

  const selectedSubs = useMemo(() => subscriptions.filter((s) => selectedIds.has(s.id)), [subscriptions, selectedIds])
  const selectedInFiltered = useMemo(
    () => filteredSubscriptions.filter((s) => selectedIds.has(s.id)).length,
    [filteredSubscriptions, selectedIds],
  )
  const allFilteredSelected = filteredSubscriptions.length > 0 && selectedInFiltered === filteredSubscriptions.length
  const selectedEnabledCount = selectedSubs.filter((s) => s.enabled).length

  const toggleRowSelected = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const toggleAllFiltered = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      filteredSubscriptions.forEach((s) => (checked ? next.add(s.id) : next.delete(s.id)))
      return next
    })
  }

  const resetFilters = () => {
    setFilterFrequency('all')
    setFilterProject('all')
    setFilterCountry('all')
    setFilterStatus('all')
    setFilterEmail('')
  }

  /**
   * 批量结果回执：全成功 → success；部分失败 → warning（其余行已生效，不能报 error）；
   * 全失败 → error。全部成功才清空选择，否则保留失败行以便重试。
   */
  const reportBatch = useCallback(
    (title: string, okCount: number, failed: BatchResult['failed']) => {
      if (failed.length === 0) {
        notify({ type: 'success', title, message: `共 ${okCount} 条` })
        setSelectedIds(new Set())
        return
      }
      if (okCount === 0) {
        notify({
          type: 'error',
          title: `${title}失败`,
          message: `${failed.length} 条全部失败：${failed[0]!.error}`,
        })
        return
      }
      notify({
        type: 'warning',
        title: `${title}：${okCount} 条成功 / ${failed.length} 条失败`,
        message: failed[0]!.error,
      })
    },
    [notify],
  )

  const handleEdit = (sub: Subscription) => {
    ensureModelConfig()
    setEditingSub(sub)
    setShowEditDialog(true)
  }

  const handleOpenCreateDialog = () => {
    ensureModelConfig()
    setShowCreateDialog(true)
  }

  const handleDelete = async (id: number) => {
    if (!(await confirm({ title: '确定删除此订阅？', variant: 'destructive' }))) return
    const ok = await deleteSubscription(id)
    if (ok) {
      setSubscriptions((prev) => prev.filter((s) => s.id !== id))
    }
  }

  const handleToggle = async (sub: Subscription) => {
    const result = await toggleSubscription(sub.id, !sub.enabled)
    if (result.ok) {
      setSubscriptions((prev) => prev.map((s) => (s.id === sub.id ? { ...s, enabled: !s.enabled } : s)))
    }
  }

  const handleBulkApplyModel = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0 || !bulkModel) return
    setBulkBusy('model')
    try {
      const { okIds, failed } = await batchPatchSubscriptions(ids, {
        ai_model: bulkModel,
      })
      if (okIds.length > 0) {
        const done = new Set(okIds)
        setSubscriptions((prev) => prev.map((s) => (done.has(s.id) ? { ...s, ai_model: bulkModel } : s)))
      }
      reportBatch(`已把模型改为 ${bulkModel}`, okIds.length, failed)
    } finally {
      setBulkBusy(null)
    }
  }

  const handleBulkToggle = async (enabled: boolean) => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    setBulkBusy(enabled ? 'resume' : 'pause')
    try {
      const { okIds, failed } = await batchPatchSubscriptions(ids, { enabled })
      if (okIds.length > 0) {
        const done = new Set(okIds)
        setSubscriptions((prev) => prev.map((s) => (done.has(s.id) ? { ...s, enabled } : s)))
      }
      reportBatch(enabled ? '已启用' : '已暂停', okIds.length, failed)
    } finally {
      setBulkBusy(null)
    }
  }

  const handleBulkDelete = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const ok = await confirm({
      title: `删除选中的 ${ids.length} 条订阅？`,
      description: '删除后这些订阅不再生成与发送报告，且不可恢复。',
      confirmText: '删除',
      variant: 'destructive',
      inputLabel: `请输入 DELETE 确认删除 ${ids.length} 条订阅`,
      expectedInput: 'DELETE',
    })
    if (!ok) return
    setBulkBusy('delete')
    try {
      const { okIds, failed } = await batchDeleteSubscriptions(ids)
      if (okIds.length > 0) {
        const done = new Set(okIds)
        setSubscriptions((prev) => prev.filter((s) => !done.has(s.id)))
      }
      reportBatch('已删除', okIds.length, failed)
    } finally {
      setBulkBusy(null)
    }
  }

  const roleType = session?.user?.roleType
  const canManage = roleType === 'admin' || roleType === 'operator'
  // 视口断点（SSR 安全）：仅用于筛选器的手机短标签文案（BLF-617 移动契约）
  const isMobile = useMobile()

  const bulkBar = (
    <BulkBar
      count={selectedSubs.length}
      modelConfig={modelConfig}
      model={bulkModel}
      onModelChange={setBulkModel}
      busy={bulkBusy}
      pauseDisabled={selectedEnabledCount === 0}
      resumeDisabled={selectedEnabledCount === selectedSubs.length}
      onApplyModel={handleBulkApplyModel}
      onPause={() => handleBulkToggle(false)}
      onResume={() => handleBulkToggle(true)}
      onDelete={handleBulkDelete}
      onClear={() => setSelectedIds(new Set())}
    />
  )

  if (loading) {
    return (
      <section
        className={styles.panel}
        aria-label="订阅管理"
        aria-busy="true"
        data-warm-scheduled-subscriptions="true"
      >
        <header className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>订阅管理</h2>
        </header>
        <div className="grid gap-3 p-4">
          <Skeleton className="h-10 w-full rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-panel-strong)]" />
          <Skeleton className="h-10 w-full rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-panel-strong)]" />
          <Skeleton className="h-10 w-full rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-panel-strong)]" />
          <Skeleton className="h-10 w-3/4 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-panel-strong)]" />
        </div>
      </section>
    )
  }

  return (
    <div
      className={styles.stack}
      data-warm-scheduled-subscriptions="true"
    >
      {/* 移动端：选择态命令条吸附在面板上方（工具区在手机上已被筛选器占满，
          就地插入会把筛选器推下屏外）。 */}
      {canManage && selectedSubs.length > 0 && (
        <div className="sticky top-0 z-20 border border-[color:var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] p-1.5 md:hidden">{bulkBar}</div>
      )}

      <section className={styles.panel} aria-label="订阅管理">
        <header className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>订阅管理</h2>
          <div className={styles.panelActions}>
            <span className={styles.count}>
              {filteredSubscriptions.length === subscriptions.length
                ? `${subscriptions.length} 条`
                : `${filteredSubscriptions.length} / ${subscriptions.length} 条`}
            </span>
            {canManage ? (
              <button type="button" onClick={handleOpenCreateDialog} className={styles.button}>
                <Plus aria-hidden />
                新增订阅
              </button>
            ) : null}
          </div>
        </header>
        {/* 筛选器（BLF-1032）：桌面 flex-wrap / 手机 2 列网格统一由 FilterToolbar 承担，
            不再维护桌面 + 手机两份重复的 Select 组合。 */}
        <FilterToolbar className={styles.filterToolbar}>
          <Select value={filterFrequency} onValueChange={setFilterFrequency}>
            <SelectTrigger className={cn(styles.control, 'md:w-[110px]')}>
              <SelectValue placeholder="频率" />
            </SelectTrigger>
            <SelectContent className={styles.selectContent}>
              {/* 手机端短标签「全部」（BLF-617 移动契约）；桌面保持「全部频率」。
                  用 JS 断点而不是 md:hidden 双 span：SelectValue 会把选项内容克隆进
                  触发器，双 span 的 textContent 会拼成「全部全部频率」，破坏既有移动
                  smoke 对 /^全部$/ 的文本匹配（review 修复 1）。 */}
              <SelectItem value="all" className={styles.selectItem}>
                {isMobile ? '全部' : '全部频率'}
              </SelectItem>
              <SelectItem value="daily" className={styles.selectItem}>
                每日
              </SelectItem>
              <SelectItem value="weekly" className={styles.selectItem}>
                每周
              </SelectItem>
              <SelectItem value="monthly" className={styles.selectItem}>
                每月
              </SelectItem>
            </SelectContent>
          </Select>
          <Select value={filterProject} onValueChange={setFilterProject}>
            <SelectTrigger className={cn(styles.control, 'md:w-[150px]')}>
              <SelectValue placeholder="项目" />
            </SelectTrigger>
            <SelectContent className={styles.selectContent}>
              <SelectItem value="all" className={styles.selectItem}>
                全部项目
              </SelectItem>
              {projects.map((p) => (
                <SelectItem
                  key={p.id?.toString() || p.name}
                  value={p.id?.toString() || ''}
                  className={styles.selectItem}
                >
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterCountry} onValueChange={setFilterCountry}>
            <SelectTrigger className={cn(styles.control, 'md:w-[110px]')}>
              <SelectValue placeholder="国家" />
            </SelectTrigger>
            <SelectContent className={styles.selectContent}>
              <SelectItem value="all" className={styles.selectItem}>
                全部国家
              </SelectItem>
              {COUNTRY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className={styles.selectItem}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className={cn(styles.control, 'md:w-[110px]')}>
              <SelectValue placeholder="状态" />
            </SelectTrigger>
            <SelectContent className={styles.selectContent}>
              <SelectItem value="all" className={styles.selectItem}>
                全部状态
              </SelectItem>
              <SelectItem value="enabled" className={styles.selectItem}>
                启用
              </SelectItem>
              <SelectItem value="disabled" className={styles.selectItem}>
                已暂停
              </SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="筛选邮箱"
            value={filterEmail}
            onChange={(e) => setFilterEmail(e.target.value)}
            className={cn(styles.input, 'col-span-2 md:col-span-1 md:w-[180px]')}
          />
        </FilterToolbar>

        {/* 选择态命令条（桌面端）：紧贴表格上方 —— 出现/消失不会推动筛选器位置 */}
        {canManage && selectedSubs.length > 0 && (
          <div className="hidden border-b border-[color:var(--warm-ledger-color-hairline)] p-1.5 md:block">{bulkBar}</div>
        )}

        {/* 订阅列表 */}
        {subscriptions.length === 0 ? (
          <div className={styles.emptyState}>
            <Inbox className={styles.emptyIcon} aria-hidden />
            <p className={styles.emptyTitle}>暂无订阅配置</p>
            <p className={styles.emptyText}>
              {canManage ? '点击右上角「新增订阅」创建第一个配置' : '暂无可用订阅配置'}
            </p>
          </div>
        ) : filteredSubscriptions.length === 0 ? (
          <div className={styles.emptyState}>
            <FilterX className={styles.emptyIcon} aria-hidden />
            <p className={styles.emptyTitle}>没有符合筛选条件的订阅</p>
            <p className={styles.emptyText}>
              共 {subscriptions.length} 条订阅，当前筛选结果为空
            </p>
            <button type="button" onClick={resetFilters} className={styles.button}>
              <X aria-hidden />
              清空筛选条件
            </button>
          </div>
        ) : (
          <>
            <div
              className={cn('hidden md:block', styles.tableScroller)}
              data-scheduled-subscriptions-table-scroll="true"
            >
              <table className={styles.table} aria-label="订阅列表">
                <thead>
                  <tr>
                    <th scope="col" className="w-10">
                      {canManage ? (
                        <Checkbox
                          checked={
                            allFilteredSelected
                              ? true
                              : selectedInFiltered > 0
                                ? 'indeterminate'
                                : false
                          }
                          onCheckedChange={(checked) => toggleAllFiltered(checked === true)}
                          aria-label={
                            allFilteredSelected
                              ? '取消全选筛选结果'
                              : `全选筛选结果（${filteredSubscriptions.length} 条）`
                          }
                          className={styles.checkbox}
                        />
                      ) : null}
                    </th>
                    <th scope="col">项目</th>
                    <th scope="col">国家</th>
                    <th scope="col">频率</th>
                    <th scope="col">发送时间</th>
                    <th scope="col">邮箱</th>
                    <th scope="col">状态</th>
                    <th scope="col">AI 模型</th>
                    <th scope="col" className={styles.actionsCell}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSubscriptions.map((sub) => {
                    const names = resolveProjectNames(sub.project_ids, projects)
                    const { display, full } = formatProjectNames(names)
                    const selected = selectedIds.has(sub.id)
                    const rowLabel = `${display} · ${sub.email || '未填写邮箱'}`
                    return (
                      <tr
                        key={sub.id}
                        className={cn(selected && styles.selectedRow)}
                        aria-label={`订阅 ${rowLabel} · ${formatDispatchText(sub)}`}
                      >
                        <td>
                          {canManage ? (
                            <Checkbox
                              checked={selected}
                              onCheckedChange={(checked) =>
                                toggleRowSelected(sub.id, checked === true)
                              }
                              aria-label={`选中订阅 ${rowLabel}`}
                              className={styles.checkbox}
                            />
                          ) : null}
                        </td>
                        <td title={full} className={styles.truncateCell}>
                          {display}
                        </td>
                        <td className={styles.mutedCell}>
                          {sub.country
                            .split(',')
                            .map((c) => c.trim())
                            .filter(Boolean)
                            .map(getCountryLabel)
                            .join(' · ')}
                        </td>
                        <td>
                          <WarmFrequencyTag
                            frequency={sub.frequency}
                            labels={FREQUENCY_LABELS}
                          />
                        </td>
                        <td className={cn(styles.mutedCell, styles.numeric)}>
                          {formatDispatchText(sub)}
                        </td>
                        <td
                          title={sub.email || ''}
                          className={cn(styles.mutedCell, styles.truncateCell)}
                        >
                          {sub.email || '未填写'}
                        </td>
                        <td>
                          {sub.enabled ? (
                            <WarmStatusPill status="sent" label="启用" />
                          ) : (
                            <span className={styles.mutedCell}>已暂停</span>
                          )}
                        </td>
                        <td
                          className={cn(
                            styles.mutedCell,
                            styles.truncateCell,
                            styles.modelCell
                          )}
                        >
                          {sub.ai_model || '—'}
                        </td>
                        <td className={styles.actionsCell}>
                          {canManage ? (
                            <div className={styles.actionGroup}>
                              <button
                                type="button"
                                onClick={() => handleToggle(sub)}
                                title={sub.enabled ? '暂停' : '启用'}
                                aria-label={sub.enabled ? '暂停' : '启用'}
                                className={styles.iconButton}
                              >
                                <Power aria-hidden />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleEdit(sub)}
                                title="编辑"
                                aria-label="编辑订阅"
                                className={styles.iconButton}
                              >
                                <Pencil aria-hidden />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(sub.id)}
                                title="删除"
                                aria-label="删除订阅"
                                className={cn(styles.iconButton, styles.buttonDanger)}
                              >
                                <Trash2 aria-hidden />
                              </button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className={cn('md:hidden', styles.mobileList)}>
              {filteredSubscriptions.map((sub) => {
                const names = resolveProjectNames(sub.project_ids, projects)
                const { display, full } = formatProjectNames(names)
                const selected = selectedIds.has(sub.id)
                const rowLabel = `${display} · ${sub.email || '未填写邮箱'}`
                return (
                  <div
                    key={sub.id}
                    className={cn(
                      styles.mobileCard,
                      selected && styles.mobileCardSelected
                    )}
                  >
                    <div className={styles.mobileHeader}>
                      <div className={styles.mobileIdentity}>
                        {canManage ? (
                          <Checkbox
                            checked={selected}
                            onCheckedChange={(checked) =>
                              toggleRowSelected(sub.id, checked === true)
                            }
                            aria-label={`选中订阅 ${rowLabel}`}
                            className={styles.checkbox}
                          />
                        ) : null}
                        <div className="min-w-0">
                          <div className={styles.mobileTitle} title={full}>
                            {display}
                          </div>
                          <div className={styles.mobileMeta}>
                            {formatDispatchText(sub)}
                          </div>
                        </div>
                      </div>
                      <div className={styles.mobileBadges}>
                        <WarmFrequencyTag
                          frequency={sub.frequency}
                          labels={FREQUENCY_LABELS}
                        />
                        {sub.enabled ? (
                          <WarmStatusPill status="sent" label="启用" />
                        ) : (
                          <span className={styles.mutedCell}>已暂停</span>
                        )}
                      </div>
                    </div>
                    <div className={styles.mobileMeta}>
                      {sub.country
                        .split(',')
                        .map((c) => c.trim())
                        .filter(Boolean)
                        .map(getCountryLabel)
                        .join(' · ')}
                    </div>
                    <div className={cn(styles.mobileMeta, 'truncate')} title={sub.email || ''}>
                      {sub.email || '未填写邮箱'}
                    </div>
                    {sub.ai_model ? (
                          <div className={cn(styles.mobileMeta, styles.modelCell)}>
                            AI: {sub.ai_model}
                          </div>
                    ) : null}
                    {canManage ? (
                      <div className={styles.mobileActions}>
                        <button
                          type="button"
                          onClick={() => handleToggle(sub)}
                          className={styles.button}
                        >
                          <Power aria-hidden />
                          {sub.enabled ? '暂停' : '启用'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleEdit(sub)}
                          className={styles.button}
                        >
                          <Pencil aria-hidden />
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(sub.id)}
                          className={styles.buttonDanger}
                        >
                          <Trash2 aria-hidden />
                          删除
                        </button>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </section>

      <CreateSubscriptionDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        projects={projects}
        modelConfig={modelConfig}
        isLoadingModelConfig={isLoadingModelConfig}
        onSuccess={refreshSubscriptions}
      />

      <EditSubscriptionDialog
        subscription={editingSub}
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        projects={projects}
        modelConfig={modelConfig}
        isLoadingModelConfig={isLoadingModelConfig}
        onSuccess={refreshSubscriptions}
      />
    </div>
  )
}
