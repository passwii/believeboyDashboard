'use client'

import { useCallback, useMemo } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { EmptyTableState } from '@/components/ui/empty-state'
import { ChevronDown, ChevronRight } from 'lucide-react'

type PaymentStatus = 'paid' | 'partial' | 'unpaid'

type CommissionProjectMonth = {
  id: number
  report_month: string
  country: string
  project_id: number
  project_name: string
  income_total_usd: number
  factory_commission_rate: number
  factory_commission_rmb: number
  payment_status: PaymentStatus
  received_rmb: number
  note: string | null
}

type ProjectGroup = {
  project_id: number
  project_name: string
  rows: CommissionProjectMonth[]
  totalIncomeUsd: number
  totalCommissionRmb: number
  totalIncomeUsdConverted: number
}

type ExchangeRate = {
  currency: string
  rate: number
}

type ProjectMeta = {
  id: number
  commission_basis: string | null
  commission_rate: number | null
}

const FULL_BLEED_TABLE_CLASS = "[&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:py-3 sm:[&_th]:px-4 sm:[&_td]:px-4"
const FULL_BLEED_TABLE_CONTAINER_CLASS = "-m-px h-[calc(100%+2px)] w-[calc(100%+2px)] rounded-none"

const CURRENCY_SYMBOL: Record<string, string> = {
  US: '$',
  UK: '£',
  DE: '€',
}

