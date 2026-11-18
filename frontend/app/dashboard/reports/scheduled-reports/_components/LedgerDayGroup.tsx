'use client'

import { useMemo } from 'react'
import Image from 'next/image'
import { ChevronDown, Loader2, Sparkles } from 'lucide-react'
import { getCountryLabel } from '@/lib/country'
import { LedgerResendCell } from './LedgerResendCell'
import { WEEKDAY_LABELS_SUN_FIRST, emailDisplayLabel } from './ledger-constants'
import type { AIModelConfig, LedgerItem, ResendStage, Subscription } from './types'
import styles from './ledger-warm.module.css'

export type LedgerStatusTone = 'sent' | 'generated' | 'failed' | 'missing'

/**
 * 台账时间统一按北京时间（Asia/Shanghai）展示。
 *
 * `expected_at` / `sent_at` 是带 +08:00 的 ISO 时间；直接 `new Date(...).format()`
 * 会跟随浏览器本地时区，导致表格「时间均为北京时间」的标注失真。这里显式指定
 * IANA 时区，并用 formatToParts 拼出账本需要的固定格式（不依赖宿主时区）。
 */
const LEDGER_BEIJING_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export interface LedgerBeijingTime {
  /** yyyy-MM-dd（北京日期） */
  date: string
  /** HH:mm */
  time: string
  /** HH:mm:ss */
  timeWithSeconds: string
  /** yyyy-MM-dd HH:mm */
  dateTime: string
  /** yyyy-MM-dd HH:mm:ss */
  dateTimeWithSeconds: string
}

export function formatLedgerBeijingTime(value: string | Date): LedgerBeijingTime | null {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return null
  const parts = LEDGER_BEIJING_FORMATTER.formatToParts(date)
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  const year = read('year')
  const month = read('month')
  const day = read('day')
  const hour = read('hour')
  const minute = read('minute')
  const second = read('second')
  if (!year || !month || !day || !hour || !minute) return null
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    timeWithSeconds: `${hour}:${minute}:${second}`,
    dateTime: `${year}-${month}-${day} ${hour}:${minute}`,
    dateTimeWithSeconds: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
  }
}

/** 北京时间的 yyyy-MM-dd，用于「今天」判断与默认日期范围。 */
export function formatLedgerBeijingDate(value: string | Date): string {
  return formatLedgerBeijingTime(value)?.date ?? ''
}

/**
 * 台账行状态文案：
 * - status=sent 且「有邮箱 + email_sent=true」→ 已发送
 * - status=sent 但无邮箱、或 email_sent=false → 仅生成（不得写成「已发送」）
 * - failed → 失败 / missing → 缺失
 */
