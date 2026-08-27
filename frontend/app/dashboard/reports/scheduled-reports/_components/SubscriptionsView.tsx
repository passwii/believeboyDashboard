'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Loader2, Plus, Power, Pencil, Trash2, Inbox } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTable,
  TermTHead,
} from '@/components/terminal/term-table'
import { TermPanel } from '@/components/terminal/term-panel'
import { cn } from '@/lib/utils'
import { getCountryLabel, COUNTRY_OPTIONS } from '@/lib/country'
import { useConfirm } from '@/hooks/use-confirm'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import type { Frequency, Subscription, AIModelConfig } from './types'
import {
  authHeaders,
  fetchModelConfig,
  resolveApiUrl,
  resolveProjectNames,
  formatProjectNames,
  deleteSubscription,
  toggleSubscription,
} from './api'
import { CreateSubscriptionDialog } from './CreateSubscriptionDialog'
import { EditSubscriptionDialog } from './EditSubscriptionDialog'
import {
  TERM_BUTTON,
  TERM_INPUT,
  TERM_SELECT_ITEM,
  TERM_TRIGGER,
  TermFrequencyTag,
  TermStatusPill,
} from './term-shared'

const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}

export default function SubscriptionsView() {
  const { data: session } = useSession()
  const { confirm } = useConfirm()

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
  const initialLoadDone = useRef(false)

  // BEL-422：模型配置只服务于新增/编辑弹窗的 AI 模型下拉，首次打开弹窗时才拉取，
  // 不再随页面 mount 无条件请求（削减首屏并发请求）。
  const ensureModelConfig = useCallback(() => {
    if (modelConfigRequested.current) return
    modelConfigRequested.current = true
    setIsLoadingModelConfig(true)
    fetchModelConfig((cfg) => {
      setModelConfig(cfg)
      setIsLoadingModelConfig(false)
    })
  }, [])

  const refreshSubscriptions = useCallback(async () => {
    try {
      const [subRes, projectData] = await Promise.all([
        fetch(resolveApiUrl('/api/v1/scheduled-reports/subscriptions'), { headers: authHeaders() }),
        fetchManagedProjectsCached<Array<{ id?: number | null; name: string }>>(session),
      ])
      const subs = subRes.ok ? await subRes.json() : { items: [] }
      setSubscriptions(subs.items || [])
      setProjects(
        projectData.filter((p: { name: string }) => typeof p.name === 'string' && p.name.trim())
      )
    } catch (e) {
      console.error(e)
    }
  }, [session])

  useEffect(() => {
    const loadData = async () => {
      const isInitial = !initialLoadDone.current
      if (isInitial) setLoading(true)
      try {
        const [subRes, projectData] = await Promise.all([
          fetch(resolveApiUrl('/api/v1/scheduled-reports/subscriptions'), {
            headers: authHeaders(),
          }),
          fetchManagedProjectsCached<Array<{ id?: number | null; name: string }>>(session),
        ])
        const subs = subRes.ok ? await subRes.json() : { items: [] }
        setSubscriptions(subs.items || [])
        setProjects(
          projectData.filter((p: { name: string }) => typeof p.name === 'string' && p.name.trim())
        )
      } catch (e) {
        console.error(e)
      } finally {
        if (isInitial) {
          setLoading(false)
          initialLoadDone.current = true
        }
      }
    }
    void loadData()
  }, [session])

  // 过滤后的订阅列表
  const filteredSubscriptions = subscriptions.filter((sub) => {
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
    if (filterStatus !== 'all') {
      const isEnabled = sub.enabled
      if (filterStatus === 'enabled' && !isEnabled) return false
      if (filterStatus === 'disabled' && isEnabled) return false
    }
    return true
  })

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
      setSubscriptions((prev) =>
        prev.map((s) => (s.id === sub.id ? { ...s, enabled: !s.enabled } : s))
      )
    }
  }

  const roleType = session?.user?.roleType
  const canManage = roleType === 'admin' || roleType === 'operator'

  if (loading) {
    return (
      <TermPanel title="订阅管理">
        <div className="space-y-3 p-3">
          <Skeleton className="h-8 w-full rounded-none bg-term-raised" />
          <Skeleton className="h-8 w-full rounded-none bg-term-raised" />
          <Skeleton className="h-8 w-full rounded-none bg-term-raised" />
          <Skeleton className="h-8 w-3/4 rounded-none bg-term-raised" />
        </div>
      </TermPanel>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <TermPanel
        title="订阅管理"
        actions={
          canManage ? (
            <button type="button" onClick={handleOpenCreateDialog} className={TERM_BUTTON}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              新增订阅
            </button>
          ) : null
        }
      >
          {/* 工具栏（BLF-817 Console 规格） */}
          <div className="border-b border-term-border p-1.5">
            {/* 桌面端 */}
            <div className="hidden flex-wrap items-center gap-1.5 md:flex">
              <Select value={filterFrequency} onValueChange={setFilterFrequency}>
                <SelectTrigger className={cn(TERM_TRIGGER, 'w-[110px]')}>
                  <SelectValue placeholder="频率" />
                </SelectTrigger>
                <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
                  <SelectItem value="all" className={TERM_SELECT_ITEM}>全部频率</SelectItem>
                  <SelectItem value="daily" className={TERM_SELECT_ITEM}>每日</SelectItem>
                  <SelectItem value="weekly" className={TERM_SELECT_ITEM}>每周</SelectItem>
                  <SelectItem value="monthly" className={TERM_SELECT_ITEM}>每月</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterProject} onValueChange={setFilterProject}>
                <SelectTrigger className={cn(TERM_TRIGGER, 'w-[150px]')}>
                  <SelectValue placeholder="项目" />
                </SelectTrigger>
                <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
                  <SelectItem value="all" className={TERM_SELECT_ITEM}>全部项目</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id?.toString() || p.name} value={p.id?.toString() || ''} className={TERM_SELECT_ITEM}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterCountry} onValueChange={setFilterCountry}>
                <SelectTrigger className={cn(TERM_TRIGGER, 'w-[110px]')}>
                  <SelectValue placeholder="国家" />
                </SelectTrigger>
                <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
                  <SelectItem value="all" className={TERM_SELECT_ITEM}>全部国家</SelectItem>
                  {COUNTRY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className={TERM_SELECT_ITEM}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className={cn(TERM_TRIGGER, 'w-[110px]')}>
                  <SelectValue placeholder="状态" />
                </SelectTrigger>
                <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
                  <SelectItem value="all" className={TERM_SELECT_ITEM}>全部状态</SelectItem>
                  <SelectItem value="enabled" className={TERM_SELECT_ITEM}>启用</SelectItem>
                  <SelectItem value="disabled" className={TERM_SELECT_ITEM}>已暂停</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="筛选邮箱"
                value={filterEmail}
                onChange={(e) => setFilterEmail(e.target.value)}
                className={cn(TERM_INPUT, 'w-[180px]')}
              />
            </div>
            {/* 手机端 */}
            <div className="grid grid-cols-2 gap-1.5 md:hidden">
              <Select value={filterFrequency} onValueChange={setFilterFrequency}>
                <SelectTrigger className={TERM_TRIGGER}>
                  <SelectValue placeholder="频率" />
                </SelectTrigger>
                <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
                  <SelectItem value="all" className={TERM_SELECT_ITEM}>全部</SelectItem>
                  <SelectItem value="daily" className={TERM_SELECT_ITEM}>每日</SelectItem>
                  <SelectItem value="weekly" className={TERM_SELECT_ITEM}>每周</SelectItem>
                  <SelectItem value="monthly" className={TERM_SELECT_ITEM}>每月</SelectItem>
                </SelectContent>
              </Select>
              <Select value={filterProject} onValueChange={setFilterProject}>
                <SelectTrigger className={TERM_TRIGGER}>
                  <SelectValue placeholder="项目" />
                </SelectTrigger>
                <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
                  <SelectItem value="all" className={TERM_SELECT_ITEM}>全部项目</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id?.toString() || p.name} value={p.id?.toString() || ''} className={TERM_SELECT_ITEM}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterCountry} onValueChange={setFilterCountry}>
                <SelectTrigger className={TERM_TRIGGER}>
                  <SelectValue placeholder="国家" />
                </SelectTrigger>
                <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
                  <SelectItem value="all" className={TERM_SELECT_ITEM}>全部国家</SelectItem>
                  {COUNTRY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className={TERM_SELECT_ITEM}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className={TERM_TRIGGER}>
                  <SelectValue placeholder="状态" />
                </SelectTrigger>
                <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
                  <SelectItem value="all" className={TERM_SELECT_ITEM}>全部状态</SelectItem>
                  <SelectItem value="enabled" className={TERM_SELECT_ITEM}>启用</SelectItem>
                  <SelectItem value="disabled" className={TERM_SELECT_ITEM}>已暂停</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="筛选邮箱"
                value={filterEmail}
                onChange={(e) => setFilterEmail(e.target.value)}
                className={cn(TERM_INPUT, 'col-span-2')}
              />
            </div>
          </div>

          {/* 订阅列表 */}
          {subscriptions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Inbox className="mb-3 h-10 w-10 text-term-faint" />
              <p className="mb-1 font-mono text-sm text-term-muted">暂无订阅配置</p>
              <p className="mb-4 text-xs text-term-faint">
                {canManage ? '点击右上角「新增订阅」创建第一个配置' : '暂无可用订阅配置'}
              </p>
            </div>
          ) : (
            <>
              {/* 桌面端表格 */}
              <div className="hidden overflow-x-auto md:block">
                <TermTable aria-label="订阅列表">
                  <TermTHead>
                    <TermRow>
                      <TermHead>项目</TermHead>
                      <TermHead>国家</TermHead>
                      <TermHead>频率</TermHead>
                      <TermHead>发送时间</TermHead>
                      <TermHead>邮箱</TermHead>
                      <TermHead>状态</TermHead>
                      <TermHead>AI 模型</TermHead>
                      <TermHead numeric>操作</TermHead>
                    </TermRow>
                  </TermTHead>
                  <TermBody>
                    {filteredSubscriptions.map((sub) => {
                      const names = resolveProjectNames(sub.project_ids, projects)
                      const { display, full } = formatProjectNames(names)
                      const weekdayLabel =
                        sub.frequency === 'weekly'
                          ? ` 周${['一', '二', '三', '四', '五', '六', '日'][sub.dispatch_weekday ?? 0]}`
                          : ''
                      const dayLabel =
                        sub.frequency === 'monthly' ? ` ${sub.dispatch_day ?? 2}日` : ''
                      return (
                        <TermRow key={sub.id}>
                          <TermCell title={full} className="max-w-[140px] truncate font-medium">
                            {display}
                          </TermCell>
                          <TermCell tone="muted" className="whitespace-nowrap">
                            {sub.country
                              .split(',')
                              .map((c) => c.trim())
                              .filter(Boolean)
                              .map(getCountryLabel)
                              .join(' · ')}
                          </TermCell>
                          <TermCell>
                            <TermFrequencyTag frequency={sub.frequency} labels={FREQUENCY_LABELS} />
                          </TermCell>
                          <TermCell tone="muted" numeric className="tabular-nums">
                            {sub.dispatch_hour.toString().padStart(2, '0')}:
                            {sub.dispatch_minute.toString().padStart(2, '0')}
                            {weekdayLabel}
                            {dayLabel}
                          </TermCell>
                          <TermCell tone="muted" title={sub.email || ''} className="max-w-[160px] truncate">
                            {sub.email || <span className="italic text-term-faint">未填写</span>}
                          </TermCell>
                          <TermCell>
                            {sub.enabled ? (
                              <TermStatusPill status="sent" label="启用" />
                            ) : (
                              <span className="font-mono text-[11px] text-term-faint">已暂停</span>
                            )}
                          </TermCell>
                          <TermCell tone="muted" className="max-w-[140px] truncate text-xs">
                            {sub.ai_model || '—'}
                          </TermCell>
                          <TermCell numeric>
                            <div className="flex gap-1 justify-end">
                              {canManage && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleToggle(sub)}
                                    title={sub.enabled ? '暂停' : '启用'}
                                    aria-label={sub.enabled ? '暂停' : '启用'}
                                    className="flex h-7 w-7 items-center justify-center border border-transparent text-term-muted transition-colors hover:border-term-border hover:text-term-text disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    <Power className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleEdit(sub)}
                                    title="编辑"
                                    aria-label="编辑订阅"
                                    className="flex h-7 w-7 items-center justify-center border border-transparent text-term-muted transition-colors hover:border-term-border hover:text-term-text"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDelete(sub.id)}
                                    title="删除"
                                    aria-label="删除订阅"
                                    className="flex h-7 w-7 items-center justify-center border border-transparent text-term-muted transition-colors hover:border-term-neg/50 hover:text-term-neg"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </TermCell>
                        </TermRow>
                      )
                    })}
                  </TermBody>
                </TermTable>
              </div>
              {/* 手机端卡片列表 */}
              <div className="divide-y divide-term-border md:hidden">
                {filteredSubscriptions.map((sub) => {
                  const names = resolveProjectNames(sub.project_ids, projects)
                  const { display, full } = formatProjectNames(names)
                  const weekdayLabel =
                    sub.frequency === 'weekly'
                      ? ` 周${['一', '二', '三', '四', '五', '六', '日'][sub.dispatch_weekday ?? 0]}`
                      : ''
                  const dayLabel = sub.frequency === 'monthly' ? ` ${sub.dispatch_day ?? 2}日` : ''
                  return (
                    <div key={sub.id} className="p-3">
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium" title={full}>
                            {display}
                          </div>
                          <div className="mt-0.5 font-mono text-xs tabular-nums text-term-muted">
                            {sub.dispatch_hour.toString().padStart(2, '0')}:
                            {sub.dispatch_minute.toString().padStart(2, '0')}
                            {weekdayLabel}
                            {dayLabel}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <TermFrequencyTag frequency={sub.frequency} labels={FREQUENCY_LABELS} />
                          {sub.enabled ? (
                            <TermStatusPill status="sent" label="启用" />
                          ) : (
                            <span className="font-mono text-[11px] text-term-faint">已暂停</span>
                          )}
                        </div>
                      </div>
                      <div className="mb-2 font-mono text-xs text-term-muted">
                        {sub.country
                          .split(',')
                          .map((c) => c.trim())
                          .filter(Boolean)
                          .map(getCountryLabel)
                          .join(' · ')}
                      </div>
                      <div
                        className="mb-2 truncate font-mono text-xs text-term-muted"
                        title={sub.email || ''}
                      >
                        {sub.email || '未填写邮箱'}
                      </div>
                      {sub.ai_model && (
                        <div className="mb-2 font-mono text-xs text-term-faint">
                          AI: {sub.ai_model}
                        </div>
                      )}
                      {canManage && (
                        <div className="grid grid-cols-3 gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleToggle(sub)}
                            className={cn(TERM_BUTTON, 'justify-center px-1 text-xs')}
                          >
                            <Power className="h-3.5 w-3.5 shrink-0" aria-hidden />
                            {sub.enabled ? '暂停' : '启用'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleEdit(sub)}
                            className={cn(TERM_BUTTON, 'justify-center px-1 text-xs')}
                          >
                            <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden />
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(sub.id)}
                            className="flex h-8 items-center justify-center gap-1 rounded-none border border-term-border bg-term-panel font-mono text-xs leading-5 text-term-neg shadow-none transition-colors hover:border-term-neg/60 hover:bg-term-hover focus-visible:outline-none focus-visible:border-term-neg/60"
                          >
                            <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                            删除
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
      </TermPanel>

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
