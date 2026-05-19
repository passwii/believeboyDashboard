'use client'

import { useCallback } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { EmptyTableState } from '@/components/ui/empty-state'

type PaymentStatus = 'paid' | 'partial' | 'unpaid'

type CommissionProjectMonth = {
  id: number
  report_month: string
  project_id: number
  project_name: string
  income_total_usd: number
  factory_commission_rate: number
  factory_commission_rmb: number
  payment_status: PaymentStatus
  received_rmb: number
  note: string | null
}

type ProjectMeta = {
  id: number
  commission_basis: string | null
  commission_rate: number | null
}

const FULL_BLEED_TABLE_CLASS = "[&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:py-3 sm:[&_th]:px-4 sm:[&_td]:px-4"
const FULL_BLEED_TABLE_CONTAINER_CLASS = "-m-px h-[calc(100%+2px)] w-[calc(100%+2px)] rounded-none"

function formatUsd(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}$${text}`
}

function formatRmb(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}¥${text}`
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function toPaymentLabel(value: PaymentStatus): string {
  if (value === 'paid') return '已回款'
  if (value === 'partial') return '部分回款'
  return '未回款'
}

interface DetailTabProps {
  rows: CommissionProjectMonth[]
  projectMetaById: Record<number, ProjectMeta>
  loading: boolean
  updatingId: number | null
  receivedDraftById: Record<number, string>
  onUpdateDraft: (id: number, value: string) => void
  onUpdatePaymentStatus: (row: CommissionProjectMonth, status: PaymentStatus) => void
  onUpdateReceivedAmount: (row: CommissionProjectMonth) => void
}

export function DetailTab({
  rows,
  projectMetaById,
  loading,
  updatingId,
  receivedDraftById,
  onUpdateDraft,
  onUpdatePaymentStatus,
  onUpdateReceivedAmount,
}: DetailTabProps) {
  const getDetailCommissionRatioLabel = useCallback((row: CommissionProjectMonth): string => {
    const projectMeta = projectMetaById[row.project_id]
    if (!projectMeta) {
      return formatPercent(row.factory_commission_rate)
    }
    if (projectMeta.commission_basis === 'cash_received') {
      return '阶梯(7/10/13/15%)'
    }
    if (typeof projectMeta.commission_rate === 'number' && Number.isFinite(projectMeta.commission_rate)) {
      return formatPercent(projectMeta.commission_rate)
    }
    return formatPercent(row.factory_commission_rate)
  }, [projectMetaById])

  const sortedRows = [...rows].sort((a, b) => a.project_id - b.project_id)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <div className="flex-1 overflow-auto">
        <Table className={FULL_BLEED_TABLE_CLASS} containerClassName={FULL_BLEED_TABLE_CONTAINER_CLASS}>
          <TableHeader className="sticky top-0 z-10 bg-slate-100/80 dark:bg-slate-900/45">
            <TableRow>
              <TableHead className="font-semibold text-foreground">项目</TableHead>
              <TableHead className="text-right font-semibold text-foreground">销售收入(USD)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">佣金比例</TableHead>
              <TableHead className="text-right font-semibold text-foreground">工厂佣金(RMB)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">已回款(RMB，可编辑)</TableHead>
              <TableHead className="font-semibold text-foreground">回款状态(可编辑)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">加载中...</TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <EmptyTableState colSpan={6} message="当前月份暂无数据，请先刷新核算" />
            ) : (
              sortedRows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.project_name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsd(row.income_total_usd)}</TableCell>
                  <TableCell className="text-right tabular-nums">{getDetailCommissionRatioLabel(row)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatRmb(row.factory_commission_rmb)}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={receivedDraftById[row.id] ?? ''}
                        className="h-9 w-[150px] text-right"
                        onChange={(event) => {
                          const nextValue = event.target.value
                          onUpdateDraft(row.id, nextValue)
                        }}
                        onBlur={() => {
                          onUpdateReceivedAmount(row)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            onUpdateReceivedAmount(row)
                          }
                        }}
                        disabled={updatingId === row.id}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={row.payment_status}
                      onValueChange={(value: PaymentStatus) => {
                        onUpdatePaymentStatus(row, value)
                      }}
                      disabled={updatingId === row.id}
                    >
                      <SelectTrigger className="w-[140px]">
                        <SelectValue placeholder={toPaymentLabel(row.payment_status)} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="paid">已回款</SelectItem>
                        <SelectItem value="partial">部分回款</SelectItem>
                        <SelectItem value="unpaid">未回款</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}