export function ledgerStatusDisplay(item: LedgerItem): {
  label: string
  tone: LedgerStatusTone
  glyph: string
} {
  if (item.status === 'sent') {
    // 历史 Python 路径在「无邮箱仅生成」时也可能写入 sent_at（email_sent=true），
    // 因此只有「有邮箱且确实发过邮件」才算已发送；无邮箱或 email_sent=false 都是仅生成。
    const sentByEmail = Boolean(item.email?.trim()) && item.email_sent
    return sentByEmail
      ? { label: '已发送', tone: 'sent', glyph: '✓' }
      : { label: '仅生成', tone: 'generated', glyph: '○' }
  }
  if (item.status === 'failed') return { label: '失败', tone: 'failed', glyph: '✗' }
  return { label: '缺失', tone: 'missing', glyph: '⚠' }
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
  /** BEL-422：行内重新生成下拉打开时按需加载模型配置 */
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

/**
 * 台账按 expected_date 分组的日组。
 * 渲染 `<tbody>`：日组头（colspan）与当日数据行同属 LedgerView 的单一表格，
 * 这样表头只出现一次，日组折叠时只隐藏数据行。
 */
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

  const weekday = WEEKDAY_LABELS_SUN_FIRST[new Date(`${date}T00:00:00`).getDay()]
  const cellId = `ledger-day-${date}`

  return (
    <tbody id={cellId} data-day={date} data-anchor={isAnchor ? 'true' : 'false'}>
      <tr className={styles.dayRow}>
        <td colSpan={7}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={cellId}
            className={styles.dayHead}
          >
            <ChevronDown
              className={styles.dayChevron}
              data-expanded={expanded ? 'true' : 'false'}
              aria-hidden
            />
            <span className={styles.dayDate}>{date}</span>
            <span className={styles.dayWeekday}>{weekday}</span>
            {isToday ? <span className={styles.dayToday}>今天</span> : null}
            <span className={styles.dayCounts}>
              <span>{items.length} 条</span>
              <span className={styles.dayCountSeparator} aria-hidden>
                ·
              </span>
              <span>已完成 {counts.sent}</span>
              {counts.failed > 0 ? (
                <>
                  <span className={styles.dayCountSeparator} aria-hidden>
                    ·
                  </span>
                  <span>失败 {counts.failed}</span>
                </>
              ) : null}
              {counts.missing > 0 ? (
                <>
                  <span className={styles.dayCountSeparator} aria-hidden>
                    ·
                  </span>
                  <span>缺失 {counts.missing}</span>
                </>
              ) : null}
            </span>
          </button>
        </td>
      </tr>

      {expanded
        ? items.map((item) => {
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
            const countryLabels = countryList.map((c) => getCountryLabel(c))
            const countriesFullLabel = countryLabels.join(' · ')
            const countriesDisplayLabel =
              countryLabels.length <= 2
                ? countriesFullLabel
                : `${countryLabels[0]} · ${countryLabels[1]} +${countryLabels.length - 2}`

            const sub = subscriptions.find((s) => s.id === item.subscription_id)
            const fallbackModel = sub?.ai_model || modelConfig?.defaultModel || ''
            // 后端 resend / regenerate 端点都要求管理员；`can_resend` 只是
            // 「该状态可重生成」的资格位，不代表当前用户有权限。
            const canTrigger = canTriggerResend
            const summaryBusy =
              regeneratingSummaryKeys.has(item.ledger_key) ||
              item.ai_summary_status === 'generating'
            const summaryFailed = !summaryBusy && item.ai_summary_status === 'failed'
            const showSummaryAction =
              canTriggerResend &&
              item.status === 'sent' &&
              (item.ai_summary_status === 'pending' || item.ai_summary_status === 'failed')
            const status = ledgerStatusDisplay(item)
            const beijingTime = formatLedgerBeijingTime(item.expected_at)
            const summaryTitle = summaryBusy
              ? 'AI 摘要生成中'
              : summaryFailed
                ? item.ai_summary_error || 'AI 摘要生成失败'
                : item.ai_summary || undefined

            return (
              <tr
                key={item.ledger_key}
                className={styles.row}
                data-status={status.tone}
                onClick={() => onRowClick(item)}
              >
                <td
                  className={styles.cellTime}
                  title={beijingTime?.timeWithSeconds}
                >
                  {beijingTime?.time ?? '—'}
                </td>
                <td className={styles.cellProject}>
                  <span className={styles.projectPrimary} title={projectsFullLabel}>
                    {projectsDisplayLabel}
                  </span>
                  <span
                    className={styles.projectSub}
                    title={countriesFullLabel || undefined}
                  >
                    {countriesDisplayLabel || '—'}
                  </span>
                </td>
                <td>
                  <span
                    className={item.email?.trim() ? styles.cellEmail : styles.cellEmailEmpty}
                    title={item.email?.trim() ? item.email : undefined}
                    dir="ltr"
                  >
                    {emailDisplayLabel(item.email)}
                  </span>
                </td>
                <td>
                  <span
                    className={styles.status}
                    data-tone={status.tone}
                    title={item.status === 'failed' ? item.error_message || '生成失败' : undefined}
                  >
                    <span className={styles.statusGlyph} aria-hidden>
                      {status.glyph}
                    </span>
                    <span>{status.label}</span>
                  </span>
                </td>
                <td>
                  {summaryBusy ? (
                    <span className={styles.summaryState} data-tone="busy" title={summaryTitle}>
                      <Loader2 className={styles.spinner} aria-hidden />
                      处理中
                    </span>
                  ) : summaryFailed ? (
                    <span className={styles.summaryLine}>
                      <span
                        className={styles.summaryState}
                        data-tone="failed"
                        title={summaryTitle}
                      >
                        生成失败
                      </span>
                      {showSummaryAction ? (
                        <button
                          type="button"
                          data-testid="row-generate-summary"
                          className={styles.inlineAction}
                          onClick={() => onRegenerateSummary(item)}
                        >
                          <Sparkles aria-hidden />
                          重新生成摘要
                        </button>
                      ) : null}
                    </span>
                  ) : item.ai_summary ? (
                    <span className={styles.summaryText} title={summaryTitle}>
                      {item.ai_summary}
                    </span>
                  ) : (
                    <span className={styles.summaryLine}>
                      <span className={styles.summaryState}>未生成</span>
                      {showSummaryAction ? (
                        <button
                          type="button"
                          data-testid="row-generate-summary"
                          className={styles.inlineAction}
                          onClick={() => onRegenerateSummary(item)}
                        >
                          <Sparkles aria-hidden />
                          生成摘要
                        </button>
                      ) : null}
                    </span>
                  )}
                </td>
                <td>
                  {item.screenshot_r2_thumb_url || item.screenshot_r2_url ? (
                    <button
                      type="button"
                      className={styles.thumbButton}
                      onClick={(event) => {
                        event.stopPropagation()
                        onRowClick(item)
                      }}
                      aria-label="查看报告截图"
                    >
                      {/* 缩略图可能来自未在 next.config 登记的 R2 域名，unoptimized
                          让 next/image 只做尺寸约束，不依赖图片优化服务。 */}
                      <Image
                        src={item.screenshot_r2_thumb_url || item.screenshot_r2_url || ''}
                        alt="报告截图缩略图"
                        width={40}
                        height={52}
                        unoptimized
                        className={styles.thumbImage}
                      />
                    </button>
                  ) : (
                    <span className={styles.thumbNone}>—</span>
                  )}
                </td>
                <td onClick={(event) => event.stopPropagation()}>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.inlineAction}
                      onClick={() => onRowClick(item)}
                    >
                      详情
                    </button>
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
                        onSubmit={(overrideAiModel) => onResend(item, overrideAiModel)}
                      />
                    ) : (
                      <span className={styles.thumbNone}>—</span>
                    )}
                  </div>
                </td>
              </tr>
            )
          })
        : null}
    </tbody>
  )
}
