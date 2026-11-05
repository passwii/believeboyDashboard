'use client'

import {
  forwardRef,
  useEffect,
  useState,
  useCallback,
  useRef,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { useSearchParams } from 'next/navigation'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Target,
  TrendingUp,
  Calendar,
  DollarSign,
  BarChart3,
  X,
} from 'lucide-react'
import { useSession } from 'next-auth/react'

import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { MobileFilterStrip } from '@/components/terminal/mobile-filter-strip'
import {
  HeaderSlotSelect,
  TERM_HEADER_W_MD,
  TERM_HEADER_W_SM,
} from '@/components/terminal/header-filter-suite'
import { useHeaderRefresh, useHeaderSlot, useMobileFilterStrip } from '@/components/terminal/terminal-header-slot'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { COUNTRY_TIMEZONE_MAP, getTodayInTimezone } from '@/components/ui/date-picker'
import { GoalProgressRings, achievementPaceRatio } from '@/components/ui/goal-progress-rings'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { clearOpsClientCaches, fetchOpsJsonCached } from '@/lib/ops-client-cache'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { cn } from '@/lib/utils'

import styles from './project-goals-warm.module.css'

const API_BASE = '/api/backend/api/v1'

const COUNTRY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

const CURRENCY_SYMBOL: Record<string, string> = {
  US: '$',
  DE: '€',
  UK: '£',
  USD: '$',
  EUR: '€',
  GBP: '£',
}

type ProjectOption = {
  id: number
  name: string
  project_operator: string | null
  assistant_operator: string | null
}

type MonthlyProgressItem = {
  year: number
  month: number
  month_label: string
  target_amount: number
  achieved_amount: number
  completion_rate: number
  days_in_month: number
  today_day: number
  daily_target: number
  cumulative_daily_target: number
  completion_vs_daily: number
  completion_vs_monthly: number
  currency: string
}

type AnnualProgressItem = {
  year: number
  target_amount: number
  achieved_amount: number
  completion_rate: number
  currency: string
}

type ProjectGoalItem = {
  id: number
  project_id: number
  country: string
  goal_type: string
  metric_type: string
  period_year: number
  period_month: number | null
  target_amount: number
  currency: string
  created_at: string
  updated_at: string
}

type ProjectGoalProgressResponse = {
  project_id: number
  country: string
  currency: string
  year: number
  monthly_progress: MonthlyProgressItem[]
  annual_progress: AnnualProgressItem | null
}

type ProjectGoalListResponse = {
  goals: ProjectGoalItem[]
  total: number
}

type GoalFormData = {
  goal_type: string
  period_month: string
  target_amount: string
}

const MONTH_NAMES = [
  '1月',
  '2月',
  '3月',
  '4月',
  '5月',
  '6月',
  '7月',
  '8月',
  '9月',
  '10月',
  '11月',
  '12月',
]

