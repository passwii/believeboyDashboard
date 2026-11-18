'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { format, subDays } from 'date-fns'
import { AlertCircle, Loader2, RotateCcw, Search, Sparkles } from 'lucide-react'
import { DateRangePicker, parseDateRangeInputValue, parseDateInputValue } from '@/components/ui/date-picker'
import { WarmButton, WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useNotifications } from '@/components/notifications'
import type { DateRange } from 'react-day-picker'
import type { AIModelConfig, LedgerItem, LedgerSummary, ResendStage, Subscription } from './types'
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
import {
  LedgerDayGroup,
  formatLedgerBeijingDate,
  formatLedgerBeijingTime,
  ledgerStatusDisplay,
} from './LedgerDayGroup'
import { LedgerDetailDialog } from './LedgerDetailDialog'
import { LedgerSummaryCards } from './LedgerSummaryCards'
import { FREQUENCY_LABELS } from './ledger-constants'
import { getCountryLabel } from '@/lib/country'
import styles from './ledger-warm.module.css'

const FREQUENCY_OPTIONS = [
  { value: 'all', label: '全部频率' },
  { value: 'daily', label: '每日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
]

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'sent', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'missing', label: '缺失' },
]

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
  // BEL-422：模型配置与订阅列表只服务于重新生成/详情交互（模型下拉、订阅 ai_model
  // 回退），首次交互时才拉取，不再随 mount 无条件请求。台账行渲染所需的
  // 项目名/国家/邮箱均在 ledger item 自身，不受影响。
  const modelConfigRequested = useRef(false)
  const subscriptionsRequested = useRef(false)
  const [projects, setProjects] = useState<Array<{ id?: number | null; name: string }>>([])
  const projectsRequested = useRef(false)
  const [ledgerItems, setLedgerItems] = useState<LedgerItem[]>([])
  const [ledgerSummary, setLedgerSummary] = useState<LedgerSummary | null>(null)
  // 初始为 true：tab 切换重新挂载时立即显示骨架屏，避免先闪「暂无台账记录」空状态。
  const [ledgerLoading, setLedgerLoading] = useState(true)
  const [ledgerError, setLedgerError] = useState<string | null>(null)
  // 后端按 expected_at DESC 截断；记录总数（可能 > 已加载条数）。
  const [ledgerTotal, setLedgerTotal] = useState(0)
  const [resendingStates, setResendingStates] = useState<Record<string, ResendStage>>({})
  const [regeneratingSummaryKeys, setRegeneratingSummaryKeys] = useState<Set<string>>(new Set())
  const [selectedItem, setSelectedItem] = useState<LedgerItem | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)

  // 默认日期范围按北京时间的「今天」，避免浏览器时区在跨日时给出错误区间。
  const beijingToday = formatLedgerBeijingDate(new Date())
  const defaultRange = useMemo(() => {
    const end = parseDateInputValue(beijingToday) ?? new Date()
    return {
      start: format(subDays(end, 6), 'yyyy-MM-dd'),
      end: format(end, 'yyyy-MM-dd'),
    }
  }, [beijingToday])

  const [ledgerStartDate, setLedgerStartDate] = useState(defaultRange.start)
  const [ledgerEndDate, setLedgerEndDate] = useState(defaultRange.end)
  const [ledgerFrequency, setLedgerFrequency] = useState<string>('all')
  const [ledgerStatus, setLedgerStatus] = useState<string>('all')
  const [ledgerProject, setLedgerProject] = useState<string>('all')
  const [ledgerEmail, setLedgerEmail] = useState('')
  const initialLoadDone = useRef(false)
  const lastLoadedEmail = useRef(ledgerEmail)

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  // 项目清单只服务于新增的项目筛选；失败时筛选退化为「全部项目」，不阻塞台账列表。
  useEffect(() => {
    if (!session || projectsRequested.current) return
    projectsRequested.current = true
    fetchManagedProjectsCached<Array<{ id?: number | null; name: string }>>(session)
      .then((data) => {
        setProjects(
          data.filter(
            (project) => typeof project.name === 'string' && project.name.trim().length > 0
          )
        )
      })
      .catch(() => {
        // 静默：项目服务不可用时台账仍可按日期/状态/频率/邮箱查看。
      })
  }, [session])

  // 按 expected_date 分组（后端已按 yyyy-MM-dd 返回）
  const groupedByDay = useMemo(() => {
    const buckets: Record<string, LedgerItem[]> = {}
    for (const item of ledgerItems) {
      ;(buckets[item.expected_date] ??= []).push(item)
    }
    return Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => b.localeCompare(a)))
  }, [ledgerItems])

  // 展开状态：默认展开所有有记录的日组；用户手动折叠在刷新时保持，
  // 只有筛选/日期范围变化后的下一次数据才重置为全部展开。
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())
  const expandAllOnNextData = useRef(true)
  const ledgerRequestId = useRef(0)

  const todayStr = formatLedgerBeijingDate(new Date())

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

  const projectOptions = useMemo(
    () => [
      { value: 'all', label: '全部项目' },
      ...projects
        .filter((project): project is { id: number; name: string } =>
          typeof project.id === 'number' && project.id > 0
        )
        .map((project) => ({ value: String(project.id), label: project.name })),
    ],
    [projects]
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

  // 重新生成 / 重新生成摘要 / 打开详情 都可能需要模型配置与订阅信息，统一在交互入口预热
  const ensureInteractionData = useCallback(() => {
    ensureModelConfig()
    ensureSubscriptions()
  }, [ensureModelConfig, ensureSubscriptions])

  const loadLedger = useCallback(async () => {
    const requestId = ++ledgerRequestId.current
    setLedgerLoading(true)
    setLedgerError(null)
    // 后端 ledger 接口按天分页：limit 解释为「最近多少天」，保证范围内每一天都完整返回。
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
        projectId: ledgerProject === 'all' ? '' : ledgerProject,
        limit: ledgerLimit,
      },
      (items, summary, total) => {
        // 过期的并发请求不能覆盖最新筛选结果（例如快速改日期范围）。
        if (requestId !== ledgerRequestId.current) return
        setLedgerItems(items)
        setLedgerSummary(summary)
        setLedgerTotal(total ?? items.length)
        if (expandAllOnNextData.current) {
          expandAllOnNextData.current = false
          setExpandedDates(new Set(items.map((item) => item.expected_date)))
        }
      },
      (error) => {
        if (requestId !== ledgerRequestId.current) return
        setLedgerError(error)
      }
    )
    if (requestId === ledgerRequestId.current) setLedgerLoading(false)
  }, [ledgerStartDate, ledgerEndDate, ledgerFrequency, ledgerStatus, ledgerProject, ledgerEmail])

  // 首次加载 + 筛选变化：日期/状态/频率/项目立即加载，邮箱输入做 400ms 防抖。
  useEffect(() => {
    if (!initialLoadDone.current) {
      initialLoadDone.current = true
      lastLoadedEmail.current = ledgerEmail
      void loadLedger()
      return
    }
    // 日期范围或任一筛选变化后的新数据默认全部展开，避免「今天无记录」时
    // 所有有数据的日组都折叠、页面看起来像空台账。
    expandAllOnNextData.current = true
    const emailChanged = ledgerEmail !== lastLoadedEmail.current
    lastLoadedEmail.current = ledgerEmail
    const handle = setTimeout(() => void loadLedger(), emailChanged ? 400 : 0)
    return () => clearTimeout(handle)
  }, [ledgerStartDate, ledgerEndDate, ledgerFrequency, ledgerStatus, ledgerProject, ledgerEmail, loadLedger])

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
        (key, reason) => {
          setResendingStates((prev) => {
            const next = { ...prev }
            delete next[key]
            return next
          })
          if (reason === 'failed') {
            notify({
              type: 'error',
              title: '重新生成失败',
              message: '后台处理失败，请查看台账错误信息后重试',
            })
            return
          }
          notify({
            type: 'warning',
            title: '重新生成进度查询超时',
            message: '任务可能仍在后台执行，请稍后刷新台账查看结果',
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

    // BLF-1015：后端返回 run 绑定时，详情弹窗直接接管该 run 的共享 Insight 流，
    // 这里不再重复轮询——否则同一 delivery 会被两个来源写入。
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

  const resetFilters = () => {
    setLedgerStartDate(defaultRange.start)
    setLedgerEndDate(defaultRange.end)
    setLedgerFrequency('all')
    setLedgerStatus('all')
    setLedgerProject('all')
    setLedgerEmail('')
  }

  const rangeDays = useMemo(() => {
    const start = parseDateInputValue(ledgerStartDate)
    const end = parseDateInputValue(ledgerEndDate)
    if (!start || !end) return 0
    return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1)
  }, [ledgerStartDate, ledgerEndDate])

  const handleLookEarlier = () => {
    const start = parseDateInputValue(ledgerStartDate)
    if (!start) return
    const newEnd = subDays(start, 1)
    setLedgerStartDate(format(subDays(newEnd, 6), 'yyyy-MM-dd'))
    setLedgerEndDate(format(newEnd, 'yyyy-MM-dd'))
  }

  const ledgerErrorState = (
    <div className={styles.state} role="alert">
      <span className={styles.stateIcon}>
        <AlertCircle aria-hidden />
      </span>
      <p className={styles.stateTitle}>台账加载失败</p>
      <p className={`${styles.stateText} ${styles.stateErrorText} font-sans`}>{ledgerError}</p>
      <div className={styles.stateActions}>
        <WarmButton onClick={loadLedger} loading={ledgerLoading} loadingLabel="重新加载台账">
          <RotateCcw aria-hidden />
          重新加载
        </WarmButton>
      </div>
    </div>
  )

  const ledgerEmptyState = (
    <div className={styles.state}>
      <span className={styles.stateIcon}>
        <RotateCcw aria-hidden />
      </span>
      <p className={`${styles.stateTitle} font-sans`}>暂无台账记录</p>
      <p className={`${styles.stateText} font-sans`}>调整筛选条件或点击「刷新台账」</p>
    </div>
  )

  const ledgerSkeleton = (
    <div className={styles.skeletonWrap} aria-busy="true" aria-label="台账加载中">
      {[100, 92, 80, 96].map((width, index) => (
        <div key={index} className={styles.skeletonRow}>
          <span className={styles.skeletonBar} style={{ width: '76px' }} />
          <span className={styles.skeletonBar} style={{ width: `${width}px`, flex: '1 1 auto' }} />
          <span className={styles.skeletonBar} style={{ width: '180px' }} />
          <span className={styles.skeletonBar} style={{ width: '92px' }} />
          <span className={styles.skeletonBar} style={{ width: '220px' }} />
          <span className={styles.skeletonBar} style={{ width: '40px' }} />
        </div>
      ))}
    </div>
  )

  return (
    <div className={styles.page} data-warm-scheduled-ledger="true">
      <section className={styles.panel} aria-label="订阅记录">
        <header className={styles.panelHead}>
          <h2 className={styles.panelTitle}>订阅记录</h2>
          <div className={styles.panelMeta}>
            {ledgerTotal > 0 || (!ledgerLoading && !ledgerError) ? (
              <span className={styles.count} data-testid="ledger-total-count">
                共 {ledgerTotal} 条
              </span>
            ) : null}
          </div>
        </header>

        <div className={styles.toolbar} role="group" aria-label="订阅记录筛选">
          <DateRangePicker
            value={ledgerDateRangeValue}
            onChange={handleLedgerDateRangeChange}
            portalContainer={portalContainer}
            className={styles.dateTrigger}
          />
          <WarmSelect
            id="ledger-status-filter"
            hideLabel
            ariaLabel="按状态筛选"
            className={styles.filterSelect}
            value={ledgerStatus}
            options={STATUS_OPTIONS}
            onChange={setLedgerStatus}
          />
          <WarmSelect
            id="ledger-frequency-filter"
            hideLabel
            ariaLabel="按频率筛选"
            className={styles.filterSelect}
            value={ledgerFrequency}
            options={FREQUENCY_OPTIONS}
            onChange={setLedgerFrequency}
          />
          <WarmSelect
            id="ledger-project-filter"
            hideLabel
            ariaLabel="按项目筛选"
            className={styles.filterSelectProject}
            value={ledgerProject}
            options={projectOptions}
            onChange={setLedgerProject}
          />
          <label className={styles.emailField}>
            <Search aria-hidden className={styles.emailIcon} />
            <input
              className={styles.emailInput}
              type="search"
              aria-label="按邮箱筛选订阅记录"
              placeholder="筛选邮箱"
              value={ledgerEmail}
              onChange={(event) => setLedgerEmail(event.target.value)}
            />
          </label>
          <WarmButton variant="quiet" onClick={resetFilters}>
            重置
          </WarmButton>
          <span className={styles.toolbarSpacer} />
          <WarmButton
            onClick={loadLedger}
            loading={ledgerLoading}
            loadingLabel="刷新台账中"
          >
            <RotateCcw aria-hidden />
            刷新台账
          </WarmButton>
          <span className={styles.note}>时间均为北京时间</span>
        </div>

        {ledgerSummary || ledgerLoading ? (
          <LedgerSummaryCards summary={ledgerSummary} loading={ledgerLoading && !ledgerSummary} />
        ) : null}

        {ledgerError && ledgerItems.length > 0 ? (
          <p className={`${styles.errorBar} font-sans`} role="alert">
            {ledgerError}
          </p>
        ) : null}
        {!ledgerError && ledgerTotal > ledgerItems.length ? (
          <p className={`${styles.noticeBar} font-sans`}>
            当前范围数据量较大，仅显示最新 {ledgerItems.length} 条（共 {ledgerTotal}{' '}
            条）。请缩小时间范围或增加筛选条件以查看更早的记录。
          </p>
        ) : null}

        {ledgerError && ledgerItems.length === 0
          ? ledgerErrorState
          : ledgerLoading && ledgerItems.length === 0
            ? ledgerSkeleton
            : ledgerItems.length === 0
              ? ledgerEmptyState
              : (
                <>
                  {/* 桌面端表格：表头只渲染一次，日组作为 tbody 分组 */}
                  <div
                    className={`hidden md:block ${styles.tableScroller}`}
                    data-scheduled-ledger-table-scroll="true"
                  >
                    <table className={styles.table} aria-label="台账明细">
                      <colgroup>
                        <col style={{ width: 84 }} />
                        <col style={{ width: 280 }} />
                        <col style={{ width: 200 }} />
                        <col style={{ width: 92 }} />
                        <col style={{ width: 264 }} />
                        <col style={{ width: 64 }} />
                        <col style={{ width: 126 }} />
                      </colgroup>
                      <thead className={styles.tableHead}>
                        <tr>
                          <th scope="col">时间</th>
                          <th scope="col">项目</th>
                          <th scope="col">接收</th>
                          <th scope="col">状态</th>
                          <th scope="col">AI 摘要</th>
                          <th scope="col">截图</th>
                          <th scope="col">操作</th>
                        </tr>
                      </thead>
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
                            setResendingStates((prev) => ({
                              ...prev,
                              [item.ledger_key]: 'preparing',
                            }))
                          }
                          canTriggerResend={canTriggerResend}
                        />
                      ))}
                    </table>
                  </div>

                  {/* 手机端卡片列表：沿用既有卡片逻辑，桌面由 md:hidden 隐藏 */}
                  <div className={`md:hidden ${styles.mobileList}`}>
                    {ledgerItems.map((item) => {
                      const projectLabel = item.project_names?.length
                        ? item.project_names.join(', ')
                        : item.project_ids === '*'
                          ? '全部项目'
                          : item.project_ids
                      const countryLabels = item.country
                        .split(',')
                        .map((country) => getCountryLabel(country.trim()))
                        .filter(Boolean)
                        .join(' · ')
                      const projectNames =
                        item.project_names?.length > 0
                          ? item.project_names
                          : item.project_ids === '*'
                            ? ['全部项目']
                            : item.project_ids.split(',').filter(Boolean)
                      const sub = subscriptions.find((s) => s.id === item.subscription_id)
                      const fallbackModel = sub?.ai_model || modelConfig?.defaultModel || ''
                      const canTrigger = canTriggerResend
                      const summaryBusy =
                        regeneratingSummaryKeys.has(item.ledger_key) ||
                        item.ai_summary_status === 'generating'
                      const showSummaryAction =
                        canTriggerResend &&
                        item.status === 'sent' &&
                        (item.ai_summary_status === 'pending' ||
                          item.ai_summary_status === 'failed')
                      const status = ledgerStatusDisplay(item)

                      return (
                        <div
                          key={item.ledger_key}
                          className={styles.mobileCard}
                          onClick={() => openDetail(item)}
                        >
                          <div className={styles.mobileTop}>
                            <div className={styles.mobileIdentity}>
                              <span className={styles.mobileTime}>
                                {formatLedgerBeijingTime(item.expected_at)?.dateTime ?? '—'} ·{' '}
                                {FREQUENCY_LABELS[item.frequency]}
                              </span>
                              <span className={styles.mobileProject} title={projectNames.join(' · ')}>
                                {projectLabel}
                              </span>
                              <span className={styles.mobileSub}>
                                {countryLabels || '—'}
                              </span>
                            </div>
                            <span className={styles.status} data-tone={status.tone}>
                              <span className={styles.statusGlyph} aria-hidden>
                                {status.glyph}
                              </span>
                              <span>{status.label}</span>
                            </span>
                          </div>
                          <div
                            className={styles.mobileActions}
                            onClick={(event) => event.stopPropagation()}
                          >
                            {summaryBusy ? (
                              <span className={styles.inlineLoading} role="status">
                                <Loader2 className={styles.spinner} aria-hidden />
                                生成中
                              </span>
                            ) : showSummaryAction ? (
                              <button
                                type="button"
                                className={styles.inlineAction}
                                onClick={() => handleQuickRegenerateSummary(item)}
                              >
                                <Sparkles aria-hidden />
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
                          {item.ai_summary ? (
                            <span className={styles.summaryText} title={item.ai_summary}>
                              {item.ai_summary}
                            </span>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

        <footer className={styles.footer}>
          <span>
            已显示{' '}
            <span className={styles.footerDates}>{ledgerStartDate || '—'}</span> 至{' '}
            <span className={styles.footerDates}>{ledgerEndDate || '—'}</span> ·{' '}
            <span className={styles.footerDates}>{rangeDays}</span> 天 ·{' '}
            <span className={styles.footerDates}>{ledgerItems.length}</span> 条记录
          </span>
          <span className={styles.footerSpacer} />
          <WarmButton
            onClick={handleLookEarlier}
            disabled={!ledgerStartDate || !ledgerEndDate}
          >
            查看更早 7 天
          </WarmButton>
        </footer>
      </section>

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