const CURRENCY_LABEL: Record<string, string> = {
  USD: 'USD',
  GBP: 'GBP',
  EUR: 'EUR',
}

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
  projectGroups: {
    groups: ProjectGroup[]
    multiSiteProjects: Set<number>
  }
  exchangeRates: ExchangeRate[]
  projectMetaById: Record<number, ProjectMeta>
  loading: boolean
  updatingId: number | null
  expandedProjects: Set<number>
  onToggleProject: (projectId: number) => void
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
  expandedProjects,
  onToggleProject,
  receivedDraftById,
  onUpdateDraft,
  onUpdatePaymentStatus,
  onUpdateReceivedAmount,
}: DetailTabProps) {
  const { groups, multiSiteProjects } = projectGroups

  const getExchangeRate = useCallback((currency: string): number => {
    const rate = exchangeRates.find(r => r.currency === currency)
    return rate?.rate ?? 1
  }, [exchangeRates])

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

  // 按固定顺序排列站点行
  const sortCountries = (rows: CommissionProjectMonth[]): CommissionProjectMonth[] => {
    const order = ['US', 'DE', 'UK']
    return [...rows].sort((a, b) => {
      const aIndex = order.indexOf(a.country)
      const bIndex = order.indexOf(b.country)
      return aIndex - bIndex
    })
  }

  // 获取指定项目的合计行数据
  const getProjectTotals = useCallback((group: ProjectGroup) => {
    const usdToCnyRate = getExchangeRate('CNY') || 7.2
    let totalIncomeConverted = 0
    let totalCommissionConverted = 0

    for (const row of group.rows) {
      if (row.country === 'US') {
        totalIncomeConverted += row.income_total_usd
        totalCommissionConverted += row.factory_commission_rmb / usdToCnyRate
      } else {
        const countryCurrency = row.country === 'DE' ? 'EUR' : row.country === 'UK' ? 'GBP' : 'USD'
        const countryRate = getExchangeRate(countryCurrency)
        if (countryRate && countryRate > 0) {
          const cnyAmount = row.income_total_usd * countryRate
          totalIncomeConverted += cnyAmount / usdToCnyRate
          totalCommissionConverted += row.factory_commission_rmb / usdToCnyRate
        } else {
          totalIncomeConverted += row.income_total_usd
          totalCommissionConverted += row.factory_commission_rmb / usdToCnyRate
        }
      }
    }

    return { totalIncomeConverted, totalCommissionConverted }
  }, [getExchangeRate])

  // 获取站点标签
  const getCountryLabel = (country: string): { flag: string; name: string } => {
    switch (country) {
      case 'US': return { flag: '🇺🇸', name: '美国站' }
      case 'UK': return { flag: '🇬🇧', name: '英国站' }
      case 'DE': return { flag: '🇩🇪', name: '德国站' }
      default: return { flag: '🏳️', name: country }
    }
  }

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
            ) : groups.length === 0 ? (
              <EmptyTableState colSpan={6} message="当前月份暂无数据，请先刷新核算" />
            ) : (
              groups.map((group) => {
                const isMultiSite = multiSiteProjects.has(group.project_id)
                const isExpanded = expandedProjects.has(group.project_id)
                const sortedRows = sortCountries(group.rows)
                const totals = getProjectTotals(group)

                if (isMultiSite) {
                  // 多站点项目 - 显示可展开的分组
                  return (
                    <>
                      {/* 分组头行 */}
                      <TableRow
                        key={`group-${group.project_id}`}
                        className="cursor-pointer bg-slate-100/50 hover:bg-slate-200/50"
                        onClick={() => onToggleProject(group.project_id)}
                      >
                        <TableCell colSpan={2} className="font-semibold">
                          <div className="flex items-center gap-2">
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                            <span>{group.project_name}</span>
                            <span className="text-xs text-muted-foreground">
                              共 {group.rows.length} 个站点
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="font-medium tabular-nums">{formatUsd(totals.totalIncomeConverted)}</span>
                          <span className="ml-1 text-xs text-muted-foreground">USD</span>
                        </TableCell>
                        <TableCell></TableCell>
                        <TableCell className="text-right">
                          <span className="font-medium tabular-nums">{formatRmb(group.totalCommissionRmb)}</span>
                        </TableCell>
                        <TableCell colSpan={2}></TableCell>
                      </TableRow>

                      {/* 展开的子行 */}
                      {isExpanded && sortedRows.map((row) => {
                        const countryInfo = getCountryLabel(row.country)
                        const currencySymbol = CURRENCY_SYMBOL[row.country] || '$'

                        return (
                          <TableRow key={row.id} className={`
                            border-l-4
                            ${row.country === 'US' ? 'border-l-blue-500' : ''}
                            ${row.country === 'UK' ? 'border-l-green-500' : ''}
                            ${row.country === 'DE' ? 'border-l-purple-500' : ''}
                          `}>
                            <TableCell>
                              <div className="flex items-center gap-2 pl-4">
                                <span className="text-lg">{countryInfo.flag}</span>
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                                  {row.country}
                                </span>
                                <span className="text-sm text-muted-foreground">{countryInfo.name}</span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <span className="tabular-nums">{currencySymbol}{row.income_total_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                              <span className="ml-1 text-xs text-muted-foreground">{CURRENCY_LABEL[row.country === 'US' ? 'USD' : row.country === 'UK' ? 'GBP' : 'EUR']}</span>
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
                      })}

                      {/* 合计行 */}
                      {isExpanded && (
                        <TableRow key={`total-${group.project_id}`} className="bg-slate-50">
                          <TableCell colSpan={2} className="font-medium text-muted-foreground">
                            <span className="pl-10">合计</span>
                          </TableCell>
                          <TableCell className="text-right">
                            <span className="font-semibold tabular-nums">{formatUsd(totals.totalIncomeConverted)}</span>
                            <span className="ml-1 text-xs text-muted-foreground">USD</span>
                          </TableCell>
                          <TableCell className="text-right">
                            <span className="font-semibold tabular-nums">{formatRmb(group.totalCommissionRmb)}</span>
                          </TableCell>
                          <TableCell colSpan={2}></TableCell>
                        </TableRow>
                      )}
                    </>
                  )
                } else {
                  // 单站点项目 - 直接显示一行
                  const row = sortedRows[0]
                  const countryInfo = getCountryLabel(row.country)
                  const currencySymbol = CURRENCY_SYMBOL[row.country] || '$'

                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{countryInfo.flag}</span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                            {row.country}
                          </span>
                          <span>{group.project_name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="tabular-nums">{currencySymbol}{row.income_total_usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                        <span className="ml-1 text-xs text-muted-foreground">{CURRENCY_LABEL[row.country === 'US' ? 'USD' : row.country === 'UK' ? 'GBP' : 'EUR']}</span>
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
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}