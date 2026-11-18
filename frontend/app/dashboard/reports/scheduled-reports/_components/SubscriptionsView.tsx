'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import {
  AlertCircle,
  FilterX,
  Inbox,
  Loader2,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { FilterToolbar } from '@/components/ui/filter-toolbar'
import {
  WarmButton,
  WarmSegmentedControl,
  WarmSelect,
  type WarmSelectOption,
} from '@/components/dashboard-v2/warm-ledger/controls/warm-controls'
import { useNotifications } from '@/components/notifications'
import { cn } from '@/lib/utils'
import { getCountryLabel, COUNTRY_OPTIONS } from '@/lib/country'
import { useConfirm } from '@/hooks/use-confirm'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useMobile } from '@/lib/hooks/use-mobile'
import type { Frequency, Subscription, AIModelConfig } from './types'
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
import { emailDisplayLabel } from './ledger-constants'
import styles from './subscriptions-warm.module.css'

const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}

const WEEKDAY_CHARS = ['一', '二', '三', '四', '五', '六', '日']

type StatusFilter = 'all' | 'enabled' | 'disabled' | 'generateOnly'

const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '启用' },
  { value: 'disabled', label: '已暂停' },
  { value: 'generateOnly', label: '仅生成' },
]

/** 批量操作进行中的动作（同一时刻只允许一个，其余按钮进入禁用态） */
type BulkAction = 'model' | 'pause' | 'resume' | 'delete'

/** 发送时间大字：`HH:MM`，表格与手机卡片共用。 */
function formatTime(sub: Subscription): string {
  return `${String(sub.dispatch_hour).padStart(2, '0')}:${String(
    sub.dispatch_minute ?? 0
  ).padStart(2, '0')}`
}

/** 频率副文案：`每日` / `每周 · 周二` / `每月 · 2 日`。 */
function formatFrequencyDetail(sub: Subscription): string {
  if (sub.frequency === 'weekly') {
    return `${FREQUENCY_LABELS.weekly} · 周${WEEKDAY_CHARS[sub.dispatch_weekday ?? 0]}`
  }
  if (sub.frequency === 'monthly') {
    return `${FREQUENCY_LABELS.monthly} · ${sub.dispatch_day ?? 2} 日`
  }
  return FREQUENCY_LABELS.daily
}

/** 站点副文案：最多展示两个站点，其余折叠为 `+N`；title 保留完整列表。 */
function formatCountrySummary(country: string): { display: string; full: string } {
  const labels = country
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean)
    .map(getCountryLabel)
  if (labels.length === 0) return { display: '—', full: '—' }
  return {
    display:
      labels.length > 2 ? `${labels.slice(0, 2).join(' · ')} +${labels.length - 2}` : labels.join(' · '),
    full: labels.join(' · '),
  }
}

/** 项目名用 ` · ` 分隔，与 Warm Ledger 账本式排版一致。 */
function formatProjectDisplay(projectIds: string, projects: Array<{ id?: number | null; name: string }>) {
  const { display, full } = formatProjectNames(resolveProjectNames(projectIds, projects))
  return { display: display.replace(/, /g, ' · '), full }
}

