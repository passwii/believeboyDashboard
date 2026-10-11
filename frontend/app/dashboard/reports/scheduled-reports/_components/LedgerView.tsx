'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { format } from 'date-fns'
import { Loader2, RotateCcw, Sparkles } from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { TermPanel } from '@/components/terminal/term-panel'
import { DateRangePicker, parseDateRangeInputValue, parseDateInputValue } from '@/components/ui/date-picker'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/components/notifications'
import type { DateRange } from 'react-day-picker'
import type { LedgerItem, ResendStage, Subscription } from './types'
import {
  fetchLedger,
  fetchLedgerItemByKey,
  fetchModelConfig,
  fetchSubscriptions,
  pollDeliveryLogStatus,
  pollLedgerAiSummaryStatus,
  regenerateLedgerAiSummary,
  resendLedgerEntry,
} from './api'
import { LedgerResendCell } from './LedgerResendCell'
import { LedgerDayGroup } from './LedgerDayGroup'
import { LedgerDetailDialog } from './LedgerDetailDialog'
import {
  TERM_BUTTON,
  TERM_INPUT,
  TERM_SELECT_ITEM,
  TERM_TRIGGER,
  TermFrequencyTag,
  TermStatusPill,
} from './term-shared'
import type { AIModelConfig } from './types'

const FREQUENCY_LABELS: Record<string, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}

