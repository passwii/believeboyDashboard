'use client'

import type { ReactNode } from 'react'
import { useCallback } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { EmptyTableState } from '@/components/ui/empty-state'

import { SITE_INFO, SITE_BORDER_COLORS, formatRmb, formatUsd, formatPercent, convertToUsd } from './utils'
import type { CommissionProjectMonth, ExchangeRate, ProjectMeta, ProjectGroup, PaymentStatus } from './types'

const FULL_BLEED_TABLE_CLASS = "[&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:py-3 sm:[&_th]:px-4 sm:[&_td]:px-4"
const FULL_BLEED_TABLE_CONTAINER_CLASS = "-m-px h-[calc(100%+2px)] w-[calc(100%+2px)] rounded-none"

function toPaymentLabel(value: PaymentStatus): string {
  if (value === 'paid') return '已回款'
  if (value === 'partial') return '部分回款'
  return '未回款'
}

interface DetailTabProps {
  projectGroups: ProjectGroup[]
  exchangeRates: ExchangeRate[]
  projectMetaById: Record<number, ProjectMeta>
  loading: boolean
  updatingId: number | null
  receivedDraftById: Record<number, string>
  onUpdateDraft: (id: number, value: string) => void
  onUpdatePaymentStatus: (row: CommissionProjectMonth, status: PaymentStatus) => void
  onUpdateReceivedAmount: (row: CommissionProjectMonth) => void
}

export function DetailTab({
  projectGroups,
  exchangeRates,
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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <div className="flex-1 overflow-auto">
        <Table className={FULL_BLEED_TABLE_CLASS} containerClassName={FULL_BLEED_TABLE_CONTAINER_CLASS}>
          <TableHeader className="sticky top-0 z-10 bg-slate-100/80 dark:bg-slate-900/45">
            <TableRow>
              <TableHead className="font-semibold text-foreground">项目</TableHead>
              <TableHead className="text-right font-semibold text-foreground">销售收入</TableHead>
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
            ) : projectGroups.length === 0 ? (
              <EmptyTableState colSpan={6} message="当前月份暂无数据，请先刷新核算" />
            ) : (
              projectGroups.map((group) => {
                if (group.isSingleUS) {
                  const siteRow = group.sites[0]
                  const row = siteRow.record
                  if (!row) return null

                  const siteInfo = SITE_INFO[siteRow.country]
                  const borderColor = SITE_BORDER_COLORS[siteRow.country]

                  return (
                    <TableRow key={row.id} className={`border-l-4 ${borderColor}`}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{siteInfo.flag}</span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                            {siteRow.country}
                          </span>
                          <span>{group.projectName}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="tabular-nums">{formatUsd(row.income_total_usd)}</span>
                      </TableCell>
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
                  )
                }

                // Multi-site project: render each site as a separate row
                const rows: ReactNode[] = []
                for (const siteRow of group.sites) {
                  if (!siteRow.hasData || !siteRow.record) continue

                  const row = siteRow.record
                  const siteInfo = SITE_INFO[siteRow.country]
                  const borderColor = SITE_BORDER_COLORS[siteRow.country]

                  rows.push(
                    <TableRow key={`${group.projectId}-${siteRow.country}`} className={`border-l-4 ${borderColor}`}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{siteInfo.flag}</span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                            {siteRow.country}
                          </span>
                          <span>{group.projectName}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="tabular-nums">{formatUsd(convertToUsd(row.income_total_usd, siteRow.country, exchangeRates))}</span>
                      </TableCell>
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
                  )
                }

                return rows
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}