function formatMoney(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function getOperatorsDisplay(projectId: string, projects: ProjectOption[]) {
  const proj = projects.find((p) => String(p.id) === projectId)
  if (!proj) return '—'
  const parts = [proj.project_operator, proj.assistant_operator].filter(Boolean)
  return parts.length > 0 ? parts.join(' / ') : '—'
}

function CompletionBadge({
  rate,
  monthStatus,
}: {
  rate: number
  monthStatus: 'past' | 'current' | 'future'
}) {
  if (monthStatus === 'current') {
    return <WarmBadge tone="accent">进行中</WarmBadge>
  }
  if (monthStatus === 'future') {
    return <WarmBadge tone="neutral">未开始</WarmBadge>
  }
  if (rate >= 1) return <WarmBadge tone="positive">达成</WarmBadge>
  return <WarmBadge tone="negative">未达标</WarmBadge>
}

function ProgressBar({
  value,
  className,
  isPastIncomplete,
}: {
  value: number
  className?: string
  isPastIncomplete?: boolean
}) {
  const pct = Math.min(value * 100, 100)
  const over = value > 1
  return (
    <div className={cn(styles.progressTrack, className)}>
      <div
        className={cn(
          styles.progressFill,
          over
            ? styles.progressPositive
            : isPastIncomplete
              ? styles.progressNegative
              : styles.progressAccent
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function Button({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={[styles.button, className].filter(Boolean).join(' ')}
    />
  )
}

const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        {...props}
        ref={ref}
        className={[styles.input, className].filter(Boolean).join(' ')}
      />
    )
  }
)

const Dialog = DialogPrimitive.Root

const DialogContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(function DialogContent({ className, children, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={styles.dialogOverlay} />
      <DialogPrimitive.Content
        {...props}
        ref={ref}
        className={[styles.dialog, className].filter(Boolean).join(' ')}
      >
        {children}
        <DialogPrimitive.Close className={styles.dialogClose} aria-label="关闭">
          <X aria-hidden />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})

function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={[styles.dialogHeader, className].filter(Boolean).join(' ')} />
}

function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={[styles.dialogFooter, className].filter(Boolean).join(' ')} />
}

const DialogTitle = forwardRef<
  HTMLHeadingElement,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      {...props}
      ref={ref}
      className={[styles.dialogTitle, className].filter(Boolean).join(' ')}
    />
  )
})

function Panel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <section className={[styles.panel, className].filter(Boolean).join(' ')}>{children}</section>
}

function TablePanel({
  title,
  description,
  action,
  children,
}: {
  title: string
  description: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={styles.tablePanel}>
      <header className={styles.tableHeader}>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {action ? <div className={styles.tableAction}>{action}</div> : null}
      </header>
      {children}
    </section>
  )
}

