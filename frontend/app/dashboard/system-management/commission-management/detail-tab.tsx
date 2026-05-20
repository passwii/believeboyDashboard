'use client'

import * as React from 'react'
import { useCallback } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { EmptyTableState } from '@/components/ui/empty-state'
import {
  type CommissionProjectMonth,
  type ExchangeRate,
  type ProjectMeta,
  type ProjectGroup,
  type PaymentStatus,
  type SiteRow,
} from './types'
import {
  SITE_INFO,
  SITE_BORDER_COLORS,
  convertToUsd,
  formatUsd,
  formatPercent,
} from './utils'

const FULL_BLEED_TABLE_CLASS = "[&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:py-3 sm:[&_th]:px-4 sm:[&_td]:px-4"
const FULL_BLEED_TABLE_CONTAINER_CLASS = "-m-px h-[calc(100%+2px)] w-[calc(100%+2px)] rounded-none"

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
  const getCommissionRatioLabel = useCallback((row: CommissionProjectMonth): string => {
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

  const renderSiteRow = (site: SiteRow, projectName?: string) => {
    const { country, hasData, record } = site
    const info = SITE_INFO[country]

    if (!hasData || !record) {
      return (
        <TableRow key={`nodata-${country}`} className="bg-gray-50/50">
          <TableCell>
            <div className="flex items-center gap-2">
              <span className="text-lg">{info.flag}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                {country}
              </span>
              {projectName && <span className="text-sm text-muted-foreground">{projectName}</span>}
            </div>
          </TableCell>
          <TableCell className="text-right text-gray-400">无数据</TableCell>
          <TableCell className="text-right text-gray-400">无数据</TableCell>
          <TableCell className="text-right text-gray-400">无数据</TableCell>
          <TableCell className="text-gray-400">无数据</TableCell>
          <TableCell className="text-gray-400">无数据</TableCell>
        </TableRow>
      )
    }

    const incomeUsd = convertToUsd(record.income_total_usd, country, exchangeRates)
    const commissionUsd = convertToUsd(record.factory_commission_rmb, country, exchangeRates)

    return (
      <TableRow
        key={record.id}
        className={`border-l-4 ${SITE_BORDER_COLORS[country]}`}
      >
        <TableCell>
          <div className="flex items-center gap-2">
            <span className="text-lg">{info.flag}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
              {country}
            </span>
            {projectName && <span className="text-sm text-muted-foreground">{projectName}</span>}
          </div>
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {formatUsd(incomeUsd)}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {getCommissionRatioLabel(record)}
        </TableCell>
        <TableCell className="text-right tabular-nums font-medium">
          {formatUsd(commissionUsd)}
        </TableCell>
        <TableCell>
          <div className="flex items-center justify-end gap-2">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={receivedDraftById[record.id] ?? ''}
              className="h-9 w-[150px] text-right"
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
        <TableCell>
          <Select
            value={record.payment_status}
            onValueChange={(value: PaymentStatus) => {
              onUpdatePaymentStatus(record, value)
            }}
            disabled={updatingId === record.id}
          >
            <SelectTrigger className="w-[140px]">
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <div className="flex-1 overflow-auto">
        <Table className={FULL_BLEED_TABLE_CLASS} containerClassName={FULL_BLEED_TABLE_CONTAINER_CLASS}>
          <TableHeader className="sticky top-0 z-10 bg-slate-100/80 dark:bg-slate-900/45">
            <TableRow>
              <TableHead className="font-semibold text-foreground">项目</TableHead>
              <TableHead className="text-right font-semibold text-foreground">销售收入(USD)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">佣金比例</TableHead>
              <TableHead className="text-right font-semibold text-foreground">工厂佣金(USD)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">已回款(RMB)</TableHead>
              <TableHead className="font-semibold text-foreground">回款状态</TableHead>
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
                  const site = group.sites[0]
                  return renderSiteRow(site, group.projectName)
                }

                return (
                  <React.Fragment key={`group-${group.projectId}`}>
                    <TableRow className="bg-slate-50/50">
                      <TableCell colSpan={6} className="py-2 text-sm font-medium text-muted-foreground">
                        {group.projectName}
                      </TableCell>
                    </TableRow>
                    {group.sites.map(site => renderSiteRow(site))}
                  </React.Fragment>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