/** premium → basic → others 压平为 WarmSelect 选项（保留原顺序，不分组）。 */
function flattenModelOptions(
  config: AIModelConfig | null,
  currentModel = ''
): WarmSelectOption[] {
  const models = config?.models ?? []
  const premium = config?.premiumModels ?? []
  const basic = config?.basicModels ?? []
  const others = models.filter((model) => !premium.includes(model) && !basic.includes(model))
  const seen = new Set<string>()
  const options: WarmSelectOption[] = []
  for (const model of [...premium, ...basic, ...others]) {
    if (!model || seen.has(model)) continue
    seen.add(model)
    options.push({ value: model, label: model })
  }
  if (currentModel && !seen.has(currentModel)) {
    options.push({ value: currentModel, label: currentModel })
  }
  return options
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
 * 桌面嵌在面板工具栏下方，手机吸附在面板上方，两处复用同一实现。
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
  const modelOptions = flattenModelOptions(modelConfig, model)

  return (
    <div
      data-testid="subscriptions-bulk-bar"
      className={styles.bulkBar}
      role="group"
      aria-label="批量操作"
    >
      <span className={styles.bulkCount}>已选 {count} 条</span>
      <span aria-hidden className={styles.bulkDivider} />

      <WarmSelect
        id="subscriptions-bulk-model"
        hideLabel
        ariaLabel="批量修改 AI 模型"
        value={model}
        options={modelOptions}
        onChange={onModelChange}
        placeholder="选择 AI 模型"
        disabled={modelOptions.length === 0}
        className={styles.bulkField}
      />
      <button
        type="button"
        onClick={onApplyModel}
        disabled={!model || !idle}
        className={styles.bulkAction}
        title="把所选订阅的 AI 模型统一改为上方模型"
      >
        {busy === 'model' ? <Loader2 className={styles.spinner} aria-hidden /> : null}
        应用模型
      </button>

      <button
        type="button"
        onClick={onPause}
        disabled={pauseDisabled || !idle}
        className={styles.bulkAction}
        title="暂停所选订阅，不再生成与发送报告"
      >
        {busy === 'pause' ? <Loader2 className={styles.spinner} aria-hidden /> : null}
        暂停
      </button>
      <button
        type="button"
        onClick={onResume}
        disabled={resumeDisabled || !idle}
        className={styles.bulkAction}
        title="启用所选订阅，恢复定时生成与发送"
      >
        {busy === 'resume' ? <Loader2 className={styles.spinner} aria-hidden /> : null}
        启用
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={!idle}
        className={cn(styles.bulkAction, styles.bulkDanger)}
        title="删除所选订阅（不可撤销）"
      >
        {busy === 'delete' ? <Loader2 className={styles.spinner} aria-hidden /> : null}
        删除
      </button>

      <button
        type="button"
        onClick={onClear}
        className={cn(styles.bulkAction, styles.bulkClear)}
        title="清空选择"
        aria-label="清空选择"
      >
        清空选择
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
  // 列表请求失败且从未成功加载过时必须显示错误态，而不是空态 —— 否则接口故障
  // 会伪装成「暂无订阅配置」，和真的没有订阅无法区分（BLF-1556）。
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadedOnceRef = useRef(false)
  const [projects, setProjects] = useState<Array<{ id?: number | null; name: string }>>([])
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [editingSub, setEditingSub] = useState<Subscription | null>(null)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [filterFrequency, setFilterFrequency] = useState<string>('all')
  const [filterProject, setFilterProject] = useState<string>('all')
  const [filterEmail, setFilterEmail] = useState<string>('')
  const [filterCountry, setFilterCountry] = useState<string>('all')
  const [filterStatus, setFilterStatus] = useState<StatusFilter>('all')
  const [modelConfig, setModelConfig] = useState<AIModelConfig | null>(null)
  const [isLoadingModelConfig, setIsLoadingModelConfig] = useState(false)
  const modelConfigRequested = useRef(false)

  // 多选 + 批量操作状态（BLF-1032）
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkModel, setBulkModel] = useState('')
  const [bulkBusy, setBulkBusy] = useState<BulkAction | null>(null)

  // BEL-422：模型配置只服务于新增/编辑弹窗与批量改模型的 AI 模型下拉，
  // 首次交互/打开弹窗时才拉取，不随页面 mount 无条件请求。
  const ensureModelConfig = useCallback(() => {
    if (modelConfigRequested.current) return
    modelConfigRequested.current = true
    setIsLoadingModelConfig(true)
    void fetchModelConfig((cfg) => {
      setModelConfig(cfg)
    }).then((cfg) => {
      if (cfg) {
        setIsLoadingModelConfig(false)
      } else {
        // 请求失败：复位哨兵，下次进入选择态 / 打开弹窗可重试。
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
        // 项目清单只用于把 project_ids 解析成名称；它失败时订阅列表仍可读，
        // 不能因此把整个列表判成加载失败（名称退化为「项目ID」）。
        fetchManagedProjectsCached<Array<{ id?: number | null; name: string }>>(session).catch(
          () => [] as Array<{ id?: number | null; name: string }>
        ),
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
      loadedOnceRef.current = true
      setLoadError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!loadedOnceRef.current) {
        setLoadError(message)
        return
      }
      // 已有列表时保留旧数据，用通知提示本次刷新失败。
      notify({ type: 'error', title: '订阅数据刷新失败', message })
    }
  }, [notify, session])

  useEffect(() => {
    onRefreshReady?.(refreshSubscriptions)
  }, [onRefreshReady, refreshSubscriptions])

  useEffect(() => {
    setLoading(true)
    void refreshSubscriptions().finally(() => setLoading(false))
  }, [refreshSubscriptions])

  const handleRetryLoad = () => {
    setLoading(true)
    void refreshSubscriptions().finally(() => setLoading(false))
  }

  // 过滤后的订阅列表（筛选语义与原页面保持一致，新增「仅生成」= 无邮箱）。
  const filteredSubscriptions = useMemo(
    () =>
      subscriptions.filter((sub) => {
        if (filterFrequency !== 'all' && sub.frequency !== filterFrequency) return false
        if (filterProject !== 'all') {
          const ids = sub.project_ids === '*' ? [] : sub.project_ids.split(',').map((id) => id.trim())
          if (!ids.includes(filterProject)) return false
        }
        if (filterEmail.trim() && !(sub.email || '').toLowerCase().includes(filterEmail.toLowerCase()))
          return false
        if (filterCountry !== 'all') {
          const subCountries = sub.country.split(',').map((c) => c.trim().toUpperCase())
          if (!subCountries.includes(filterCountry.toUpperCase())) return false
        }
        if (filterStatus === 'enabled' && !sub.enabled) return false
        if (filterStatus === 'disabled' && sub.enabled) return false
        if (filterStatus === 'generateOnly' && (sub.email || '').trim()) return false
        return true
      }),
    [subscriptions, filterFrequency, filterProject, filterEmail, filterCountry, filterStatus],
  )

  // 已删除的订阅不该留在选择集里。
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const alive = new Set(subscriptions.map((s) => s.id))
      const next = new Set([...prev].filter((id) => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [subscriptions])

  const selectedSubs = useMemo(
    () => subscriptions.filter((s) => selectedIds.has(s.id)),
    [subscriptions, selectedIds]
  )
  const selectedInFiltered = useMemo(
    () => filteredSubscriptions.filter((s) => selectedIds.has(s.id)).length,
    [filteredSubscriptions, selectedIds]
  )
  const allFilteredSelected =
    filteredSubscriptions.length > 0 && selectedInFiltered === filteredSubscriptions.length
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

  const filtersActive =
    filterFrequency !== 'all' ||
    filterProject !== 'all' ||
    filterCountry !== 'all' ||
    filterStatus !== 'all' ||
    filterEmail.trim() !== ''

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
    const result = await deleteSubscription(id)
    if (result.ok) {
      setSubscriptions((prev) => prev.filter((s) => s.id !== id))
      return
    }
    notify({
      type: 'error',
      title: '删除订阅失败',
      message: result.error || '请稍后重试',
    })
  }

  const handleToggle = async (sub: Subscription) => {
    const result = await toggleSubscription(sub.id, !sub.enabled)
    if (result.ok) {
      setSubscriptions((prev) => prev.map((s) => (s.id === sub.id ? { ...s, enabled: !s.enabled } : s)))
      return
    }
    notify({
      type: 'error',
      title: sub.enabled ? '暂停订阅失败' : '启用订阅失败',
      message: result.error || '请稍后重试',
    })
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

  const frequencyFilterOptions = useMemo<WarmSelectOption[]>(
    () => [
      { value: 'all', label: isMobile ? '全部' : '全部频率' },
      { value: 'daily', label: '每日' },
      { value: 'weekly', label: '每周' },
      { value: 'monthly', label: '每月' },
    ],
    [isMobile]
  )

  const countryFilterOptions = useMemo<WarmSelectOption[]>(
    () => [
      { value: 'all', label: isMobile ? '全部' : '全部国家' },
      ...COUNTRY_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    ],
    [isMobile]
  )

  const projectFilterOptions = useMemo<WarmSelectOption[]>(
    () => [
      { value: 'all', label: isMobile ? '全部' : '全部项目' },
      ...projects
        .filter((project) => project.id != null)
        .map((project) => ({ value: String(project.id), label: project.name })),
    ],
    [isMobile, projects]
  )

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
        <div className={styles.loadState} role="status">
          <p className={styles.loadLabel}>
            <Loader2 className={styles.spinner} aria-hidden />
            正在加载订阅配置
          </p>
          <div className={styles.skeletonStack} aria-hidden>
            {[0, 1, 2, 3].map((row) => (
              <div
                key={row}
                className={styles.skeletonRow}
                style={{ width: row === 3 ? '75%' : '100%' }}
              />
            ))}
          </div>
        </div>
      </section>
    )
  }

  return (
    <div className={styles.stack} data-warm-scheduled-subscriptions="true">
      {/* 移动端：选择态命令条吸附在面板上方（工具区在手机上已被筛选器占满）。 */}
      {canManage && selectedSubs.length > 0 && (
        <div className={cn('sticky top-0 z-20 md:hidden', styles.mobileBulk)}>{bulkBar}</div>
      )}

      <section className={styles.panel} aria-label="订阅管理">
        <header className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>订阅管理</h2>
          <div className={styles.panelMeta}>
            <span className={styles.count}>
              {filteredSubscriptions.length === subscriptions.length
                ? `共 ${subscriptions.length} 条`
                : `${filteredSubscriptions.length} / ${subscriptions.length} 条`}
            </span>
            {canManage ? (
              <WarmButton variant="primary" onClick={handleOpenCreateDialog}>
                <Plus aria-hidden />
                新增订阅
              </WarmButton>
            ) : null}
          </div>
        </header>

        <FilterToolbar
          className={styles.filterToolbar}
          actions={
            <button
              type="button"
              onClick={resetFilters}
              disabled={!filtersActive}
              className={styles.resetButton}
            >
              重置筛选
            </button>
          }
        >
          <div className={styles.statusWrap}>
            <WarmSegmentedControl
              value={filterStatus}
              options={STATUS_FILTER_OPTIONS}
              onChange={(value) => setFilterStatus(value)}
              ariaLabel="启用状态筛选"
              className={styles.statusFilter}
            />
          </div>
          <WarmSelect
            id="subscriptions-filter-frequency"
            hideLabel
            ariaLabel="按频率筛选"
            value={filterFrequency}
            options={frequencyFilterOptions}
            onChange={setFilterFrequency}
            className={styles.filterField}
          />
          <WarmSelect
            id="subscriptions-filter-country"
            hideLabel
            ariaLabel="按国家筛选"
            value={filterCountry}
            options={countryFilterOptions}
            onChange={setFilterCountry}
            className={styles.filterFieldCountry}
          />
          <WarmSelect
            id="subscriptions-filter-project"
            hideLabel
            ariaLabel="按项目筛选"
            value={filterProject}
            options={projectFilterOptions}
            onChange={setFilterProject}
            className={cn(styles.filterField, styles.filterFieldWide)}
          />
          <div className={cn(styles.searchField, 'col-span-2 md:col-span-1')}>
            <Search className={styles.searchIcon} aria-hidden />
            <input
              className={styles.searchInput}
              type="text"
              placeholder="筛选邮箱"
              aria-label="按邮箱筛选订阅"
              value={filterEmail}
              onChange={(event) => setFilterEmail(event.target.value)}
            />
          </div>
        </FilterToolbar>

        {/* 选择态命令条（桌面端）：紧贴表格上方。 */}
        {canManage && selectedSubs.length > 0 && (
          <div className="hidden md:block">{bulkBar}</div>
        )}

        {loadError ? (
          <div className={styles.state} role="alert">
            <AlertCircle
              className={cn(styles.stateIcon, styles.stateIconNegative)}
              aria-hidden
            />
            <p className={styles.stateTitle}>订阅列表加载失败</p>
            <p className={styles.stateText}>{loadError}</p>
            <div className={styles.stateActions}>
              <button type="button" onClick={handleRetryLoad} className={styles.stateAction}>
                <RotateCcw aria-hidden />
                重试
              </button>
            </div>
          </div>
        ) : subscriptions.length === 0 ? (
          <div className={styles.state}>
            <Inbox className={styles.stateIcon} aria-hidden />
            <p className={styles.stateTitle}>暂无订阅配置</p>
            <p className={styles.stateText}>
              {canManage ? '点击「新增订阅」创建第一个配置' : '暂无可用订阅配置'}
            </p>
            {canManage ? (
              <div className={styles.stateActions}>
                <button
                  type="button"
                  onClick={handleOpenCreateDialog}
                  className={cn(styles.stateAction, styles.stateActionPrimary)}
                >
                  <Plus aria-hidden />
                  新增订阅
                </button>
              </div>
            ) : null}
          </div>
        ) : filteredSubscriptions.length === 0 ? (
          <div className={styles.state}>
            <FilterX className={styles.stateIcon} aria-hidden />
            <p className={styles.stateTitle}>没有符合筛选条件的订阅</p>
            <p className={styles.stateText}>
              共 {subscriptions.length} 条订阅，当前筛选结果为空
            </p>
            <div className={styles.stateActions}>
              <button type="button" onClick={resetFilters} className={styles.stateAction}>
                <X aria-hidden />
                清空筛选条件
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              className={cn('hidden md:block', styles.tableScroller)}
              data-scheduled-subscriptions-table-scroll="true"
            >
              <table className={styles.table} aria-label="订阅列表">
                <colgroup>
                  <col style={{ width: '3.6%' }} />
                  <col style={{ width: '24.4%' }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '27%' }} />
                  <col style={{ width: '13%' }} />
                  <col style={{ width: '9.5%' }} />
                  <col style={{ width: '11.5%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col" aria-label="订阅选择">
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
                    <th scope="col">
                      调度
                      <span className={styles.thMeta}>北京时间</span>
                    </th>
                    <th scope="col">接收</th>
                    <th scope="col">AI 模型</th>
                    <th scope="col">状态</th>
                    <th scope="col" className={styles.actionsHead}>
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSubscriptions.map((sub) => {
                    const project = formatProjectDisplay(sub.project_ids, projects)
                    const country = formatCountrySummary(sub.country)
                    const selected = selectedIds.has(sub.id)
                    const rowLabel = `${project.display} · ${emailDisplayLabel(sub.email)}`
                    return (
                      <tr
                        key={sub.id}
                        data-selected={selected ? 'true' : 'false'}
                        aria-label={`订阅 ${rowLabel} · ${formatTime(sub)}`}
                      >
                        <td>
                          {canManage ? (
                            <Checkbox
                              checked={selected}
                              onCheckedChange={(checked) => toggleRowSelected(sub.id, checked === true)}
                              aria-label={`选中订阅 ${rowLabel}`}
                              className={styles.checkbox}
                            />
                          ) : null}
                        </td>
                        <td>
                          <span className={styles.rowPrimary} title={project.full}>
                            {project.display}
                          </span>
                          <span className={styles.rowSub} title={country.full}>
                            {country.display}
                          </span>
                        </td>
                        <td>
                          <span className={cn(styles.rowPrimary, styles.mono)}>
                            {formatTime(sub)}
                          </span>
                          <span className={styles.rowSub}>{formatFrequencyDetail(sub)}</span>
                        </td>
                        <td>
                          <span
                            className={cn(
                              styles.emailCell,
                              !sub.email && styles.emailEmpty
                            )}
                            title={emailDisplayLabel(sub.email)}
                            dir={sub.email ? 'ltr' : undefined}
                          >
                            {emailDisplayLabel(sub.email)}
                          </span>
                        </td>
                        <td>
                          <span className={styles.modelCell} title={sub.ai_model || '—'}>
                            {sub.ai_model || '—'}
                          </span>
                        </td>
                        <td>
                          {canManage ? (
                            <button
                              type="button"
                              role="switch"
                              aria-checked={sub.enabled}
                              aria-label={`${sub.enabled ? '暂停订阅' : '启用订阅'}：${project.display}`}
                              data-on={sub.enabled ? 'true' : 'false'}
                              className={styles.switch}
                              onClick={() => void handleToggle(sub)}
                            >
                              <span className={styles.switchTrack} aria-hidden />
                              <span className={styles.switchLabel}>
                                {sub.enabled ? '启用' : '已暂停'}
                              </span>
                            </button>
                          ) : (
                            <span className={styles.statusText}>
                              <span aria-hidden>{sub.enabled ? '✓' : '⏸'}</span>
                              {sub.enabled ? '启用' : '已暂停'}
                            </span>
                          )}
                        </td>
                        <td>
                          {canManage ? (
                            <div className={styles.actions}>
                              <button
                                type="button"
                                onClick={() => handleEdit(sub)}
                                className={styles.inlineAction}
                                aria-label="编辑订阅"
                                title="编辑订阅"
                              >
                                <Pencil aria-hidden />
                                编辑
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDelete(sub.id)}
                                className={cn(styles.inlineAction, styles.inlineDanger)}
                                aria-label="删除订阅"
                                title="删除订阅"
                              >
                                <Trash2 aria-hidden />
                                删除
                              </button>
                            </div>
                          ) : (
                            <span className={styles.emptyCell}>—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div
              className={cn('md:hidden', styles.mobileList)}
              data-testid="subscriptions-mobile-list"
            >
              {filteredSubscriptions.map((sub) => {
                const project = formatProjectDisplay(sub.project_ids, projects)
                const country = formatCountrySummary(sub.country)
                const selected = selectedIds.has(sub.id)
                const rowLabel = `${project.display} · ${emailDisplayLabel(sub.email)}`
                return (
                  <div
                    key={sub.id}
                    className={cn(styles.mobileCard, selected && styles.mobileCardSelected)}
                    data-selected={selected ? 'true' : 'false'}
                  >
                    <div className={styles.mobileHeader}>
                      <div className={styles.mobileIdentity}>
                        {canManage ? (
                          <Checkbox
                            checked={selected}
                            onCheckedChange={(checked) => toggleRowSelected(sub.id, checked === true)}
                            aria-label={`选中订阅 ${rowLabel}`}
                            className={styles.checkbox}
                          />
                        ) : null}
                        <div className="min-w-0">
                          <div className={styles.mobileTitle} title={project.full}>
                            {project.display}
                          </div>
                          <div className={cn(styles.mobileMeta, styles.mobileTime)} data-warm-value="time">
                            {formatTime(sub)}
                          </div>
                        </div>
                      </div>
                      <div className={styles.mobileBadges}>
                        <WarmFrequencyTag frequency={sub.frequency} labels={FREQUENCY_LABELS} />
                        {sub.enabled ? (
                          <WarmStatusPill status="sent" label="启用" />
                        ) : (
                          <span className={styles.mobilePaused}>已暂停</span>
                        )}
                      </div>
                    </div>
                    <div className={styles.mobileMeta}>{country.display}</div>
                    <div className={styles.mobileMeta} title={emailDisplayLabel(sub.email)}>
                      <span className={cn(styles.emailCell, !sub.email && styles.emailEmpty)}>
                        {emailDisplayLabel(sub.email)}
                      </span>
                    </div>
                    {sub.ai_model ? (
                      <div
                        className={styles.mobileModel}
                        data-warm-value="model"
                      >
                        AI: {sub.ai_model}
                      </div>
                    ) : null}
                    {canManage ? (
                      <div className={styles.mobileActions}>
                        <button
                          type="button"
                          onClick={() => void handleToggle(sub)}
                          className={styles.mobileAction}
                          aria-label={`${sub.enabled ? '暂停订阅' : '启用订阅'}：${project.display}`}
                        >
                          <Power aria-hidden />
                          {sub.enabled ? '暂停' : '启用'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleEdit(sub)}
                          className={styles.mobileAction}
                          aria-label="编辑订阅"
                        >
                          <Pencil aria-hidden />
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(sub.id)}
                          className={cn(styles.mobileAction, styles.mobileActionDanger)}
                          aria-label="删除订阅"
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
