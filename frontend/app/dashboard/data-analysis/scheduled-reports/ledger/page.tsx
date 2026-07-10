'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { format } from 'date-fns'
import {
  Loader2, RotateCcw,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { DateRangePicker, parseDateRangeInputValue } from '@/components/ui/date-picker'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/components/notifications'
import type { DateRange } from 'react-day-picker'
import type { LedgerItem, ResendStage, Subscription } from '../_components/types'
import {
  fetchLedger,
  fetchLedgerItemByKey,
  fetchModelConfig,
  fetchSubscriptions,
  pollDeliveryLogStatus,
  pollLedgerAiSummaryStatus,
  regenerateLedgerAiSummary,
  resendLedgerEntry,
} from '../_components/api'
import { LedgerResendCell } from '../_components/LedgerResendCell'
import { LedgerDayGroup } from '../_components/LedgerDayGroup'
import { LedgerDetailDialog } from '../_components/LedgerDetailDialog'
import { FREQUENCY_COLORS, FREQUENCY_LABELS, STATUS_BG } from '../_components/ledger-constants'
import type { AIModelConfig } from '../_components/types'

export default function LedgerPage() {
  const { data: session } = useSession()
  const { notify } = useNotifications()

  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [modelConfig, setModelConfig] = useState<AIModelConfig | null>(null)
  const [isLoadingModelConfig, setIsLoadingModelConfig] = useState(false)
  const [ledgerItems, setLedgerItems] = useState<LedgerItem[]>([])
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [ledgerError, setLedgerError] = useState<string | null>(null)
  const [resendingStates, setResendingStates] = useState<Record<string, ResendStage>>({})
  const [regeneratingSummaryKeys, setRegeneratingSummaryKeys] = useState<Set<string>>(new Set())
  const [selectedItem, setSelectedItem] = useState<LedgerItem | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const today = new Date()
  const thirtyDaysAgo = new Date(today)
  thirtyDaysAgo.setDate(today.getDate() - 30)

  const [ledgerStartDate, setLedgerStartDate] = useState(format(thirtyDaysAgo, 'yyyy-MM-dd'))
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
    return Object.fromEntries(
      Object.entries(buckets).sort(([a], [b]) => b.localeCompare(a)),
    )
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
    setExpandedDates(prev => {
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
    [ledgerStartDate, ledgerEndDate],
  )

  useEffect(() => {
    setIsLoadingModelConfig(true)
    fetchModelConfig(
      (cfg) => { setModelConfig(cfg); setIsLoadingModelConfig(false) },
    )
  }, [])

  const loadLedger = useCallback(async () => {
    setLedgerLoading(true)
    setLedgerError(null)
    await fetchLedger(
      {
        startDate: ledgerStartDate,
        endDate: ledgerEndDate,
        frequency: ledgerFrequency,
        statusFilter: ledgerStatus,
        email: ledgerEmail,
      },
      (items) => {
        setLedgerItems(items)
      },
      (error) => setLedgerError(error),
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
    fetchSubscriptions(session, (subs) => setSubscriptions(subs))
  }, [session])

  const roleType = session?.user?.roleType
  const isAdmin = roleType === 'admin'
  const canTriggerResend = isAdmin

  const mergeLedgerItem = (nextItem: LedgerItem) => {
    setLedgerItems(prev => prev.map(item => item.ledger_key === nextItem.ledger_key ? nextItem : item))
    setSelectedItem(prev => prev?.ledger_key === nextItem.ledger_key ? nextItem : prev)
  }

  const handleResendLedger = async (item: LedgerItem, overrideAiModel?: string | null) => {
    setResendingStates(prev => ({ ...prev, [item.ledger_key]: 'preparing' }))
    const result = await resendLedgerEntry(item.ledger_key, isAdmin, overrideAiModel)
    if (result.ok && result.deliveryLogId) {
      pollDeliveryLogStatus(
        item.ledger_key,
        result.deliveryLogId,
        (key, stage) => setResendingStates(prev => ({ ...prev, [key]: stage as ResendStage })),
        async (key) => {
          await loadLedger()
          setTimeout(() => {
            setResendingStates(prev => {
              const next = { ...prev }
              delete next[key]
              return next
            })
          }, 1500)
        },
        (key) => {
          setResendingStates(prev => {
            const next = { ...prev }
            delete next[key]
            return next
          })
        },
      )
    } else if (!result.ok) {
      setResendingStates(prev => {
        const next = { ...prev }
        delete next[item.ledger_key]
        return next
      })
      notify({ type: 'error', title: '操作失败', message: result.error || '未知错误' })
    } else {
      setResendingStates(prev => {
        const next = { ...prev }
        delete next[item.ledger_key]
        return next
      })
      await loadLedger()
    }
  }

  const handleRegenerateAiSummary = async (item: LedgerItem, overrideAiModel?: string | null) => {
    // 防止重复点：若同一 ledger_key 已经在 regenerate 流程中，直接短路掉。
    // （用户从台账「打断并重新生成」入口连点时尤其需要这层防护，避免后端
    // 接连两次 enqueue 产生两个并行生成线程。）
    let alreadyInFlight = false
    setRegeneratingSummaryKeys(prev => {
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
      setRegeneratingSummaryKeys(prev => {
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

    pollLedgerAiSummaryStatus(
      item.ledger_key,
      () => fetchLedgerItemByKey(item),
      mergeLedgerItem,
      (doneItem) => {
        mergeLedgerItem(doneItem)
        setRegeneratingSummaryKeys(prev => {
          const next = new Set(prev)
          next.delete(item.ledger_key)
          return next
        })
        notify({ type: 'success', title: 'AI 摘要已更新' })
      },
      (failedItem) => {
        if (failedItem) mergeLedgerItem(failedItem)
        setRegeneratingSummaryKeys(prev => {
          const next = new Set(prev)
          next.delete(item.ledger_key)
          return next
        })
        notify({
          type: 'error',
          title: 'AI 摘要生成失败',
          message: failedItem?.ai_summary_error || '请稍后重试',
        })
      },
    )
  }

  const openDetail = (item: LedgerItem) => {
    setSelectedItem(item)
    setDetailOpen(true)
  }

  return (
    <div className="space-y-3">
      {/* 工具栏 */}
      <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
        <CardContent className="p-4 space-y-4">
          <div className="hidden md:flex gap-3 flex-wrap items-center">
            <DateRangePicker
              value={ledgerDateRangeValue}
              onChange={handleLedgerDateRangeChange}
              className="h-9 w-[280px] border-border/70 bg-[hsl(var(--surface-soft))] shadow-none"
            />
            <Select value={ledgerFrequency} onValueChange={setLedgerFrequency}>
              <SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="频率" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部频率</SelectItem>
                <SelectItem value="daily">每日</SelectItem>
                <SelectItem value="weekly">每周</SelectItem>
                <SelectItem value="monthly">每月</SelectItem>
              </SelectContent>
            </Select>
            <Select value={ledgerStatus} onValueChange={setLedgerStatus}>
              <SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="状态" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="sent">成功</SelectItem>
                <SelectItem value="failed">失败</SelectItem>
                <SelectItem value="missing">缺失</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="邮箱筛选"
              value={ledgerEmail}
              onChange={e => setLedgerEmail(e.target.value)}
              className="w-[200px] h-9"
            />
            <div className="ml-auto">
              <Button size="sm" onClick={loadLedger} disabled={ledgerLoading}>
                {ledgerLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}
                刷新台账
              </Button>
            </div>
          </div>
          <div className="md:hidden space-y-2">
            <DateRangePicker
              value={ledgerDateRangeValue}
              onChange={handleLedgerDateRangeChange}
              className="h-9 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none text-xs"
            />
            <div className="grid grid-cols-2 gap-2">
              <Select value={ledgerFrequency} onValueChange={setLedgerFrequency}>
                <SelectTrigger className="h-9"><SelectValue placeholder="频率" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="daily">每日</SelectItem>
                  <SelectItem value="weekly">每周</SelectItem>
                  <SelectItem value="monthly">每月</SelectItem>
                </SelectContent>
              </Select>
              <Select value={ledgerStatus} onValueChange={setLedgerStatus}>
                <SelectTrigger className="h-9"><SelectValue placeholder="状态" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="sent">成功</SelectItem>
                  <SelectItem value="failed">失败</SelectItem>
                  <SelectItem value="missing">缺失</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Input placeholder="邮箱筛选" value={ledgerEmail} onChange={e => setLedgerEmail(e.target.value)} className="h-9" />
            <Button size="sm" className="w-full" onClick={loadLedger} disabled={ledgerLoading}>
              {ledgerLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />}
              刷新台账
            </Button>
          </div>

          {ledgerError && (
            <p className="text-sm text-destructive">{ledgerError}</p>
          )}
        </CardContent>
      </Card>

      {/* 台账表格 */}
      <Card className="border-border/70 bg-[hsl(var(--surface-panel))]">
        <CardContent className="p-0">
          {/* 桌面端表格 */}
          <div className="hidden md:block">
            {ledgerItems.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                {ledgerLoading ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">台账加载中...</span>
                  </>
                ) : (
                  <>
                    <RotateCcw className="h-8 w-8 text-muted-foreground/30" />
                    <span className="text-sm text-muted-foreground">暂无台账记录</span>
                    <span className="text-xs text-muted-foreground/60">调整筛选条件或点击「刷新台账」</span>
                  </>
                )}
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
                    resendingStates={resendingStates}
                    onRowClick={openDetail}
                    onResend={handleResendLedger}
                    onResendLoading={item => setResendingStates(prev => ({ ...prev, [item.ledger_key]: 'preparing' }))}
                    canTriggerResend={canTriggerResend}
                  />
                ))}
              </div>
            )}
          </div>

          {/* 手机端卡片列表 */}
          <div className="md:hidden divide-y divide-border/60">
            {ledgerItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                {ledgerLoading ? (
                  <><Loader2 className="h-6 w-6 animate-spin text-muted-foreground mb-2" /><p className="text-sm text-muted-foreground">台账加载中...</p></>
                ) : (
                  <><RotateCcw className="h-8 w-8 text-muted-foreground/30 mb-2" /><p className="text-sm text-muted-foreground">暂无台账记录</p></>
                )}
              </div>
            ) : ledgerItems.map(item => {
              const projectLabel = item.project_names?.length ? item.project_names.join(', ') : item.project_ids
              const sub = subscriptions.find(s => s.id === item.subscription_id)
              const fallbackModel = sub?.ai_model || modelConfig?.defaultModel || ''
              const canTrigger = canTriggerResend || item.can_resend

              return (
                <div
                  key={item.ledger_key}
                  className="p-4 active:bg-accent/50 transition-colors"
                  onClick={() => openDetail(item)}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <div className="text-xs text-muted-foreground">
                        {new Date(item.expected_at).toLocaleString('zh-CN')}
                      </div>
                      <div className="text-sm font-medium mt-0.5 truncate max-w-[180px]" title={projectLabel}>
                        {projectLabel}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge className={cn('text-xs', FREQUENCY_COLORS[item.frequency])}>
                        {FREQUENCY_LABELS[item.frequency]}
                      </Badge>
                      <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs border', STATUS_BG[item.status])}>
                        {item.status === 'sent' ? '✓' : item.status === 'failed' ? '✗' : '⚠'}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <div className="ml-auto" onClick={e => e.stopPropagation()}>
                      {canTrigger ? (
                        <LedgerResendCell
                          item={item}
                          resendingStage={resendingStates[item.ledger_key]}
                          canResend
                          modelConfig={modelConfig}
                          isLoadingModelConfig={isLoadingModelConfig}
                          fallbackModel={fallbackModel}
                          onLoading={() => setResendingStates(prev => ({ ...prev, [item.ledger_key]: 'preparing' }))}
                          onSubmit={(overrideAiModel) => void handleResendLedger(item, overrideAiModel)}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* 台账详情 Dialog */}
      <LedgerDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        item={selectedItem}
        subscriptions={subscriptions}
        modelConfig={modelConfig}
        isLoadingModelConfig={isLoadingModelConfig}
        resendingStage={selectedItem ? resendingStates[selectedItem.ledger_key] : undefined}
        regeneratingAiSummary={selectedItem ? regeneratingSummaryKeys.has(selectedItem.ledger_key) : false}
        canTriggerResend={canTriggerResend}
        onResend={handleResendLedger}
        onResendLoading={item => setResendingStates(prev => ({ ...prev, [item.ledger_key]: 'preparing' }))}
        onRegenerateAiSummary={handleRegenerateAiSummary}
        onItemRefreshed={mergeLedgerItem}
        onCopy={text => {
          navigator.clipboard.writeText(text)
          notify({ type: 'success', title: '已复制' })
        }}
      />
    </div>
  )
}
