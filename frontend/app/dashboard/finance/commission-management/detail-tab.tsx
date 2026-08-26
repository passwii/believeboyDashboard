'use client'

import * as React from 'react'
import { useCallback, useMemo, useState, useEffect, useRef } from 'react'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  type CommissionProjectMonth,
  type ExchangeRate,
  type ProjectMeta,
  type ProjectRow,
  type PaymentStatus,
} from './types'
import {
  SITE_INFO,
  SITE_BORDER_COLORS,
  formatIncomeWithCurrency,
  formatRmb,
  formatPercent,
} from './utils'

interface DetailTabProps {
  projectRows: ProjectRow[]
  exchangeRates: ExchangeRate[]
  projectMetaById: Record<number, ProjectMeta>
  loading: boolean
  updatingId: number | null
  receivedDraftById: Record<number, string>
  onUpdateDraft: (id: number, value: string) => void
  onUpdatePaymentStatus: (row: CommissionProjectMonth, status: PaymentStatus) => void
  onUpdateReceivedAmount: (row: CommissionProjectMonth) => void
}

// 骨架屏行
function DetailSkeletonRow() {
  return (
    <TermRow className="animate-pulse hover:bg-transparent">
      <TermCell>
        <Skeleton className="mx-auto h-3.5 w-32 rounded-none" />
      </TermCell>
      <TermCell>
        <div className="flex items-center justify-center gap-3">
          <Skeleton className="h-1.5 w-1.5 rounded-none" />
          <Skeleton className="h-3.5 w-10 rounded-none" />
        </div>
      </TermCell>
      <TermCell numeric>
        <Skeleton className="ml-auto h-3.5 w-16 rounded-none" />
      </TermCell>
      <TermCell numeric>
        <Skeleton className="ml-auto h-3.5 w-12 rounded-none" />
      </TermCell>
      <TermCell numeric>
        <Skeleton className="ml-auto h-3.5 w-16 rounded-none" />
      </TermCell>
      <TermCell numeric>
        <Skeleton className="ml-auto h-7 w-[130px] rounded-none" />
      </TermCell>
      <TermCell>
        <Skeleton className="h-7 w-[130px] rounded-none" />
      </TermCell>
    </TermRow>
  )
}

// 骨架屏内容
function DetailSkeletonContent() {
  const rows = [
    { type: 'site' as const },
    { type: 'site' as const },
    { type: 'site' as const },
    { type: 'single' as const },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-auto term-scroll">
        <TermTable>
          <TermTHead>
            <TermRow className="hover:bg-transparent">
              <TermHead className="w-[180px]">项目</TermHead>
              <TermHead>站点</TermHead>
              <TermHead numeric>销售收入</TermHead>
              <TermHead numeric>佣金比例</TermHead>
              <TermHead numeric>工厂佣金(RMB)</TermHead>
              <TermHead numeric>已回款(RMB)</TermHead>
              <TermHead>回款状态</TermHead>
            </TermRow>
          </TermTHead>
          <TermBody>
            {rows.map((_, i) => (
              <DetailSkeletonRow key={i} />
            ))}
          </TermBody>
        </TermTable>
      </div>
    </div>
  )
}

