'use client'

import * as React from 'react'
import { useCallback, useMemo, useState, useEffect, useRef } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyTableState } from '@/components/ui/empty-state'
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

const FULL_BLEED_TABLE_CLASS = '[&_th]:px-0 [&_th]:py-3 [&_td]:px-0 [&_td]:py-3'
const FULL_BLEED_TABLE_CONTAINER_CLASS = 'w-full'

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
    <TableRow className="animate-pulse">
      <TableCell>
        <Skeleton className="h-4 w-32 mx-auto" />
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-center gap-3">
          <Skeleton className="h-2 w-2 rounded-full" />
          <Skeleton className="h-4 w-12" />
        </div>
      </TableCell>
      <TableCell className="text-right">
        <Skeleton className="ml-auto h-5 w-20" />
      </TableCell>
      <TableCell className="text-right">
        <Skeleton className="ml-auto h-5 w-16" />
      </TableCell>
      <TableCell className="text-right">
        <Skeleton className="ml-auto h-5 w-20" />
      </TableCell>
      <TableCell className="text-right">
        <Skeleton className="ml-auto h-9 w-[150px]" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-9 w-[140px]" />
      </TableCell>
    </TableRow>
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <div className="flex-1 overflow-auto">
        <Table
          className={FULL_BLEED_TABLE_CLASS}
          containerClassName={FULL_BLEED_TABLE_CONTAINER_CLASS}
        >
          <TableHeader className="sticky top-0 z-10 bg-slate-100/80 dark:bg-slate-900/45">
            <TableRow>
              <TableHead className="text-center font-semibold text-foreground w-[200px]">
                项目
              </TableHead>
              <TableHead className="text-center font-semibold text-foreground">站点</TableHead>
              <TableHead className="text-center font-semibold text-foreground">销售收入</TableHead>
              <TableHead className="text-center font-semibold text-foreground">佣金比例</TableHead>
              <TableHead className="text-center font-semibold text-foreground">
                工厂佣金(RMB)
              </TableHead>
              <TableHead className="text-center font-semibold text-foreground">
                已回款(RMB)
              </TableHead>
              <TableHead className="text-center font-semibold text-foreground">回款状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((_, i) => (
              <DetailSkeletonRow key={i} />
            ))}
          </TableBody>
        </Table>
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

    return (
      <TableRow key={record.id} className={`border-l-4 ${SITE_BORDER_COLORS[country]}`}>
        {/* 项目名称列 - 使用 rowSpan 合并，只在第一行显示 */}
        {rowSpan > 0 && (
          <TableCell className="text-center" rowSpan={rowSpan}>
            <span className="text-sm font-medium">{projectName}</span>
          </TableCell>
        )}

        {/* 站点列 */}
        <TableCell className="text-center">
          <div className="flex items-center justify-center gap-3">
            <span className={`h-2 w-2 rounded-full ${info.dotClass}`} />
            <span className="text-xs font-medium text-slate-500">{info.label}</span>
          </div>
        </TableCell>

        {/* 销售额列 - 显示本地货币 */}
        <TableCell className="text-center tabular-nums">
          {formatIncomeWithCurrency(record.income_total_usd, country)}
        </TableCell>

        {/* 佣金比例 */}
        <TableCell className="text-center tabular-nums">
          {getCommissionRatioLabel(record)}
        </TableCell>

        {/* 工厂佣金 */}
        <TableCell className="text-center tabular-nums font-medium">
          {formatRmb(record.factory_commission_rmb)}
        </TableCell>

        {/* 已回款 */}
        <TableCell className="text-center">
          <div className="flex items-center justify-center gap-2">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={receivedDraftById[record.id] ?? ''}
              className="h-9 w-[150px] text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
          </div>
        </TableCell>

        {/* 回款状态 */}
        <TableCell className="text-center">
          <Select
            value={record.payment_status}
            onValueChange={(value: PaymentStatus) => {
              onUpdatePaymentStatus(record, value)
            }}
            disabled={updatingId === record.id}
          >
            <SelectTrigger className="w-[140px] mx-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paid">已回款</SelectItem>
              <SelectItem value="partial">部分回款</SelectItem>
              <SelectItem value="unpaid">未回款</SelectItem>
            </SelectContent>
          </Select>
        </TableCell>
      </TableRow>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
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
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit] transition-opacity duration-200"
        style={{ opacity: loading ? 0 : 1 }}
      >
        <div className="flex-1 overflow-auto">
          <Table
            className={FULL_BLEED_TABLE_CLASS}
            containerClassName={FULL_BLEED_TABLE_CONTAINER_CLASS}
          >
            <TableHeader className="sticky top-0 z-10 bg-slate-100/80 dark:bg-slate-900/45">
              <TableRow>
                <TableHead className="text-center font-semibold text-foreground w-[200px]">
                  项目
                </TableHead>
                <TableHead className="text-center font-semibold text-foreground">站点</TableHead>
                <TableHead className="text-center font-semibold text-foreground">
                  销售收入
                </TableHead>
                <TableHead className="text-center font-semibold text-foreground">
                  佣金比例
                </TableHead>
                <TableHead className="text-center font-semibold text-foreground">
                  工厂佣金(RMB)
                </TableHead>
                <TableHead className="text-center font-semibold text-foreground">
                  已回款(RMB)
                </TableHead>
                <TableHead className="text-center font-semibold text-foreground">
                  回款状态
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projectRows.length === 0 ? (
                <EmptyTableState colSpan={7} message="当前月份暂无数据，请先刷新核算" />
              ) : (
                displayData.map((row) => renderRow(row))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