export default function ProjectGoalsPage() {
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const searchParams = useSearchParams()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    searchParams.get('project') ?? ''
  )

  // 进入页面默认选中第一个真实项目,内容立即加载（跳过 all / 空白意图）
  useAutoSelectFirstProject(projects, selectedProjectId, setSelectedProjectId)
  const [selectedCountry, setSelectedCountry] = useState<string>(
    searchParams.get('country') ?? 'US'
  )
  const [selectedYear, setSelectedYear] = useState<string>(
    String(getTodayInTimezone(COUNTRY_TIMEZONE_MAP.US).getFullYear())
  )
  const [loading, setLoading] = useState(false)

  // Data
  const [progressData, setProgressData] = useState<ProjectGoalProgressResponse | null>(null)
  const [goalsData, setGoalsData] = useState<ProjectGoalItem[]>([])
  const currency = progressData?.currency || 'USD'
  const currencySymbol = CURRENCY_SYMBOL[currency] || '$'

  // Dialog
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingGoal, setEditingGoal] = useState<ProjectGoalItem | null>(null)
  const [formData, setFormData] = useState<GoalFormData>({
    goal_type: 'monthly',
    period_month: String(new Date().getMonth() + 1),
    target_amount: '',
  })
  const [saving, setSaving] = useState(false)

  // BEL-423 页内懒加载：进度概览与目标列表拆开按 tab 取数——mount 只拉 progress，
  // "目标管理" tab 首次激活才拉 goals；两者都进 2min 客户端缓存（写操作后清缓存）。
  const [activeTab, setActiveTab] = useState('progress')
  const goalsRequestedRef = useRef(false)

  const loadProgress = useCallback(
    async (force = false) => {
      if (!selectedProjectId) return
      const year = selectedYear || String(new Date().getFullYear())
      const payload = await fetchOpsJsonCached<ProjectGoalProgressResponse>(
        `${API_BASE}/project-goals/progress?project_id=${selectedProjectId}&country=${selectedCountry}&year=${year}`,
        { session, force }
      )
      setProgressData(payload)
    },
    [selectedProjectId, selectedCountry, selectedYear, session]
  )

  const loadGoals = useCallback(
    async (force = false) => {
      if (!selectedProjectId) return
      const year = selectedYear || String(new Date().getFullYear())
      const data = await fetchOpsJsonCached<ProjectGoalListResponse>(
        `${API_BASE}/project-goals?project_id=${selectedProjectId}&country=${selectedCountry}&year=${year}`,
        { session, force }
      )
      setGoalsData(data.goals)
    },
    [selectedProjectId, selectedCountry, selectedYear, session]
  )

  const loadData = useCallback(
    async (force = false) => {
      if (!selectedProjectId) return
      setLoading(true)
      try {
        await Promise.all([
          loadProgress(force),
          goalsRequestedRef.current ? loadGoals(force) : Promise.resolve(),
        ])
      } catch {
        notify({ type: 'error', title: '数据加载失败' })
      } finally {
        setLoading(false)
      }
    },
    [selectedProjectId, loadProgress, loadGoals, notify]
  )

  useEffect(() => {
    fetchManagedProjectsCached<ProjectOption[]>(session).then(setProjects)
  }, [session])

  useEffect(() => {
    if (selectedProjectId) {
      void loadData()
    } else {
      setProgressData(null)
      setGoalsData([])
      goalsRequestedRef.current = false
    }
  }, [selectedProjectId, selectedCountry, selectedYear, loadData])

  // —— Header 化：全局刷新（operations header migration A2）——
  // 刷新语义与原控制台「刷新」按钮一致：当前筛选条件下强刷（force 跳 2min 客户端缓存）。
  // handler 经 ref 桥接，永远执行最新闭包，避免锁死过期的 selectedProjectId 等状态。
  const loadDataRef = useRef(loadData)
  loadDataRef.current = loadData
  useHeaderRefresh(() => loadDataRef.current(true), { loading })

  // tab 激活时才拉对应数据：goals 列表首次进入"目标管理"再取数
  const handleTabChange = (value: string) => {
    setActiveTab(value)
    if (value === 'goals' && !goalsRequestedRef.current) {
      goalsRequestedRef.current = true
      loadGoals().catch(() => {
        notify({ type: 'error', title: '目标列表加载失败' })
      })
    }
  }

  // Current month progress
  const currentLocalDate = getTodayInTimezone(COUNTRY_TIMEZONE_MAP[selectedCountry] ?? 'UTC')
  const currentMonth = currentLocalDate.getMonth() + 1
  const currentYear = currentLocalDate.getFullYear()
  const currentMonthProgress = progressData?.monthly_progress.find(
    (m) => m.year === currentYear && m.month === currentMonth
  )
  const currentMonthPaceRatio = currentMonthProgress
    ? achievementPaceRatio(
        currentMonthProgress.achieved_amount,
        currentMonthProgress.target_amount,
        currentMonthProgress.today_day,
        currentMonthProgress.days_in_month
      )
    : null

  // Annual progress
  const annualProgress = progressData?.annual_progress

  // Goals map for quick lookup
  const monthlyGoalsMap: Record<number, number> = {}
  goalsData
    .filter((g) => g.goal_type === 'monthly')
    .forEach((g) => {
      if (g.period_month !== null) monthlyGoalsMap[g.period_month] = g.target_amount
    })
  const annualGoal = goalsData.find((g) => g.goal_type === 'annual')?.target_amount ?? null

  function openCreateDialog(type: 'monthly' | 'annual', preselectMonth?: number) {
    const month = preselectMonth ? preselectMonth : currentMonth
    // 月度目标若该月已有目标，转为编辑
    if (type === 'monthly') {
      const existing = goalsData.find((g) => g.goal_type === 'monthly' && g.period_month === month)
      if (existing) {
        openEditDialog(existing)
        return
      }
    }
    setEditingGoal(null)
    setFormData({
      goal_type: type,
      period_month: String(month),
      target_amount: '',
    })
    setDialogOpen(true)
  }

  function openEditDialog(goal: ProjectGoalItem) {
    setEditingGoal(goal)
    setFormData({
      goal_type: goal.goal_type,
      period_month: goal.period_month !== null ? String(goal.period_month) : '',
      target_amount: String(goal.target_amount),
    })
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!selectedProjectId || !formData.target_amount) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        project_id: Number(selectedProjectId),
        country: selectedCountry,
        goal_type: formData.goal_type,
        period_year: Number(selectedYear),
        target_amount: Number(formData.target_amount),
      }
      if (formData.goal_type === 'monthly') {
        body.period_month = Number(formData.period_month)
      }

      const res = editingGoal
        ? await fetch(`${API_BASE}/project-goals/${editingGoal.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_amount: Number(formData.target_amount) }),
          })
        : await fetch(`${API_BASE}/project-goals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })

      if (!res.ok) {
        const raw = await res.text()
        console.error('[project-goals] save error', res.status, raw)
        let msg = '保存失败'
        if (res.status === 409 && !editingGoal) {
          msg =
            formData.goal_type === 'monthly'
              ? `${formData.period_month}月目标已存在，请直接编辑现有目标`
              : `${selectedYear}年度目标已存在，请直接编辑现有目标`
          clearOpsClientCaches()
          await loadData(true)
        } else {
          try {
            const err = JSON.parse(raw)
            msg = Array.isArray(err.detail)
              ? err.detail.map((e: { msg?: string }) => e.msg || String(e)).join('；')
              : err.detail || err.message || msg
          } catch {
            msg = raw || res.statusText || msg
          }
        }
        throw new Error(msg)
      }
      notify({ type: 'success', title: editingGoal ? '目标已更新' : '目标已创建' })
      setDialogOpen(false)
      // BEL-423：写操作后清掉板块缓存，再 force 重载拿最新数据
      clearOpsClientCaches()
      void loadData(true)
    } catch (e) {
      notify({ type: 'error', title: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(goal: ProjectGoalItem) {
    if (
      !(await confirm({
        title: `确定删除 ${goal.goal_type === 'monthly' ? `${goal.period_month}月` : '年度'} 目标？`,
        variant: 'destructive',
      }))
    )
      return
    const res = await fetch(`${API_BASE}/project-goals/${goal.id}`, { method: 'DELETE' })
    if (!res.ok) {
      notify({ type: 'error', title: '删除失败' })
    } else {
      notify({ type: 'success', title: '目标已删除' })
      clearOpsClientCaches()
      void loadData(true)
    }
  }

  const years = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i)

  // 筛选控件 portal 进 Top Header 中段插槽（项目 / 站点 / 年份，term 规格）
  const filterControls = (
    <>
      <HeaderSlotSelect
        value={selectedProjectId}
        onChange={setSelectedProjectId}
        options={projects.map((p) => ({ value: String(p.id), label: p.name }))}
        placeholder="选择项目"
        widthClass={TERM_HEADER_W_MD}
        title="项目筛选"
      />
      <HeaderSlotSelect
        value={selectedCountry}
        onChange={setSelectedCountry}
        options={COUNTRY_OPTIONS}
        widthClass={TERM_HEADER_W_SM}
        title="站点筛选"
      />
      <HeaderSlotSelect
        value={selectedYear}
        onChange={setSelectedYear}
        options={years.map((y) => ({ value: String(y), label: `${y} 年` }))}
        widthClass={TERM_HEADER_W_SM}
        title="年份筛选"
      />
    </>
  )
  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={filterControls} />
  )

  // BLF-931 · 移动端：筛选控件下迁为正文顶部可折叠筛选条
  const mobileProjectLabel = projects.find((p) => String(p.id) === selectedProjectId)?.name ?? selectedProjectId
  const mobileCountryLabel = selectedCountry === 'ALL' ? '全部站点' : (COUNTRY_OPTIONS.find((o) => o.value === selectedCountry)?.label ?? selectedCountry)
  const mobileYearLabel = selectedYear ? `${selectedYear} 年` : '未选年份'
  const mobileFilterSummary = `${mobileProjectLabel} · ${mobileCountryLabel} · ${mobileYearLabel}`
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      controls={
        <>
          <HeaderSlotSelect
            value={selectedProjectId}
            onChange={setSelectedProjectId}
            options={projects.map((p) => ({ value: String(p.id), label: p.name }))}
            placeholder="选择项目"
            widthClass={TERM_HEADER_W_MD}
            title="项目筛选"
          />
          <HeaderSlotSelect
            value={selectedCountry}
            onChange={setSelectedCountry}
            options={COUNTRY_OPTIONS}
            widthClass={TERM_HEADER_W_SM}
            title="站点筛选"
          />
          <HeaderSlotSelect
            value={selectedYear}
            onChange={setSelectedYear}
            options={years.map((y) => ({ value: String(y), label: `${y} 年` }))}
            widthClass={TERM_HEADER_W_SM}
            title="年份筛选"
          />
        </>
      }
    />
  )

  return (
    <main
      className={styles.page}
      data-testid="project-goals-warm-page"
      data-warm-surface="warm-ledger"
      aria-busy={loading}
    >
      {headerSlotPortal}
      {mobileFilterStrip}

      {!selectedProjectId ? (
        <div className={styles.emptyState}>请选择项目以查看目标数据</div>
      ) : loading && !progressData ? (
        <div className={styles.loadingStack}>
          <div className={styles.loadingGrid}>
            {[...Array(4)].map((_, i) => (
              <div key={i} className={styles.skeletonMetric} />
            ))}
          </div>
          <div className={styles.skeletonPanel} />
        </div>
      ) : (
        <div className={styles.contentStack}>
          {currentMonthProgress && (
            <section className={styles.progressSection}>
              <div className={styles.sectionHeading}>
                <BarChart3 aria-hidden />
                <h2>本月进度 · {currentMonthProgress.month_label}</h2>
              </div>

              <Panel className={styles.progressPanel}>
                <GoalProgressRings
                  items={[
                    {
                      key: 'pace',
                      label: '截止今日完成率',
                      value: currentMonthProgress.completion_vs_daily,
                      display: formatPercent(currentMonthProgress.completion_vs_daily),
                      caption:
                        currentMonthProgress.target_amount > 0
                          ? `已完成 ${currencySymbol}${formatMoney(currentMonthProgress.achieved_amount)} / 应完成 ${currencySymbol}${formatMoney(currentMonthProgress.cumulative_daily_target)}`
                          : '未设置本月目标',
                      note:
                        currentMonthProgress.target_amount > 0
                          ? '当前完成 ÷ 按日摊派的累计目标'
                          : '前往「目标管理」设置月度目标',
                      color: 'var(--warm-ledger-color-accent)',
                    },
                    {
                      key: 'monthly',
                      label: '实际月度进度',
                      value: currentMonthProgress.completion_vs_monthly,
                      display: formatPercent(currentMonthProgress.completion_vs_monthly),
                      caption:
                        currentMonthProgress.target_amount > 0
                          ? `已完成 ${currencySymbol}${formatMoney(currentMonthProgress.achieved_amount)} / 目标 ${currencySymbol}${formatMoney(currentMonthProgress.target_amount)}`
                          : '未设置本月目标',
                      note:
                        currentMonthProgress.target_amount > 0
                          ? '占整月目标的实际比例'
                          : '前往「目标管理」设置月度目标',
                      color: 'var(--warm-ledger-color-positive)',
                    },
                    {
                      key: 'pace_ratio',
                      label: '达成速度',
                      value: currentMonthPaceRatio ?? 0,
                      display:
                        currentMonthProgress.target_amount <= 0
                          ? '未设置'
                          : currentMonthPaceRatio === null
                            ? '--'
                            : currentMonthProgress.achieved_amount >=
                                currentMonthProgress.target_amount
                              ? '已达标'
                              : formatPercent(currentMonthPaceRatio),
                      caption:
                        currentMonthProgress.target_amount > 0
                          ? '当前日均 / 剩余所需日均'
                          : '未设置本月目标',
                      note:
                        currentMonthProgress.target_amount > 0 &&
                        currentMonthPaceRatio !== null
                          ? '≥100% 表示按当前节奏可追平目标'
                          : currentMonthProgress.target_amount > 0
                            ? '当前日期口径无效'
                            : '前往「目标管理」设置月度目标',
                      color: 'var(--warm-ledger-color-text-soft)',
                    },
                  ]}
                />

                <div className={styles.progressDivider} />

                <div className={styles.metricGrid}>
                  <div className={styles.metricTile}>
                    <div className={styles.metricLabel}>
                      <TrendingUp aria-hidden />
                      年度完成率
                    </div>
                    {annualProgress ? (
                      <>
                        <p className={styles.metricValue}>
                          {formatPercent(annualProgress.completion_rate)}
                        </p>
                        <p className={styles.metricNote}>
                          目标 {currencySymbol}
                          {formatMoney(annualProgress.target_amount)}
                        </p>
                      </>
                    ) : (
                      <div className={styles.metricEmpty}>
                        <span>未设置</span>
                        <Button onClick={() => openCreateDialog('annual')}>
                          <Plus aria-hidden /> 设置
                        </Button>
                      </div>
                    )}
                  </div>

                  <div className={styles.metricTile}>
                    <div className={styles.metricLabel}>
                      <DollarSign aria-hidden />
                      本月已达成
                    </div>
                    <p className={styles.metricValue}>
                      {currencySymbol} {formatMoney(currentMonthProgress.achieved_amount)}
                    </p>
                    <p className={styles.metricNote}>当月实际销售额（截至今日）</p>
                  </div>

                  <div className={styles.metricTile}>
                    <div className={styles.metricLabel}>
                      <Target aria-hidden />
                      月度目标
                    </div>
                    {currentMonthProgress.target_amount > 0 ? (
                      <>
                        <p className={styles.metricValue}>
                          {currencySymbol} {formatMoney(currentMonthProgress.target_amount)}
                        </p>
                        <p className={styles.metricNote}>整月销售目标金额</p>
                      </>
                    ) : (
                      <div className={styles.metricEmpty}>
                        <span>未设置</span>
                        <Button onClick={() => handleTabChange('goals')}>
                          <Plus aria-hidden /> 去设置
                        </Button>
                      </div>
                    )}
                  </div>

                  <div className={styles.metricTile}>
                    <div className={styles.metricLabel}>
                      <Calendar aria-hidden />
                      日目标
                    </div>
                    <p className={styles.metricValue}>
                      {currencySymbol} {formatMoney(currentMonthProgress.daily_target)}
                    </p>
                    <p className={styles.metricNote}>
                      第 {currentMonthProgress.today_day} / {currentMonthProgress.days_in_month} 天
                      · 目标 ÷ 天数
                    </p>
                  </div>
                </div>
              </Panel>
            </section>
          )}

          <Tabs value={activeTab} onValueChange={handleTabChange} className={styles.tabs}>
            <TabsList className={styles.tabsList}>
              <TabsTrigger value="progress" className={styles.tabTrigger}>
                <BarChart3 aria-hidden />
                进度概览
              </TabsTrigger>
              <TabsTrigger value="goals" className={styles.tabTrigger}>
                <Target aria-hidden />
                目标管理
              </TabsTrigger>
            </TabsList>

            <TabsContent value="progress" className={styles.tabContent}>
              <TablePanel
                title="月度进度表"
                description={`${selectedYear} 年各月销售目标完成情况`}
              >
                <div className={styles.tableScroll} data-testid="project-goals-table-scroll">
                  <table className={styles.table}>
                    <colgroup>
                      <col className={styles.colMonth} />
                      <col className={styles.colMoney} />
                      <col className={styles.colMoney} />
                      <col className={styles.colProgress} />
                      <col className={styles.colStatus} />
                      <col className={styles.colOperators} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>月份</th>
                        <th className={styles.alignRight}>目标金额</th>
                        <th className={styles.alignRight}>已完成</th>
                        <th>月度完成进度</th>
                        <th className={styles.alignCenter}>状态</th>
                        <th className={styles.alignCenter}>运营（包含助理）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {progressData?.monthly_progress.map((m) => {
                        const monthStatus: 'past' | 'current' | 'future' =
                          m.year < currentYear
                            ? 'past'
                            : m.year > currentYear
                              ? 'future'
                              : m.month < currentMonth
                                ? 'past'
                                : m.month > currentMonth
                                  ? 'future'
                                  : 'current'
                        const isPastIncomplete =
                          monthStatus === 'past' && m.completion_vs_monthly < 1
                        return (
                          <tr
                            key={m.month}
                            className={m.month === currentMonth ? styles.currentRow : undefined}
                          >
                            <td className={styles.strongCell}>
                              {m.month === currentMonth ? (
                                <span className={styles.currentLabel}>
                                  {m.month_label}（本月）
                                </span>
                              ) : (
                                m.month_label
                              )}
                            </td>
                            <td className={styles.numericCell}>
                              {m.target_amount > 0
                                ? `${currencySymbol} ${formatMoney(m.target_amount)}`
                                : '—'}
                            </td>
                            <td className={styles.numericCell}>
                              {currencySymbol} {formatMoney(m.achieved_amount)}
                            </td>
                            <td>
                              {m.target_amount > 0 ? (
                                <div className={styles.progressCell}>
                                  <ProgressBar
                                    value={m.completion_vs_monthly}
                                    isPastIncomplete={isPastIncomplete}
                                  />
                                  <div className={styles.progressMeta}>
                                    <span>{formatPercent(m.completion_vs_monthly)}</span>
                                    <span>
                                      {currencySymbol} {formatMoney(m.achieved_amount)} /{' '}
                                      {currencySymbol} {formatMoney(m.target_amount)}
                                    </span>
                                  </div>
                                </div>
                              ) : (
                                <span className={styles.mutedText}>未设目标</span>
                              )}
                            </td>
                            <td className={styles.alignCenter}>
                              {m.target_amount > 0 ? (
                                <CompletionBadge
                                  rate={m.completion_vs_monthly}
                                  monthStatus={monthStatus}
                                />
                              ) : null}
                            </td>
                            <td className={styles.alignCenter}>
                              {getOperatorsDisplay(selectedProjectId, projects)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </TablePanel>
            </TabsContent>

            <TabsContent value="goals" className={styles.tabContent}>
              <TablePanel
                title="月度目标"
                description={`${selectedYear} 年各月销售目标（点击编辑或删除）`}
                action={
                  <Button onClick={() => openCreateDialog('monthly')}>
                    <Plus aria-hidden /> 新增月度目标
                  </Button>
                }
              >
                <div className={styles.tableScroll} data-testid="project-goals-table-scroll">
                  <table className={styles.table}>
                    <colgroup>
                      <col className={styles.colMonth} />
                      <col className={styles.colMoney} />
                      <col className={styles.colMoney} />
                      <col className={styles.colProgress} />
                      <col className={styles.colStatus} />
                      <col className={styles.colActions} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>月份</th>
                        <th className={styles.alignRight}>目标金额</th>
                        <th className={styles.alignRight}>已达成</th>
                        <th>月度进度</th>
                        <th className={styles.alignCenter}>状态</th>
                        <th className={styles.alignRight}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...Array(12)].map((_, idx) => {
                        const month = idx + 1
                        const goal = goalsData.find(
                          (g) => g.goal_type === 'monthly' && g.period_month === month
                        )
                        const progress = progressData?.monthly_progress.find(
                          (m) => m.month === month
                        )
                        const hasGoal = goal !== undefined
                        const monthStatus: 'past' | 'current' | 'future' =
                          Number(selectedYear) < currentYear
                            ? 'past'
                            : Number(selectedYear) > currentYear
                              ? 'future'
                              : month < currentMonth
                                ? 'past'
                                : month > currentMonth
                                  ? 'future'
                                  : 'current'
                        const isPastIncomplete =
                          monthStatus === 'past' &&
                          (progress ? progress.completion_vs_monthly < 1 : true)
                        return (
                          <tr
                            key={month}
                            className={month === currentMonth ? styles.currentRow : undefined}
                          >
                            <td className={styles.strongCell}>
                              {month === currentMonth ? (
                                <span className={styles.currentLabel}>
                                  {selectedYear}年{MONTH_NAMES[idx]}（本月）
                                </span>
                              ) : (
                                <span>
                                  {selectedYear}年{MONTH_NAMES[idx]}
                                </span>
                              )}
                            </td>
                            <td className={styles.numericCell}>
                              {hasGoal ? (
                                `${currencySymbol} ${formatMoney(goal!.target_amount)}`
                              ) : (
                                <span className={styles.mutedText}>—</span>
                              )}
                            </td>
                            <td className={styles.numericCell}>
                              {currencySymbol} {formatMoney(progress?.achieved_amount ?? 0)}
                            </td>
                            <td>
                              {hasGoal && goal!.target_amount > 0 && progress ? (
                                <div className={styles.progressCell}>
                                  <ProgressBar
                                    value={progress.completion_vs_monthly}
                                    isPastIncomplete={isPastIncomplete}
                                  />
                                  <div className={styles.progressMeta}>
                                    {formatPercent(progress.completion_vs_monthly)}
                                  </div>
                                </div>
                              ) : (
                                <span className={styles.mutedText}>—</span>
                              )}
                            </td>
                            <td className={styles.alignCenter}>
                              {hasGoal && progress ? (
                                <CompletionBadge
                                  rate={progress.completion_vs_monthly}
                                  monthStatus={monthStatus}
                                />
                              ) : null}
                            </td>
                            <td>
                              {hasGoal ? (
                                <div className={styles.rowActions}>
                                  <Button
                                    aria-label={`编辑${selectedYear}年${MONTH_NAMES[idx]}目标`}
                                    onClick={() => openEditDialog(goal!)}
                                  >
                                    <Pencil aria-hidden />
                                  </Button>
                                  <Button
                                    aria-label={`删除${selectedYear}年${MONTH_NAMES[idx]}目标`}
                                    className={styles.dangerButton}
                                    onClick={() => handleDelete(goal!)}
                                  >
                                    <Trash2 aria-hidden />
                                  </Button>
                                </div>
                              ) : (
                                <div className={styles.rowActions}>
                                  <Button
                                    aria-label={`设置${selectedYear}年${MONTH_NAMES[idx]}目标`}
                                    onClick={() => openCreateDialog('monthly', month)}
                                  >
                                    <Plus aria-hidden />
                                  </Button>
                                </div>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </TablePanel>
            </TabsContent>
          </Tabs>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          className={styles.dialog}
          aria-describedby="goal-dialog-description"
        >
          <span id="goal-dialog-description" className="sr-only">
            新增或编辑目标对话框
          </span>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>
              {editingGoal
                ? '编辑目标'
                : `新增 ${formData.goal_type === 'monthly' ? '月度' : '年度'}目标`}
            </DialogTitle>
          </DialogHeader>
          <div className={styles.dialogBody}>
            <div className={styles.field}>
              <label className={styles.label}>
                {formData.goal_type === 'monthly' ? '目标月份' : '目标年份'}
              </label>
              <div className={styles.readOnlyValue}>
                {formData.goal_type === 'monthly'
                  ? `${selectedYear} 年 ${formData.period_month} 月`
                  : `${selectedYear} 年`}
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>
                目标金额（{currencySymbol} {currency}）
              </label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="例如：50000"
                value={formData.target_amount}
                onChange={(e) => setFormData((f) => ({ ...f, target_amount: e.target.value }))}
              />
              <p className={styles.formHelp}>
                填入该月/年度的销售目标金额（按站点原始货币）
              </p>
            </div>
          </div>
          <DialogFooter className={styles.dialogFooter}>
            <Button onClick={() => setDialogOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving || !formData.target_amount}>
              {saving ? <Loader2 aria-hidden className={styles.spinner} /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
