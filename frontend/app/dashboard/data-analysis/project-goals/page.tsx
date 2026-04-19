'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { Loader2, Plus, Pencil, Trash2, Target, TrendingUp, Calendar, DollarSign, AlertCircle, BarChart3, Layers } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { DataCard, DataCardHeader, DataCardContent, DataTableCard, DataTableCardHeader, DataTableCardBody } from '@/components/ui/data-card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { StatCard } from '@/components/ui/stat-card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { COUNTRY_TIMEZONE_MAP, getTodayInTimezone } from '@/components/ui/date-picker'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useNotifications } from '@/components/notifications'
import { cn } from '@/lib/utils'

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

const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

function formatMoney(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function getOperatorsDisplay(projectId: string, projects: ProjectOption[]) {
  const proj = projects.find(p => String(p.id) === projectId)
  if (!proj) return '—'
  const parts = [proj.project_operator, proj.assistant_operator].filter(Boolean)
  return parts.length > 0 ? parts.join(' / ') : '—'
}

function CompletionBadge({ rate, monthStatus }: { rate: number; monthStatus: 'past' | 'current' | 'future' }) {
  if (monthStatus === 'current') {
    return <Badge className='bg-blue-500'>进行中</Badge>
  }
  if (monthStatus === 'future') {
    return <Badge className='bg-muted-foreground/30'>未开始</Badge>
  }
  // past month
  if (rate >= 1) return <Badge className='bg-green-500'>达成</Badge>
  return <Badge className='bg-orange-500'>未达标</Badge>
}

function ProgressBar({ value, className, isPastIncomplete }: { value: number; className?: string; isPastIncomplete?: boolean }) {
  const pct = Math.min(value * 100, 100)
  const over = value > 1
  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div
        className={cn('h-full rounded-full transition-all duration-500', over ? 'bg-green-500' : isPastIncomplete ? 'bg-orange-500' : 'bg-blue-500')}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export default function ProjectGoalsPage() {
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const searchParams = useSearchParams()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string>(searchParams.get('project') ?? '')
  const [selectedCountry, setSelectedCountry] = useState<string>(searchParams.get('country') ?? 'US')
  const [selectedYear, setSelectedYear] = useState<string>(
    String(getTodayInTimezone(COUNTRY_TIMEZONE_MAP.US).getFullYear()),
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

  const loadData = useCallback(async () => {
    if (!selectedProjectId) return
    setLoading(true)
    try {
      const year = selectedYear || String(new Date().getFullYear())
      const [progressRes, goalsRes] = await Promise.all([
        fetch(`${API_BASE}/project-goals/progress?project_id=${selectedProjectId}&country=${selectedCountry}&year=${year}`, { cache: 'no-store' }),
        fetch(`${API_BASE}/project-goals?project_id=${selectedProjectId}&country=${selectedCountry}&year=${year}`, { cache: 'no-store' }),
      ])
      if (progressRes.ok) {
        setProgressData(await progressRes.json())
      }
      if (goalsRes.ok) {
        const data = (await goalsRes.json()) as ProjectGoalListResponse
        setGoalsData(data.goals)
      }
    } catch {
      notify({ type: 'error', title: '数据加载失败' })
    } finally {
      setLoading(false)
    }
  }, [selectedProjectId, selectedCountry, selectedYear, notify])

  useEffect(() => {
    fetchManagedProjectsCached<ProjectOption[]>(session).then(setProjects)
  }, [session])

  useEffect(() => {
    if (selectedProjectId) {
      loadData()
    } else {
      setProgressData(null)
      setGoalsData([])
    }
  }, [selectedProjectId, selectedCountry, selectedYear, loadData])

  // Current month progress
  const currentLocalDate = getTodayInTimezone(COUNTRY_TIMEZONE_MAP[selectedCountry] ?? 'UTC')
  const currentMonth = currentLocalDate.getMonth() + 1
  const currentYear = currentLocalDate.getFullYear()
  const currentMonthProgress = progressData?.monthly_progress.find(
    m => m.year === currentYear && m.month === currentMonth,
  )

  // Annual progress
  const annualProgress = progressData?.annual_progress

  // Goals map for quick lookup
  const monthlyGoalsMap: Record<number, number> = {}
  goalsData.filter(g => g.goal_type === 'monthly').forEach(g => {
    if (g.period_month !== null) monthlyGoalsMap[g.period_month] = g.target_amount
  })
  const annualGoal = goalsData.find(g => g.goal_type === 'annual')?.target_amount ?? null

  function openCreateDialog(type: 'monthly' | 'annual', preselectMonth?: number) {
    const month = preselectMonth ? preselectMonth : currentMonth
    // 月度目标若该月已有目标，转为编辑
    if (type === 'monthly') {
      const existing = goalsData.find(g => g.goal_type === 'monthly' && g.period_month === month)
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
          msg = formData.goal_type === 'monthly'
            ? `${formData.period_month}月目标已存在，请直接编辑现有目标`
            : `${selectedYear}年度目标已存在，请直接编辑现有目标`
          await loadData()
        } else {
          try {
            const err = JSON.parse(raw)
            msg = Array.isArray(err.detail)
              ? err.detail.map((e: { msg?: string }) => e.msg || String(e)).join('；')
              : (err.detail || err.message || msg)
          } catch {
            msg = raw || res.statusText || msg
          }
        }
        throw new Error(msg)
      }
      notify({ type: 'success', title: editingGoal ? '目标已更新' : '目标已创建' })
      setDialogOpen(false)
      loadData()
    } catch (e) {
      notify({ type: 'error', title: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(goal: ProjectGoalItem) {
    if (!confirm(`确定删除 ${goal.goal_type === 'monthly' ? `${goal.period_month}月` : '年度'} 目标？`)) return
    const res = await fetch(`${API_BASE}/project-goals/${goal.id}`, { method: 'DELETE' })
    if (!res.ok) {
      notify({ type: 'error', title: '删除失败' })
    } else {
      notify({ type: 'success', title: '目标已删除' })
      loadData()
    }
  }

  const years = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i)

  return (
    <div className='space-y-5'>

      {/* ── Console Hero ─────────────────────────────────────────────────── */}
      <Card className='dashboard-surface relative overflow-hidden'>
        {/* Atmospheric glow */}
        <div className='pointer-events-none absolute inset-0 overflow-hidden'>
          <div className='absolute -right-16 -top-16 h-72 w-72 rounded-full bg-[radial-gradient(circle,hsl(var(--primary)/0.14),transparent_72%)] dark:bg-[radial-gradient(circle,hsl(var(--primary)/0.22),transparent_72%)]' />
          <div className='absolute -bottom-8 -left-8 h-48 w-48 rounded-full bg-[radial-gradient(circle,hsl(var(--chart-2)/0.08),transparent_72%)]' />
        </div>
        <CardHeader className='relative pb-5'>
          <div className='flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between'>
            <div className='space-y-3'>
              <div className='flex items-center gap-2'>
                <Layers className='h-4 w-4 text-primary' />
                <p className='dashboard-kicker'>Project Goals Console</p>
              </div>
              <div>
                <CardTitle className='text-2xl md:text-[2rem]'>项目目标控制台</CardTitle>
                <CardDescription className='mt-2 max-w-2xl text-sm leading-6'>
                  追踪项目在选定国家站点的月度与年度销售目标完成进度，支持快速设置与调整目标。
                </CardDescription>
              </div>
            </div>

            {/* Context badges */}
            <div className='flex flex-wrap gap-2'>
              {selectedProjectId ? (
                <>
                  <Badge variant='outline' className='border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-1 text-foreground'>
                    {projects.find(p => String(p.id) === selectedProjectId)?.name ?? '—'}
                  </Badge>
                  <Badge variant='outline' className='border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-1 text-foreground'>
                    {COUNTRY_OPTIONS.find(c => c.value === selectedCountry)?.label ?? selectedCountry}
                  </Badge>
                  <Badge variant='outline' className='border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-1 text-foreground'>
                    {selectedYear} 年
                  </Badge>
                </>
              ) : (
                <Badge variant='secondary' className='px-3 py-1'>请先选择项目</Badge>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* ── Filters ─────────────────────────────────────────────────────── */}
      <div className='flex flex-wrap items-center gap-3'>
        <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
          <SelectTrigger className='w-56'>
            <SelectValue placeholder='选择项目' />
          </SelectTrigger>
          <SelectContent>
            {projects.map(p => (
              <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={selectedCountry} onValueChange={setSelectedCountry}>
          <SelectTrigger className='w-36'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COUNTRY_OPTIONS.map(c => (
              <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={selectedYear} onValueChange={setSelectedYear}>
          <SelectTrigger className='w-28'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map(y => (
              <SelectItem key={y} value={String(y)}>{y} 年</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button variant='outline' size='sm' onClick={loadData} disabled={loading || !selectedProjectId}>
          {loading ? <Loader2 className='mr-2 h-4 w-4 animate-spin' /> : null}
          刷新
        </Button>
      </div>

      {!selectedProjectId ? (
        <div className='flex h-48 items-center justify-center text-muted-foreground'>
          请选择项目以查看目标数据
        </div>
      ) : loading && !progressData ? (
        <div className='space-y-4'>
          <div className='grid grid-cols-2 gap-4 lg:grid-cols-4'>
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className='h-36 rounded-xl' />
            ))}
          </div>
          <Skeleton className='h-64 rounded-xl' />
        </div>
      ) : (
        <div className='space-y-5'>

          {/* ── Month Progress Stats ─────────────────────────────────────── */}
          {currentMonthProgress && (
            <div className='space-y-3'>
              <div className='flex items-center gap-2'>
                <BarChart3 className='h-4 w-4 text-primary' />
                <h2 className='text-sm font-semibold uppercase tracking-widest text-muted-foreground'>
                  本月进度 · {currentMonthProgress.month_label}
                </h2>
              </div>
              <div className='grid grid-cols-2 gap-4 lg:grid-cols-4'>
                <StatCard
                  title='月度完成率'
                  value={formatPercent(currentMonthProgress.completion_vs_monthly)}
                  icon={<Target className='h-4 w-4' />}
                  color={currentMonthProgress.completion_vs_monthly >= 1 ? 'emerald' : currentMonthProgress.completion_vs_monthly >= 0.8 ? 'amber' : 'sky'}
                  trendLabel={`目标 ${currencySymbol}${formatMoney(currentMonthProgress.target_amount)}`}
                />
                <StatCard
                  title='日均完成率'
                  value={formatPercent(currentMonthProgress.completion_vs_daily)}
                  icon={<Calendar className='h-4 w-4' />}
                  color={currentMonthProgress.completion_vs_daily >= 1 ? 'emerald' : currentMonthProgress.completion_vs_daily >= 0.8 ? 'amber' : 'sky'}
                  trendLabel={`累计目标 ${currencySymbol}${formatMoney(currentMonthProgress.cumulative_daily_target)}`}
                />
                <StatCard
                  title='日目标'
                  value={`${currencySymbol}${formatMoney(currentMonthProgress.daily_target)}`}
                  icon={<DollarSign className='h-4 w-4' />}
                  color='amber'
                  trendLabel={`第 ${currentMonthProgress.today_day} / ${currentMonthProgress.days_in_month} 天`}
                />
                {annualProgress ? (
                  <StatCard
                    title='年度完成率'
                    value={formatPercent(annualProgress.completion_rate)}
                    icon={<TrendingUp className='h-4 w-4' />}
                    color={annualProgress.completion_rate >= 1 ? 'emerald' : annualProgress.completion_rate >= 0.8 ? 'amber' : 'rose'}
                    trendLabel={`目标 ${currencySymbol}${formatMoney(annualProgress.target_amount)}`}
                  />
                ) : (
                  <div className='dashboard-surface hover-lift flex flex-col items-center justify-center gap-2 rounded-xl p-4 text-center'>
                    <AlertCircle className='h-6 w-6 text-muted-foreground/50' />
                    <p className='text-sm text-muted-foreground'>未设置年度目标</p>
                    <Button size='sm' variant='outline' onClick={() => openCreateDialog('annual')}>
                      <Plus className='mr-1 h-3 w-3' /> 设置年度目标
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tabs: Progress Table + Goal Management */}
          <Tabs defaultValue='progress' className='space-y-4'>
            <TabsList>
              <TabsTrigger value='progress'>进度概览</TabsTrigger>
              <TabsTrigger value='goals'>目标管理</TabsTrigger>
            </TabsList>

            <TabsContent value='progress' className='space-y-4'>
              {/* 12-Month Progress Table */}
              <DataTableCard>
                <DataTableCardHeader
                  title='月度进度表'
                  description={`${selectedYear} 年各月销售目标完成情况`}
                />
                <DataTableCardBody className='p-0'>
                  <Table className='table-fixed rounded-none'>
                    <TableHeader>
                      <TableRow>
                        <TableHead className='w-[12.5%]'>月份</TableHead>
                        <TableHead className='w-[12.5%] text-right'>目标金额</TableHead>
                        <TableHead className='w-[12.5%] text-right'>已完成</TableHead>
                        <TableHead className='w-[37.5%]'>月度完成进度</TableHead>
                        <TableHead className='w-[12.5%] text-center'>状态</TableHead>
                        <TableHead className='w-[12.5%] text-center'>运营（包含助理）</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {progressData?.monthly_progress.map(m => {
                        const monthStatus: 'past' | 'current' | 'future' = m.year < currentYear ? 'past' : m.year > currentYear ? 'future' : m.month < currentMonth ? 'past' : m.month > currentMonth ? 'future' : 'current'
                        const isPastIncomplete = monthStatus === 'past' && m.completion_vs_monthly < 1
                        return (
                          <TableRow key={m.month} className={m.month === currentMonth ? 'bg-blue-50/50' : ''}>
                            <TableCell className='font-medium'>
                              {m.month === currentMonth ? (
                                <span className='text-blue-600'>{m.month_label}（本月）</span>
                              ) : (
                                m.month_label
                              )}
                            </TableCell>
                            <TableCell className='text-right'>
                              {m.target_amount > 0 ? `${currencySymbol} ${formatMoney(m.target_amount)}` : '—'}
                            </TableCell>
                            <TableCell className='text-right'>
                              {currencySymbol} {formatMoney(m.achieved_amount)}
                            </TableCell>
                            <TableCell>
                              {m.target_amount > 0 ? (
                                <div className='space-y-1'>
                                  <ProgressBar value={m.completion_vs_monthly} isPastIncomplete={isPastIncomplete} />
                                  <div className='flex justify-between text-xs text-muted-foreground'>
                                    <span>{formatPercent(m.completion_vs_monthly)}</span>
                                    <span>
                                      {currencySymbol} {formatMoney(m.achieved_amount)} / {currencySymbol} {formatMoney(m.target_amount)}
                                    </span>
                                  </div>
                                </div>
                              ) : (
                                <span className='text-muted-foreground'>未设目标</span>
                              )}
                            </TableCell>
                            <TableCell className='text-center'>
                              {m.target_amount > 0 ? (
                                <CompletionBadge rate={m.completion_vs_monthly} monthStatus={monthStatus} />
                              ) : null}
                            </TableCell>
                            <TableCell className='text-center'>
                              {getOperatorsDisplay(selectedProjectId, projects)}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </DataTableCardBody>
              </DataTableCard>
            </TabsContent>

            <TabsContent value='goals' className='space-y-4'>
              {/* Monthly Goals Table */}
              <DataTableCard>
                <DataTableCardHeader
                  title='月度目标'
                  description={`${selectedYear} 年各月销售目标（点击编辑或删除）`}
                  action={
                    <Button size='sm' onClick={() => openCreateDialog('monthly')}>
                      <Plus className='mr-1 h-3 w-3' /> 新增月度目标
                    </Button>
                  }
                />
                <DataTableCardBody className='p-0'>
                  <Table className='table-fixed rounded-none'>
                    <TableHeader>
                      <TableRow>
                        <TableHead className='w-[12.5%]'>月份</TableHead>
                        <TableHead className='w-[12.5%] text-right'>目标金额</TableHead>
                        <TableHead className='w-[12.5%] text-right'>已达成</TableHead>
                        <TableHead className='w-[37.5%]'>月度进度</TableHead>
                        <TableHead className='w-[12.5%] text-center'>状态</TableHead>
                        <TableHead className='w-[12.5%] text-right'>操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...Array(12)].map((_, idx) => {
                        const month = idx + 1
                        const goal = goalsData.find(g => g.goal_type === 'monthly' && g.period_month === month)
                        const progress = progressData?.monthly_progress.find(m => m.month === month)
                        const hasGoal = goal !== undefined
                        const monthStatus: 'past' | 'current' | 'future' = Number(selectedYear) < currentYear ? 'past' : Number(selectedYear) > currentYear ? 'future' : month < currentMonth ? 'past' : month > currentMonth ? 'future' : 'current'
                        const isPastIncomplete = monthStatus === 'past' && (progress ? progress.completion_vs_monthly < 1 : true)
                        return (
                          <TableRow key={month} className={month === currentMonth ? 'bg-blue-50/50' : ''}>
                            <TableCell className='font-medium'>
                              {month === currentMonth ? (
                                <span className='text-blue-600'>{selectedYear}年{MONTH_NAMES[idx]}（本月）</span>
                              ) : (
                                <span>{selectedYear}年{MONTH_NAMES[idx]}</span>
                              )}
                            </TableCell>
                            <TableCell className='text-right'>
                              {hasGoal ? `${currencySymbol} ${formatMoney(goal!.target_amount)}` : (
                                <span className='text-muted-foreground'>—</span>
                              )}
                            </TableCell>
                            <TableCell className='text-right'>
                              {currencySymbol} {formatMoney(progress?.achieved_amount ?? 0)}
                            </TableCell>
                            <TableCell>
                              {hasGoal && goal!.target_amount > 0 && progress ? (
                                <div className='space-y-1'>
                                  <ProgressBar value={progress.completion_vs_monthly} isPastIncomplete={isPastIncomplete} />
                                  <div className='text-xs text-muted-foreground'>{formatPercent(progress.completion_vs_monthly)}</div>
                                </div>
                              ) : (
                                <span className='text-muted-foreground'>—</span>
                              )}
                            </TableCell>
                            <TableCell className='text-center'>
                              {hasGoal && progress ? (
                                <CompletionBadge rate={progress.completion_vs_monthly} monthStatus={monthStatus} />
                              ) : null}
                            </TableCell>
                            <TableCell className='text-right'>
                              {hasGoal ? (
                                <div className='flex justify-end gap-1'>
                                  <Button
                                    size='sm'
                                    variant='ghost'
                                    onClick={() => openEditDialog(goal!)}
                                    className='h-7 px-2'
                                  >
                                    <Pencil className='h-3 w-3' />
                                  </Button>
                                  <Button
                                    size='sm'
                                    variant='ghost'
                                    onClick={() => handleDelete(goal!)}
                                    className='h-7 px-2 text-destructive'
                                  >
                                    <Trash2 className='h-3 w-3' />
                                  </Button>
                                </div>
                              ) : (
                                <Button
                                  size='sm'
                                  variant='ghost'
                                  onClick={() => openCreateDialog('monthly', month)}
                                  className='h-7 px-2'
                                >
                                  <Plus className='h-3 w-3' />
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </DataTableCardBody>
              </DataTableCard>
            </TabsContent>
          </Tabs>
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingGoal ? '编辑目标' : `新增 ${formData.goal_type === 'monthly' ? '月度' : '年度'}目标`}
            </DialogTitle>
          </DialogHeader>
          <div className='space-y-4 py-2'>
            <div className='space-y-2'>
              <label className='text-sm font-medium'>
                {formData.goal_type === 'monthly' ? '目标月份' : '目标年份'}
              </label>
              <div className='rounded-md bg-muted/50 px-3 py-2 text-sm'>
                {formData.goal_type === 'monthly'
                  ? `${selectedYear} 年 ${formData.period_month} 月`
                  : `${selectedYear} 年`}
              </div>
            </div>
            <div className='space-y-2'>
              <label className='text-sm font-medium'>目标金额（{currencySymbol} {currency}）</label>
              <Input
                type='number'
                min='0'
                step='0.01'
                placeholder='例如：50000'
                value={formData.target_amount}
                onChange={e => setFormData(f => ({ ...f, target_amount: e.target.value }))}
              />
              <p className='text-xs text-muted-foreground'>
                填入该月/年度的销售目标金额（按站点原始货币）
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant='outline' onClick={() => setDialogOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving || !formData.target_amount}>
              {saving ? <Loader2 className='mr-2 h-4 w-4 animate-spin' /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
