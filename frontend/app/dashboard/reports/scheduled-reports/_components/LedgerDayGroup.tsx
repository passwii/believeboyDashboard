'use client'

import { useMemo } from 'react'
import { format } from 'date-fns'
import { ChevronDown, Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTable,
  TermTHead,
} from '@/components/terminal/term-table'
import { LedgerResendCell } from './LedgerResendCell'
import { STATUS_LABELS, WEEKDAY_LABELS_SUN_FIRST } from './ledger-constants'
import { TermFrequencyTag, TermStatusPill } from './term-shared'
import type { AIModelConfig, LedgerItem, ResendStage, Subscription } from './types'

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
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          'flex w-full items-center gap-2 px-2 py-1.5 text-left font-mono text-xs transition-colors',
          'hover:bg-term-hover',
          isAnchor ? 'bg-term-raised' : 'bg-term-panel',
          'border-b border-term-border'
        )}
      >
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-term-muted transition-transform',
            !expanded && '-rotate-90'
          )}
        />
        <span className="tabular-nums font-medium text-term-text">{date}</span>
        <span className="text-term-faint">· {weekday}</span>
        {isToday && (
          <span className="rounded-none border border-term-accent/50 px-1.5 py-px text-[10px] uppercase tracking-wider text-term-accent">
            今天
          </span>
        )}
        <span className="tabular-nums text-term-faint">{items.length} 条</span>
        <span className="ml-auto flex items-center gap-1.5">
          {counts.sent > 0 && (
            <TermStatusPill status="sent" label={counts.sent} className="py-0" />
          )}
          {counts.failed > 0 && (
            <TermStatusPill status="failed" label={counts.failed} className="py-0" />
          )}
          {counts.missing > 0 && (
            <TermStatusPill status="missing" label={counts.missing} className="py-0" />
          )}
        </span>
      </button>

      {expanded && (
        <TermTable className="table-fixed" aria-label="台账明细">
          <colgroup>
            <col style={{ width: 88 }} />
            <col style={{ width: 168 }} />
            <col style={{ width: 72 }} />
            <col style={{ width: 168 }} />
            <col style={{ width: 76 }} />
            <col style={{ width: 104 }} />
            <col />
          </colgroup>
          <TermTHead>
            <TermRow>
              <TermHead numeric>应发时间</TermHead>
              <TermHead>项目</TermHead>
              <TermHead>国家</TermHead>
              <TermHead>邮箱</TermHead>
              <TermHead>频率</TermHead>
              <TermHead>状态</TermHead>
              <TermHead numeric>操作</TermHead>
            </TermRow>
          </TermTHead>
          <TermBody>
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
              // BLF-822：行内 AI 摘要快捷操作——仅管理员；报告已发送且摘要
              // pending（尚未生成）或 failed（可重试）时提供入口。
              const regeneratingSummary =
                regeneratingSummaryKeys.has(item.ledger_key) ||
                item.ai_summary_status === 'generating'
              const showSummaryAction =
                canTriggerResend &&
                item.status === 'sent' &&
                (item.ai_summary_status === 'pending' || item.ai_summary_status === 'failed')

              return (
                <TermRow
                  key={item.ledger_key}
                  className="cursor-pointer"
                  onClick={() => onRowClick(item)}
                >
                  <TermCell numeric title={format(new Date(item.expected_at), 'HH:mm:ss')}>
                    {format(new Date(item.expected_at), 'HH:mm')}
                  </TermCell>
                  <TermCell title={projectsFullLabel} className="truncate">
                    {projectsDisplayLabel}
                  </TermCell>
                  <TermCell tone="muted" className="whitespace-nowrap">
                    {countryLabel}
                  </TermCell>
                  <TermCell tone="muted" title={item.email || ''} className="truncate">
                    {item.email || <span className="italic text-term-faint">未填写</span>}
                  </TermCell>
                  <TermCell>
                    <TermFrequencyTag frequency={item.frequency} labels={FREQUENCY_LABELS} />
                  </TermCell>
                  <TermCell>
                    <TermStatusPill
                      status={item.status}
                      label={STATUS_LABELS[item.status]}
                      title={item.status === 'failed' ? item.error_message || '发送失败' : undefined}
                      className={cn('cursor-help', !STATUS_LABELS[item.status] && 'px-1')}
                    />
                  </TermCell>
                  <TermCell numeric onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1.5">
                      {regeneratingSummary ? (
                        <span className="inline-flex items-center gap-1 font-mono text-[11px] text-term-accent">
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                          生成中
                        </span>
                      ) : showSummaryAction ? (
                        <button
                          type="button"
                          data-testid="row-generate-summary"
                          className="inline-flex h-7 items-center gap-1 px-2 font-mono text-[11px] text-term-accent transition-colors hover:bg-term-hover disabled:cursor-not-allowed disabled:opacity-60"
                          onClick={() => onRegenerateSummary(item)}
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
                          onRequestModelConfig={onRequestModelConfig}
                          fallbackModel={fallbackModel}
                          onLoading={() => onResendLoading(item)}
                          onSubmit={(overrideAiModel) => onResend(item, overrideAiModel)}
                        />
                      ) : (
                        <span className="font-mono text-xs text-term-faint">—</span>
                      )}
                    </div>
                  </TermCell>
                </TermRow>
              )
            })}
          </TermBody>
        </TermTable>
      )}
    </div>
  )
}
