'use client'

import { useMemo } from 'react'
import { format } from 'date-fns'
import { ChevronDown, Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LedgerResendCell } from './LedgerResendCell'
import { STATUS_LABELS, WEEKDAY_LABELS_SUN_FIRST } from './ledger-constants'
import { WarmFrequencyTag, WarmStatusPill } from './warm-shared'
import type { AIModelConfig, LedgerItem, ResendStage, Subscription } from './types'
import styles from '../scheduled-reports-warm.module.css'

const FREQUENCY_LABELS: Record<string, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}

interface LedgerDayGroupProps {
  date: string
  items: LedgerItem[]
  expanded: boolean
  onToggle: () => void
  isAnchor: boolean
  isToday: boolean
  subscriptions: Subscription[]
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  /** BEL-422：行内重发下拉打开时按需加载模型配置 */
  onRequestModelConfig: () => void
  resendingStates: Record<string, ResendStage>
  /** BLF-822：正在生成 AI 摘要的 ledger_key 集合（乐观更新/轮询中） */
  regeneratingSummaryKeys: Set<string>
  /** BLF-822：行内快捷触发「生成/重新生成 AI 摘要」（仅管理员，pending/failed 可用） */
  onRegenerateSummary: (item: LedgerItem) => void
  onRowClick: (item: LedgerItem) => void
  onResend: (item: LedgerItem, overrideAiModel: string | null) => void
  onResendLoading: (item: LedgerItem) => void
  canTriggerResend: boolean
}

export function LedgerDayGroup({
  date,
  items,
  expanded,
  onToggle,
  isAnchor,
  isToday,
  subscriptions,
  modelConfig,
  isLoadingModelConfig,
  onRequestModelConfig,
  resendingStates,
  regeneratingSummaryKeys,
  onRegenerateSummary,
  onRowClick,
  onResend,
  onResendLoading,
  canTriggerResend,
}: LedgerDayGroupProps) {
  const counts = useMemo(() => {
    const c = { sent: 0, failed: 0, missing: 0 }
    for (const it of items) c[it.status]++
    return c
  }, [items])

  const weekday = WEEKDAY_LABELS_SUN_FIRST[new Date(date).getDay()]

  return (
    <div className={styles.dayGroup}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={styles.dayHeader}
        data-anchor={isAnchor ? 'true' : 'false'}
      >
        <ChevronDown
          className={styles.dayChevron}
          data-expanded={expanded ? 'true' : 'false'}
          aria-hidden
        />
        <span className={styles.dayDate}>{date}</span>
        <span className={styles.dayMeta}>· {weekday}</span>
        {isToday ? <span className={styles.dayBadge}>今天</span> : null}
        <span className={styles.dayCount}>{items.length} 条</span>
        <span className={styles.dayCounts}>
          {counts.sent > 0 ? <WarmStatusPill status="sent" label={counts.sent} /> : null}
          {counts.failed > 0 ? (
            <WarmStatusPill status="failed" label={counts.failed} />
          ) : null}
          {counts.missing > 0 ? (
            <WarmStatusPill status="missing" label={counts.missing} />
          ) : null}
        </span>
      </button>

      {expanded ? (
        <div className={styles.dayTableScroller}>
          <table className={cn(styles.table, styles.dayTable)} aria-label="台账明细">
            <colgroup>
              <col style={{ width: 92 }} />
              <col style={{ width: 184 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 190 }} />
              <col style={{ width: 92 }} />
              <col style={{ width: 116 }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className={styles.numeric}>应发时间</th>
                <th scope="col">项目</th>
                <th scope="col">国家</th>
                <th scope="col">邮箱</th>
                <th scope="col">频率</th>
                <th scope="col">状态</th>
                <th scope="col" className={styles.actionsCell}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const projectNames =
                  item.project_names?.length > 0
                    ? item.project_names
                    : item.project_ids === '*'
                      ? ['全部项目']
                      : item.project_ids.split(',').filter(Boolean)
                const projectsFullLabel = projectNames.join(' · ')
                const projectsDisplayLabel =
                  projectNames.length <= 2
                    ? projectsFullLabel
                    : `${projectNames[0]} · ${projectNames[1]} +${projectNames.length - 2}`
                const countryList = item.country
                  .split(',')
                  .map((c) => c.trim())
                  .filter(Boolean)
                const countryLabel =
                  countryList.length === 0
                    ? '—'
                    : countryList.length === 1
                      ? countryList[0]
                      : `${countryList[0]} +${countryList.length - 1}`
                const sub = subscriptions.find((s) => s.id === item.subscription_id)
                const fallbackModel = sub?.ai_model || modelConfig?.defaultModel || ''
                const canTrigger = canTriggerResend || item.can_resend
                const regeneratingSummary =
                  regeneratingSummaryKeys.has(item.ledger_key) ||
                  item.ai_summary_status === 'generating'
                const showSummaryAction =
                  canTriggerResend &&
                  item.status === 'sent' &&
                  (item.ai_summary_status === 'pending' ||
                    item.ai_summary_status === 'failed')

                return (
                  <tr
                    key={item.ledger_key}
                    className={styles.dayRow}
                    onClick={() => onRowClick(item)}
                  >
                    <td
                      className={cn(styles.numeric, styles.dayTime)}
                      title={format(new Date(item.expected_at), 'HH:mm:ss')}
                    >
                      {format(new Date(item.expected_at), 'HH:mm')}
                    </td>
                    <td
                      title={projectsFullLabel}
                      className={cn(styles.truncateCell, styles.dayProject)}
                    >
                      {projectsDisplayLabel}
                    </td>
                    <td className={cn(styles.mutedCell, styles.dayCountry)}>
                      {countryLabel}
                    </td>
                    <td
                      className={cn(styles.mutedCell, styles.truncateCell)}
                      title={item.email || ''}
                    >
                      {item.email || '未填写'}
                    </td>
                    <td>
                      <WarmFrequencyTag
                        frequency={item.frequency}
                        labels={FREQUENCY_LABELS}
                      />
                    </td>
                    <td>
                      <WarmStatusPill
                        status={item.status}
                        label={STATUS_LABELS[item.status]}
                        title={
                          item.status === 'failed'
                            ? item.error_message || '发送失败'
                            : undefined
                        }
                        className={styles.statusHelp}
                      />
                    </td>
                    <td
                      className={styles.actionsCell}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className={styles.actionGroup}>
                        {regeneratingSummary ? (
                          <span className={styles.inlineLoading} role="status">
                            <Loader2 className={styles.spinner} aria-hidden />
                            生成中
                          </span>
                        ) : showSummaryAction ? (
                          <button
                            type="button"
                            data-testid="row-generate-summary"
                            className={styles.summaryAction}
                            onClick={() => onRegenerateSummary(item)}
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
                            onRequestModelConfig={onRequestModelConfig}
                            fallbackModel={fallbackModel}
                            onLoading={() => onResendLoading(item)}
                            onSubmit={(overrideAiModel) =>
                              onResend(item, overrideAiModel)
                            }
                          />
                        ) : (
                          <span className={styles.mutedCell}>—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