export function DetailTab({
  projectRows,
  exchangeRates,
  projectMetaById,
  loading,
  updatingId,
  receivedDraftById,
  onUpdateDraft,
  onUpdatePaymentStatus,
  onUpdateReceivedAmount,
}: DetailTabProps) {
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [displayData, setDisplayData] = useState(projectRows)
  const prevLoadingRef = useRef(loading)
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 处理过渡动画
  useEffect(() => {
    // 从加载完成变为加载中
    if (prevLoadingRef.current && !loading) {
      // 加载完成 - 立即显示新数据，不做过渡（数据已刷新）
    } else if (!prevLoadingRef.current && loading) {
      // 开始加载 - 如果需要可以添加视觉反馈
    }

    prevLoadingRef.current = loading

    // 清理定时器
    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current)
      }
    }
  }, [loading])

  // 数据更新时平滑过渡
  useEffect(() => {
    if (!loading && projectRows !== displayData) {
      setIsTransitioning(true)
      transitionTimerRef.current = setTimeout(() => {
        setDisplayData(projectRows)
        setIsTransitioning(false)
      }, 200)
    }
  }, [loading, projectRows, displayData])

  const getCommissionRatioLabel = useCallback(
    (record: CommissionProjectMonth): string => {
      const projectMeta = projectMetaById[record.project_id]
      if (!projectMeta) {
        return formatPercent(record.factory_commission_rate)
      }
      if (projectMeta.commission_basis === 'cash_received') {
        return '阶梯(7/10/13/15%)'
      }
      if (
        typeof projectMeta.commission_rate === 'number' &&
        Number.isFinite(projectMeta.commission_rate)
      ) {
        return formatPercent(projectMeta.commission_rate)
      }
      return formatPercent(record.factory_commission_rate)
    },
    [projectMetaById]
  )

  const renderRow = (row: ProjectRow) => {
    const { rowSpan, projectName, record } = row
    const country = record.country as 'US' | 'DE' | 'UK'
    const info = SITE_INFO[country]

    const statusTone =
      record.payment_status === 'paid'
        ? 'pos'
        : record.payment_status === 'unpaid'
          ? 'neg'
          : ('warn' as const)

    return (
      <TermRow key={record.id} className={`border-l-[3px] ${SITE_BORDER_COLORS[country]}`}>
        {/* 项目名称列 - 使用 rowSpan 合并，只在第一行显示 */}
        {rowSpan > 0 && (
          <TermCell rowSpan={rowSpan} title={projectName}>
            <span className="font-medium">{projectName}</span>
          </TermCell>
        )}

        {/* 站点列 */}
        <TermCell tone="muted" className="font-mono uppercase">
          {info.label}
        </TermCell>

        {/* 销售额列 - 显示本地货币 */}
        <TermCell numeric>{formatIncomeWithCurrency(record.income_total_usd, country)}</TermCell>

        {/* 佣金比例 */}
        <TermCell numeric tone="muted">
          {getCommissionRatioLabel(record)}
        </TermCell>

        {/* 工厂佣金 */}
        <TermCell numeric className="font-medium">
          {formatRmb(record.factory_commission_rmb)}
        </TermCell>

        {/* 已回款 */}
        <TermCell>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={receivedDraftById[record.id] ?? ''}
            className="h-7 w-[130px] rounded-none border-term-border bg-term-panel text-right font-mono text-xs shadow-none [appearance:textfield] focus-visible:ring-term-border [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            onChange={(event) => {
              onUpdateDraft(record.id, event.target.value)
            }}
            onBlur={() => {
              onUpdateReceivedAmount(record)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onUpdateReceivedAmount(record)
              }
            }}
            disabled={updatingId === record.id}
          />
        </TermCell>

        {/* 回款状态 */}
        <TermCell>
          <Select
            value={record.payment_status}
            onValueChange={(value: PaymentStatus) => {
              onUpdatePaymentStatus(record, value)
            }}
            disabled={updatingId === record.id}
          >
            <SelectTrigger
              className={cn(
                'h-7 w-[120px] rounded-none border-term-border bg-term-panel text-xs shadow-none',
                statusTone === 'pos' && 'text-term-pos',
                statusTone === 'warn' && 'text-term-warn',
                statusTone === 'neg' && 'text-term-neg'
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paid">已回款</SelectItem>
              <SelectItem value="partial">部分回款</SelectItem>
              <SelectItem value="unpaid">未回款</SelectItem>
            </SelectContent>
          </Select>
        </TermCell>
      </TermRow>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 骨架屏层 */}
      <div
        className="absolute inset-0 transition-opacity duration-200"
        style={{ opacity: loading ? 1 : 0, pointerEvents: loading ? 'auto' : 'none' }}
        aria-hidden={!loading}
      >
        <DetailSkeletonContent />
      </div>

      {/* 内容层 */}
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden transition-opacity duration-200"
        style={{ opacity: loading ? 0 : 1 }}
      >
        <div className="flex-1 overflow-auto term-scroll">
          <TermTable>
            <TermTHead>
              <TermRow className="hover:bg-transparent">
                <TermHead className="w-[180px]">项目</TermHead>
                <TermHead>站点</TermHead>
                <TermHead numeric>销售收入</TermHead>
                <TermHead numeric>佣金比例</TermHead>
                <TermHead numeric>工厂佣金(RMB)</TermHead>
                <TermHead numeric>已回款(RMB)</TermHead>
                <TermHead>回款状态</TermHead>
              </TermRow>
            </TermTHead>
            <TermBody>
              {projectRows.length === 0 ? (
                <TermRow className="hover:bg-transparent">
                  <TermCell colSpan={7} className="h-24 text-center" tone="muted">
                    当前月份暂无数据，请先刷新核算
                  </TermCell>
                </TermRow>
              ) : (
                displayData.map((row) => renderRow(row))
              )}
            </TermBody>
          </TermTable>
        </div>
      </div>
    </div>
  )
}