export default function LedgerView({
  onRefreshReady,
}: {
  onRefreshReady?: (refresh: () => Promise<void>) => void
}) {
  const { data: session } = useSession()
  const { notify } = useNotifications()

  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [modelConfig, setModelConfig] = useState<AIModelConfig | null>(null)
  const [isLoadingModelConfig, setIsLoadingModelConfig] = useState(false)
  // BEL-422：模型配置与订阅列表只服务于重发/详情交互（模型下拉、订阅 ai_model
  // 回退），首次交互时才拉取，不再随 mount 无条件请求。台账行渲染所需的
  // 项目名/国家/邮箱均在 ledger item 自身，不受影响。
  const modelConfigRequested = useRef(false)
  const subscriptionsRequested = useRef(false)
  const [ledgerItems, setLedgerItems] = useState<LedgerItem[]>([])
  // 初始为 true：tab 切换重新挂载时立即显示骨架屏，避免先闪「暂无台账记录」空状态。
  const [ledgerLoading, setLedgerLoading] = useState(true)
  const [ledgerError, setLedgerError] = useState<string | null>(null)
  // 后端按 expected_at DESC 截断到 limit 条；记录总数（可能 > 已加载条数）。
  const [ledgerTotal, setLedgerTotal] = useState(0)
  const [resendingStates, setResendingStates] = useState<Record<string, ResendStage>>({})
  const [regeneratingSummaryKeys, setRegeneratingSummaryKeys] = useState<Set<string>>(new Set())
  const [selectedItem, setSelectedItem] = useState<LedgerItem | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const today = new Date()
  const sevenDaysAgo = new Date(today)
  sevenDaysAgo.setDate(today.getDate() - 6)

  const [ledgerStartDate, setLedgerStartDate] = useState(format(sevenDaysAgo, 'yyyy-MM-dd'))
  const [ledgerEndDate, setLedgerEndDate] = useState(format(today, 'yyyy-MM-dd'))
  const [ledgerFrequency, setLedgerFrequency] = useState<string>('all')
  const [ledgerStatus, setLedgerStatus] = useState<string>('all')
  const [ledgerEmail, setLedgerEmail] = useState('')
  const initialLoadDone = useRef(false)

  // 按 expected_date 分组（后端已按 yyyy-MM-dd 返回）
  const groupedByDay = useMemo(() => {
    const buckets: Record<string, LedgerItem[]> = {}
    for (const item of ledgerItems) {
      ;(buckets[item.expected_date] ??= []).push(item)
    }
    return Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => b.localeCompare(a)))
  }, [ledgerItems])

  // 展开状态
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())

  // 末日展开锚点（仅当 ledgerStartDate / ledgerEndDate 变化时重置）
  const todayStr = format(new Date(), 'yyyy-MM-dd')
  useEffect(() => {
    if (!ledgerEndDate) return
    setExpandedDates(new Set([ledgerEndDate]))
  }, [ledgerStartDate, ledgerEndDate])

  const toggleDate = useCallback((date: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }, [])

  const handleLedgerDateRangeChange = (range: DateRange | undefined) => {
    setLedgerStartDate(range?.from ? format(range.from, 'yyyy-MM-dd') : '')
    setLedgerEndDate(range?.to ? format(range.to, 'yyyy-MM-dd') : '')
  }

  const ledgerDateRangeValue = useMemo(
    () => parseDateRangeInputValue(ledgerStartDate, ledgerEndDate),
    [ledgerStartDate, ledgerEndDate]
  )

  const ensureModelConfig = useCallback(() => {
    if (modelConfigRequested.current) return
    modelConfigRequested.current = true
    setIsLoadingModelConfig(true)
    fetchModelConfig((cfg) => {
      setModelConfig(cfg)
      setIsLoadingModelConfig(false)
    })
  }, [])

  const ensureSubscriptions = useCallback(() => {
    if (subscriptionsRequested.current) return
    subscriptionsRequested.current = true
    fetchSubscriptions(session, (subs) => setSubscriptions(subs))
  }, [session])

  // 重发 / 重新生成 / 打开详情 都可能需要模型配置与订阅信息，统一在交互入口预热
  const ensureInteractionData = useCallback(() => {
    ensureModelConfig()
    ensureSubscriptions()
  }, [ensureModelConfig, ensureSubscriptions])

  const loadLedger = useCallback(async () => {
    setLedgerLoading(true)
    setLedgerError(null)
    // 后端 ledger 接口已改为「按天分页」：limit 解释为「最近多少天」，
    // 保证范围内每一天都完整返回（不会因行数上限把某一天整段截断）。
    // 这里按时间范围的天数传 limit 即可（后端上限 500 天，UI 预设最多 90 天）。
    const start = parseDateInputValue(ledgerStartDate)
    const end = parseDateInputValue(ledgerEndDate)
    const daysInRange = start && end
      ? Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1)
      : 14
    const ledgerLimit = Math.min(500, Math.max(1, daysInRange))
    await fetchLedger(
      {
        startDate: ledgerStartDate,
        endDate: ledgerEndDate,
        frequency: ledgerFrequency,
        statusFilter: ledgerStatus,
        email: ledgerEmail,
        limit: ledgerLimit,
      },
      (items, _summary, total) => {
        setLedgerItems(items)
        setLedgerTotal(total ?? items.length)
      },
      (error) => setLedgerError(error)
    )
    setLedgerLoading(false)
  }, [ledgerStartDate, ledgerEndDate, ledgerFrequency, ledgerStatus, ledgerEmail])

  useEffect(() => {
    void loadLedger()
    initialLoadDone.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!initialLoadDone.current) return
    void loadLedger()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerStartDate, ledgerEndDate, ledgerFrequency, ledgerStatus])

  useEffect(() => {
    if (!initialLoadDone.current) return
    const handle = setTimeout(() => void loadLedger(), 400)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerEmail])

  useEffect(() => {
    onRefreshReady?.(loadLedger)
  }, [loadLedger, onRefreshReady])

  const roleType = session?.user?.roleType
  const isAdmin = roleType === 'admin'
  const canTriggerResend = isAdmin

  const mergeLedgerItem = (nextItem: LedgerItem) => {
    setLedgerItems((prev) =>
      prev.map((item) => (item.ledger_key === nextItem.ledger_key ? nextItem : item))
    )
    setSelectedItem((prev) => (prev?.ledger_key === nextItem.ledger_key ? nextItem : prev))
  }

  const handleResendLedger = async (item: LedgerItem, overrideAiModel?: string | null) => {
    ensureInteractionData()
    setResendingStates((prev) => ({ ...prev, [item.ledger_key]: 'preparing' }))
    const result = await resendLedgerEntry(item.ledger_key, isAdmin, overrideAiModel)
    if (result.ok && result.deliveryLogId) {
      pollDeliveryLogStatus(
        item.ledger_key,
        result.deliveryLogId,
        (key, stage) => setResendingStates((prev) => ({ ...prev, [key]: stage as ResendStage })),
        async (key) => {
          await loadLedger()
          setTimeout(() => {
            setResendingStates((prev) => {
              const next = { ...prev }
              delete next[key]
              return next
            })
          }, 1500)
        },
        (key) => {
          setResendingStates((prev) => {
            const next = { ...prev }
            delete next[key]
            return next
          })
        }
      )
    } else if (!result.ok) {
      setResendingStates((prev) => {
        const next = { ...prev }
        delete next[item.ledger_key]
        return next
      })
      notify({ type: 'error', title: '操作失败', message: result.error || '未知错误' })
    } else {
      setResendingStates((prev) => {
        const next = { ...prev }
        delete next[item.ledger_key]
        return next
      })
      await loadLedger()
    }
  }

  const handleRegenerateAiSummary = async (item: LedgerItem, overrideAiModel?: string | null) => {
    ensureInteractionData()
    // 防止重复点：若同一 ledger_key 已经在 regenerate 流程中，直接短路掉。
    // （用户从台账「打断并重新生成」入口连点时尤其需要这层防护，避免后端
    // 接连两次 enqueue 产生两个并行生成线程。）
    let alreadyInFlight = false
    setRegeneratingSummaryKeys((prev) => {
      if (prev.has(item.ledger_key)) {
        alreadyInFlight = true
        return prev
      }
      const next = new Set(prev)
      next.add(item.ledger_key)
      return next
    })
    if (alreadyInFlight) return
    mergeLedgerItem({
      ...item,
      ai_summary_status: 'generating',
      ai_summary_error: null,
      ai_summary_model: overrideAiModel?.trim() || item.ai_summary_model,
    })

    const result = await regenerateLedgerAiSummary(item.ledger_key, overrideAiModel)
    if (!result.ok) {
      setRegeneratingSummaryKeys((prev) => {
        const next = new Set(prev)
        next.delete(item.ledger_key)
        return next
      })
      // 把乐观更新的 'generating' 回滚到真实状态，避免 UI 一直停留在 spinning
      try {
        const fresh = await fetchLedgerItemByKey(item)
        if (fresh) mergeLedgerItem(fresh)
      } catch {
        // 静默：notif 已告诉用户失败；UI 维持现状即可，下次轮询会修正
      }
      notify({ type: 'error', title: 'AI 摘要生成失败', message: result.error || '未知错误' })
      return
    }

    // BLF-1015：后端返回 run 绑定时，详情弹窗直接接管该 run 的共享 Insight
    // 流，这里不再重复轮询——否则同一 delivery 会被两个来源写入。
    if (result.runId) {
      mergeLedgerItem({ ...item, insight_run_id: result.runId, ai_summary_status: 'generating' })
      setRegeneratingSummaryKeys((prev) => {
        const next = new Set(prev)
        next.delete(item.ledger_key)
        return next
      })
      notify({ type: 'success', title: 'AI 摘要生成已启动' })
      return
    }

    pollLedgerAiSummaryStatus(
      item.ledger_key,
      () => fetchLedgerItemByKey(item),
      mergeLedgerItem,
      (doneItem) => {
        mergeLedgerItem(doneItem)
        setRegeneratingSummaryKeys((prev) => {
          const next = new Set(prev)
          next.delete(item.ledger_key)
          return next
        })
        notify({ type: 'success', title: 'AI 摘要已更新' })
      },
      (failedItem) => {
        if (failedItem) mergeLedgerItem(failedItem)
        setRegeneratingSummaryKeys((prev) => {
          const next = new Set(prev)
          next.delete(item.ledger_key)
          return next
        })
        notify({
          type: 'error',
          title: 'AI 摘要生成失败',
          message: failedItem?.ai_summary_error || '请稍后重试',
        })
      }
    )
  }

  const openDetail = (item: LedgerItem) => {
    ensureInteractionData()
    setSelectedItem(item)
    setDetailOpen(true)
  }

  // BLF-822：行内快捷生成——不带模型覆盖，走订阅预设/后端默认模型；
  // 需要指定模型的场景走详情弹窗里的入口。
  const handleQuickRegenerateSummary = (item: LedgerItem) => {
    void handleRegenerateAiSummary(item, null)
  }

  return (
    <div className="space-y-3">
      {/* 工具栏（BLF-817 Console 规格） */}
      <TermPanel title="调度记录">
        <div className="border-b border-term-border p-1.5">
          <div className="hidden flex-wrap items-center gap-1.5 md:flex">
            <DateRangePicker
              value={ledgerDateRangeValue}
              onChange={handleLedgerDateRangeChange}
              className="h-10 w-[240px] justify-start rounded-none border-term-border bg-term-bg px-2 text-left font-mono text-xs font-normal text-term-text"
            />
            <Select value={ledgerFrequency} onValueChange={setLedgerFrequency}>
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
            <Select value={ledgerStatus} onValueChange={setLedgerStatus}>
              <SelectTrigger className={cn(TERM_TRIGGER, 'w-[110px]')}>
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
                <SelectItem value="all" className={TERM_SELECT_ITEM}>全部状态</SelectItem>
                <SelectItem value="sent" className={TERM_SELECT_ITEM}>成功</SelectItem>
                <SelectItem value="failed" className={TERM_SELECT_ITEM}>失败</SelectItem>
                <SelectItem value="missing" className={TERM_SELECT_ITEM}>缺失</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="邮箱筛选"
              value={ledgerEmail}
              onChange={(e) => setLedgerEmail(e.target.value)}
              className={cn(TERM_INPUT, 'w-[180px]')}
            />
            <button
              type="button"
              onClick={loadLedger}
              disabled={ledgerLoading}
              className={cn(TERM_BUTTON, 'ml-auto')}
            >
              {ledgerLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              )}
              刷新台账
            </button>
          </div>
          <div className="space-y-1.5 md:hidden">
            <DateRangePicker
              value={ledgerDateRangeValue}
              onChange={handleLedgerDateRangeChange}
              className="h-10 w-full justify-start rounded-none border-term-border bg-term-bg px-2 text-left font-mono text-xs font-normal text-term-text"
            />
            <div className="grid grid-cols-2 gap-1.5">
              <Select value={ledgerFrequency} onValueChange={setLedgerFrequency}>
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
              <Select value={ledgerStatus} onValueChange={setLedgerStatus}>
                <SelectTrigger className={TERM_TRIGGER}>
                  <SelectValue placeholder="状态" />
                </SelectTrigger>
                <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
                  <SelectItem value="all" className={TERM_SELECT_ITEM}>全部</SelectItem>
                  <SelectItem value="sent" className={TERM_SELECT_ITEM}>成功</SelectItem>
                  <SelectItem value="failed" className={TERM_SELECT_ITEM}>失败</SelectItem>
                  <SelectItem value="missing" className={TERM_SELECT_ITEM}>缺失</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Input
              placeholder="邮箱筛选"
              value={ledgerEmail}
              onChange={(e) => setLedgerEmail(e.target.value)}
              className={TERM_INPUT}
            />
            <button
              type="button"
              onClick={loadLedger}
              disabled={ledgerLoading}
              className={cn(TERM_BUTTON, 'w-full justify-center')}
            >
              {ledgerLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              )}
              刷新台账
            </button>
          </div>

          {ledgerError && (
            <p className="border border-term-neg/50 bg-term-neg/10 px-2 py-1 font-mono text-xs text-term-neg">
              {ledgerError}
            </p>
          )}
          {!ledgerError && ledgerTotal > ledgerItems.length && (
            <p className="border border-term-warn/50 bg-term-warn/10 px-2 py-1 font-mono text-xs tabular-nums text-term-warn">
              当前范围数据量较大，仅显示最新 {ledgerItems.length} 条（共 {ledgerTotal} 条）。请缩小时间范围或增加筛选条件以查看更早的记录。
            </p>
          )}
        </div>
      </TermPanel>

      {/* 台账表格 */}
      <TermPanel>
          {/* 桌面端表格 */}
          <div className="hidden md:block">
            {ledgerLoading && ledgerItems.length === 0 ? (
              <div className="space-y-3 p-3">
                <Skeleton className="h-10 w-full rounded-none bg-term-raised" />
                <Skeleton className="h-10 w-full rounded-none bg-term-raised" />
                <Skeleton className="h-10 w-11/12 rounded-none bg-term-raised" />
                <Skeleton className="h-10 w-4/5 rounded-none bg-term-raised" />
              </div>
            ) : ledgerItems.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <RotateCcw className="h-8 w-8 text-term-faint" />
                <span className="font-mono text-sm text-term-muted">暂无台账记录</span>
                <span className="text-xs text-term-faint">
                  调整筛选条件或点击「刷新台账」
                </span>
              </div>
            ) : (
              <div>
                {Object.entries(groupedByDay).map(([date, items]) => (
                  <LedgerDayGroup
                    key={date}
                    date={date}
                    items={items}
                    expanded={expandedDates.has(date)}
                    onToggle={() => toggleDate(date)}
                    isAnchor={date === ledgerEndDate}
                    isToday={date === todayStr}
                    subscriptions={subscriptions}
                    modelConfig={modelConfig}
                    isLoadingModelConfig={isLoadingModelConfig}
                    onRequestModelConfig={ensureModelConfig}
                    resendingStates={resendingStates}
                    regeneratingSummaryKeys={regeneratingSummaryKeys}
                    onRegenerateSummary={handleQuickRegenerateSummary}
                    onRowClick={openDetail}
                    onResend={handleResendLedger}
                    onResendLoading={(item) =>
                      setResendingStates((prev) => ({ ...prev, [item.ledger_key]: 'preparing' }))
                    }
                    canTriggerResend={canTriggerResend}
                  />
                ))}
              </div>
            )}
          </div>

          {/* 手机端卡片列表 */}
          <div className="divide-y divide-term-border md:hidden">
            {ledgerLoading && ledgerItems.length === 0 ? (
              <div className="space-y-3 p-3">
                <Skeleton className="h-16 w-full rounded-none bg-term-raised" />
                <Skeleton className="h-16 w-full rounded-none bg-term-raised" />
                <Skeleton className="h-16 w-full rounded-none bg-term-raised" />
              </div>
            ) : ledgerItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <RotateCcw className="mb-2 h-8 w-8 text-term-faint" />
                <p className="font-mono text-sm text-term-muted">暂无台账记录</p>
              </div>
            ) : (
              ledgerItems.map((item) => {
                const projectLabel = item.project_names?.length
                  ? item.project_names.join(', ')
                  : item.project_ids
                const sub = subscriptions.find((s) => s.id === item.subscription_id)
                const fallbackModel = sub?.ai_model || modelConfig?.defaultModel || ''
                const canTrigger = canTriggerResend || item.can_resend
                // BLF-822：行内 AI 摘要快捷操作（仅管理员，pending/failed 可用）
                const summaryBusy =
                  regeneratingSummaryKeys.has(item.ledger_key) ||
                  item.ai_summary_status === 'generating'
                const showSummaryAction =
                  canTriggerResend &&
                  item.status === 'sent' &&
                  (item.ai_summary_status === 'pending' || item.ai_summary_status === 'failed')

                return (
                  <div
                    key={item.ledger_key}
                    className="p-3 transition-colors active:bg-term-hover"
                    onClick={() => openDetail(item)}
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-mono text-xs tabular-nums text-term-muted">
                          {new Date(item.expected_at).toLocaleString('zh-CN')}
                        </div>
                        <div
                          className="text-sm font-medium mt-0.5 truncate max-w-[180px]"
                          title={projectLabel}
                        >
                          {projectLabel}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <TermFrequencyTag frequency={item.frequency} labels={FREQUENCY_LABELS} />
                        <TermStatusPill status={item.status} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <div className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        {summaryBusy ? (
                          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-term-accent">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            生成中
                          </span>
                        ) : showSummaryAction ? (
                          <button
                            type="button"
                            className="inline-flex h-7 items-center gap-1 px-2 font-mono text-[11px] text-term-accent transition-colors hover:bg-term-hover disabled:cursor-not-allowed disabled:opacity-60"
                            onClick={() => handleQuickRegenerateSummary(item)}
                          >
                            <Sparkles className="h-3 w-3" aria-hidden />
                            {item.ai_summary_status === 'failed' ? '重新生成' : '生成摘要'}
                          </button>
                        ) : null}
                        {canTrigger ? (
                          <LedgerResendCell
                            item={item}
                            resendingStage={resendingStates[item.ledger_key]}
                            canResend
                            modelConfig={modelConfig}
                            isLoadingModelConfig={isLoadingModelConfig}
                            onRequestModelConfig={ensureModelConfig}
                            fallbackModel={fallbackModel}
                            onLoading={() =>
                              setResendingStates((prev) => ({
                                ...prev,
                                [item.ledger_key]: 'preparing',
                              }))
                            }
                            onSubmit={(overrideAiModel) =>
                              void handleResendLedger(item, overrideAiModel)
                            }
                          />
                        ) : null}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
      </TermPanel>

      {/* 台账详情 Dialog */}
      <LedgerDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        item={selectedItem}
        subscriptions={subscriptions}
        modelConfig={modelConfig}
        isLoadingModelConfig={isLoadingModelConfig}
        resendingStage={selectedItem ? resendingStates[selectedItem.ledger_key] : undefined}
        regeneratingAiSummary={
          selectedItem ? regeneratingSummaryKeys.has(selectedItem.ledger_key) : false
        }
        canTriggerResend={canTriggerResend}
        onResend={handleResendLedger}
        onResendLoading={(item) =>
          setResendingStates((prev) => ({ ...prev, [item.ledger_key]: 'preparing' }))
        }
        onRegenerateAiSummary={handleRegenerateAiSummary}
        onItemRefreshed={mergeLedgerItem}
        onCopy={(text) => {
          navigator.clipboard.writeText(text)
          notify({ type: 'success', title: '已复制' })
        }}
      />
    </div>
  )
}
