'use client'

import { useMemo } from 'react'
import { format } from 'date-fns'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, ColGroup } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
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
  resendingStates: Record<string, ResendStage>
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
  resendingStates,
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
          'border-b border-border/60',
        )}
      >
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            !expanded && '-rotate-90',
          )}
        />
        <span className="text-sm font-medium">{date}</span>
        <span className="text-xs text-muted-foreground">· {weekday}</span>
        {isToday && (
          <Badge variant="secondary" className="bg-blue-100 text-blue-700 hover:bg-blue-100 text-[10px] px-1.5 py-0">
            今天
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">{items.length} 条</span>
        <span className="ml-auto flex items-center gap-1.5 text-[11px]">
          {counts.sent > 0 && (
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5', STATUS_BG.sent)}>
              ✓ {counts.sent}
            </span>
          )}
          {counts.failed > 0 && (
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5', STATUS_BG.failed)}>
              ✗ {counts.failed}
            </span>
          )}
          {counts.missing > 0 && (
            <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5', STATUS_BG.missing)}>
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
            {items.map(item => {
              const projectNames = item.project_names?.length > 0
                ? item.project_names
                : item.project_ids === '*'
                  ? ['全部项目']
                  : item.project_ids.split(',').filter(Boolean)
              const projectsFullLabel = projectNames.join(' · ')
              const projectsDisplayLabel = projectNames.length <= 2
                ? projectsFullLabel
                : `${projectNames[0]} · ${projectNames[1]} +${projectNames.length - 2}`
              const countryList = item.country
                .split(',')
                .map(c => c.trim())
                .filter(Boolean)
              const countryLabel =
                countryList.length === 0
                  ? '—'
                  : countryList.length === 1
                    ? countryList[0]
                    : `${countryList[0]} +${countryList.length - 1}`
              const sub = subscriptions.find(s => s.id === item.subscription_id)
              const fallbackModel = sub?.ai_model || modelConfig?.defaultModel || ''
              const canTrigger = canTriggerResend || item.can_resend

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
                  <TableCell className="truncate text-xs text-muted-foreground" title={item.email}>
                    {item.email}
                  </TableCell>
                  <TableCell>
                    <Badge className={cn('whitespace-nowrap text-[10px]', FREQUENCY_COLORS[item.frequency])}>
                      {FREQUENCY_LABELS[item.frequency]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px]',
                        STATUS_BG[item.status],
                      )}
                    >
                      {item.status === 'sent' && '✓'}
                      {item.status === 'failed' && '✗'}
                      {item.status === 'missing' && '⚠'}
                      {STATUS_LABELS[item.status]}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right" onClick={e => e.stopPropagation()}>
                    {canTrigger ? (
                      <LedgerResendCell
                        item={item}
                        resendingStage={resendingStates[item.ledger_key]}
                        canResend
                        modelConfig={modelConfig}
                        isLoadingModelConfig={isLoadingModelConfig}
                        fallbackModel={fallbackModel}
                        onLoading={() => onResendLoading(item)}
                        onSubmit={(overrideAiModel) => onResend(item, overrideAiModel)}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
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
