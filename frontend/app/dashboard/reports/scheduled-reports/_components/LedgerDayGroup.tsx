'use client'

import { useMemo } from 'react'
import { format } from 'date-fns'
import { ChevronDown, Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ColGroup,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LedgerResendCell } from './LedgerResendCell'
import {
  FREQUENCY_COLORS,
  FREQUENCY_LABELS,
  STATUS_BG,
  STATUS_LABELS,
  WEEKDAY_LABELS_SUN_FIRST,
} from './ledger-constants'
import type { AIModelConfig, LedgerItem, ResendStage, Subscription } from './types'

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
        className={cn(
          'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors',
          'hover:bg-muted/60',
          isAnchor ? 'bg-muted/40' : 'bg-muted/20',
          'border-b border-border/60'
        )}
      >
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            !expanded && '-rotate-90'
          )}
        />
        <span className="text-sm font-medium">{date}</span>
        <span className="text-xs text-muted-foreground">· {weekday}</span>
        {isToday && (
          <Badge
            variant="secondary"
            className="bg-blue-100 text-blue-700 hover:bg-blue-100 text-[10px] px-1.5 py-0"
          >
            今天
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">{items.length} 条</span>
        <span className="ml-auto flex items-center gap-1.5 text-[11px]">
          {counts.sent > 0 && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
                STATUS_BG.sent
              )}
            >
              ✓ {counts.sent}
            </span>
          )}
          {counts.failed > 0 && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
                STATUS_BG.failed
              )}
            >
              ✗ {counts.failed}
            </span>
          )}
          {counts.missing > 0 && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
                STATUS_BG.missing
              )}
            >
              ⚠ {counts.missing}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <Table tableLayout="fixed">
          <ColGroup
            columns={[
              { width: 96 },
              { width: 176 },
              { width: 80 },
              { width: 176 },
              { width: 80 },
              { width: 112 },
              { width: 176 },
            ]}
          />
          <TableHeader>
            <TableRow>
              <TableHead>应发时间</TableHead>
              <TableHead>项目</TableHead>
              <TableHead>国家</TableHead>
              <TableHead>邮箱</TableHead>
              <TableHead>频率</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
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
                <TableRow
                  key={item.ledger_key}
                  className="cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => onRowClick(item)}
                >
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {format(new Date(item.expected_at), 'HH:mm')}
                  </TableCell>
                  <TableCell className="truncate" title={projectsFullLabel}>
                    {projectsDisplayLabel}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {countryLabel}
                  </TableCell>
                  <TableCell
                    className="truncate text-xs text-muted-foreground"
                    title={item.email || ''}
                  >
                    {item.email || <span className="italic text-muted-foreground/70">未填写</span>}
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={cn(
                        'whitespace-nowrap text-[10px]',
                        FREQUENCY_COLORS[item.frequency]
                      )}
                    >
                      {FREQUENCY_LABELS[item.frequency]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span
                      title={item.status === 'failed' ? item.error_message || '发送失败' : undefined}
                      className={cn(
                        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px]',
                        STATUS_BG[item.status]
                      )}
                    >
                      {item.status === 'sent' && '✓'}
                      {item.status === 'failed' && '✗'}
                      {item.status === 'missing' && '⚠'}
                      {STATUS_LABELS[item.status]}
                    </span>
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-end gap-1.5">
                      {regeneratingSummary ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-violet-600 dark:text-violet-400">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          生成中
                        </span>
                      ) : showSummaryAction ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid="row-generate-summary"
                          className="h-7 px-2 text-xs text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
                          onClick={() => onRegenerateSummary(item)}
                        >
                          <Sparkles className="mr-0.5 h-3 w-3" />
                          {item.ai_summary_status === 'failed' ? '重新生成' : '生成摘要'}
                        </Button>
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
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
