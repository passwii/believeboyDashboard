'use client'

import { useMemo } from 'react'
import { format } from 'date-fns'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">应发时间</TableHead>
              <TableHead>项目</TableHead>
              <TableHead className="w-24">国家</TableHead>
              <TableHead className="w-44">邮箱</TableHead>
              <TableHead className="w-16">频率</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead className="w-28 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map(item => {
              const projectLabel =
                item.project_names?.length > 0
                  ? item.project_names.join(' · ')
                  : item.project_ids === '*'
                    ? '全部项目'
                    : item.project_ids
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
                  <TableCell className="text-sm whitespace-nowrap tabular-nums">
                    {format(new Date(item.expected_at), 'HH:mm')}
                  </TableCell>
                  <TableCell>
                    <span className="block max-w-[260px] truncate text-sm" title={projectLabel}>
                      {projectLabel}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{countryLabel}</TableCell>
                  <TableCell>
                    <span className="block max-w-[180px] truncate text-xs text-muted-foreground" title={item.email}>
                      {item.email}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge className={cn('text-[10px]', FREQUENCY_COLORS[item.frequency])}>
                      {FREQUENCY_LABELS[item.frequency]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
                        STATUS_BG[item.status],
                      )}
                    >
                      {item.status === 'sent' && '✓'}
                      {item.status === 'failed' && '✗'}
                      {item.status === 'missing' && '⚠'}
                      {STATUS_LABELS[item.status]}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" onClick={e => e.stopPropagation()}>
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
