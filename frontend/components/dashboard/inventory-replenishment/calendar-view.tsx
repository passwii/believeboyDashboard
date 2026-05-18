'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bar, Cell, ComposedChart, ReferenceArea, ReferenceLine, XAxis, YAxis } from 'recharts'
import { CalendarDays, RefreshCw, AlertTriangle, TrendingDown } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DataCard,
  DataCardHeader,
  DataCardContent,
} from '@/components/ui/data-card'
import { MultiSelect, type Option } from '@/components/ui/multi-select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useNotifications } from '@/components/notifications'
import { cn } from '@/lib/utils'

const API_BASE = '/api/backend'

type CalendarRow = {
  project_id: number
  project_name: string
  sku: string
  country: string
  risk_status: string
  today: string
  sellout_date: string | null
  order_date: string | null
  warehouse_entry_date: string | null
  available_inventory: number
  in_transit_quantity: number
  weighted_dms: number | null
  estimated_quantity: number | null
  is_slow_moving: boolean
  is_critical: boolean
}

type CalendarResponse = {
  items: CalendarRow[]
  page: number
  page_size: number
  total: number
  has_next: boolean
}

const RISK_OPTIONS: Option[] = [
  { value: '长期断货', label: '长期断货' },
  { value: '短期断货', label: '短期断货' },
  { value: '断货风险', label: '断货风险' },
  { value: '健康库存', label: '健康库存' },
  { value: '滞销', label: '滞销' },
  { value: '严重滞销', label: '严重滞销' },
  { value: '待补数据', label: '待补数据' },
]

function authHeaders(): Record<string, string> {
  return {}
}

async function parseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string }
    return payload.detail || `请求失败 (${response.status})`
  } catch {
    const text = await response.text()
    return text || `请求失败 (${response.status})`
  }
}

// Date utilities
function parseDate(dateStr: string | null): Date | null {
  if (!dateStr) return null
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function diffDays(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86400000)
}

function formatDateShort(date: Date): string {
  const m = date.getMonth() + 1
  const d = date.getDate()
  return `${m}/${d}`
}

interface GanttBarProps {
  x?: number
  y?: number
  width?: number
  height?: number
  fill?: string
}

function GanttBar(props: GanttBarProps) {
  const { x = 0, y = 0, width = 0, height = 0, fill = '#3b82f6' } = props
  if (width <= 0 || height <= 0) return null
  return (
    <g>
      <rect
        x={x}
        y={y + height * 0.15}
        width={Math.max(width, 8)}
        height={height * 0.7}
        fill={fill}
        rx={4}
        ry={4}
      />
    </g>
  )
}

function CustomBar(props: { x?: number; y?: number; width?: number; height?: number; fill?: string }) {
  const { x = 0, y = 0, width = 0, height = 0 } = props
  if (width <= 0) return null
  return (
    <rect
      x={x}
      y={y + height * 0.2}
      width={Math.max(width, 12)}
      height={height * 0.6}
      fill={props.fill || '#3b82f6'}
      rx={3}
      ry={3}
    />
  )
}

interface CalendarViewProps {
  projectId: number | null
  country: string
}

export function CalendarView({ projectId, country }: CalendarViewProps) {
  const { notify } = useNotifications()

  const [riskFilter, setRiskFilter] = useState<string[]>([])
  const [dateFrom, setDateFrom] = useState<Date | undefined>()
  const [dateTo, setDateTo] = useState<Date | undefined>()
  const [rows, setRows] = useState<CalendarRow[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const latestRequestRef = useRef(0)

  // Build chart data
  const chartData = useMemo(() => {
    if (rows.length === 0) return null

    const today = parseDate(rows[0]?.today) || new Date()
    const allDates: Date[] = []

    rows.forEach((row) => {
      const dates = [row.sellout_date, row.order_date, row.warehouse_entry_date]
      dates.forEach((d) => {
        if (d) {
          const date = parseDate(d)
          if (date) allDates.push(date)
        }
      })
    })

    if (allDates.length === 0) {
      allDates.push(today, addDays(today, 30))
    }

    const minDate = new Date(Math.min(...allDates.map((d) => d.getTime())))
    const maxDate = new Date(Math.max(...allDates.map((d) => d.getTime())))

    // Add buffer days
    const startDate = addDays(minDate, -7)
    const endDate = addDays(maxDate, 14)

    const dayCount = diffDays(endDate, startDate) + 1
    const dateMarkers: { date: string; label: string; isWeekend: boolean; isToday: boolean; dayIndex: number }[] = []

    for (let i = 0; i < dayCount; i++) {
      const d = addDays(startDate, i)
      const dayOfWeek = d.getDay()
      dateMarkers.push({
        date: formatDate(d),
        label: formatDateShort(d),
        isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
        isToday: formatDate(d) === formatDate(today),
        dayIndex: i,
      })
    }

    const dayWidth = 28
    const todayX = diffDays(today, startDate) * dayWidth + dayWidth / 2
    const startEpoch = startDate.getTime()

    const items = rows.map((row, index) => {

      let orderX: number | null = null
      let orderWidth: number | null = null
      let warehouseX: number | null = null
      let selloutX: number | null = null
      let transitColor = '#3b82f6'

      if (row.order_date && row.warehouse_entry_date) {
        const orderDate = parseDate(row.order_date)
        const warehouseDate = parseDate(row.warehouse_entry_date)
        if (orderDate && warehouseDate) {
          orderX = diffDays(orderDate, startDate) * dayWidth
          const endX = diffDays(warehouseDate, startDate) * dayWidth + dayWidth
          orderWidth = endX - orderX
          warehouseX = endX
        }
      }

      if (row.sellout_date) {
        const selloutDate = parseDate(row.sellout_date)
        if (selloutDate) {
          selloutX = diffDays(selloutDate, startDate) * dayWidth + dayWidth / 2
        }
      }

      // Color coding
      if (row.is_critical) {
        transitColor = '#ef4444'
      } else if (row.is_slow_moving) {
        transitColor = '#f59e0b'
      } else if (row.risk_status === '健康库存') {
        transitColor = '#10b981'
      }

      return {
        ...row,
        index,
        label: `${row.project_name} / ${row.sku}`,
        orderX,
        orderWidth,
        warehouseX,
        selloutX,
        todayX,
        transitColor,
        rowHeight: 48,
      }
    })

    return {
      items,
      dateMarkers,
      chartWidth: dayCount * dayWidth,
      dayWidth,
      startDate,
      endDate,
      todayX: todayX,
      todayDate: formatDate(today),
    }
  }, [rows])

  const loadData = useCallback(async () => {
    if (!projectId) {
      setRows([])
      return
    }

    const requestId = latestRequestRef.current + 1
    latestRequestRef.current = requestId
    setLoading(true)

    try {
      const params = new URLSearchParams({
        project_id: String(projectId),
        country,
        page: '1',
        page_size: '100',
      })

      if (riskFilter.length > 0) {
        params.set('risk_status', riskFilter.join(','))
      }
      if (dateFrom) params.set('date_from', formatDate(dateFrom))
      if (dateTo) params.set('date_to', formatDate(dateTo))

      const response = await fetch(`${API_BASE}/api/v1/inventory-replenishment-calendar?${params.toString()}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(await parseError(response))

      const payload = (await response.json()) as CalendarResponse

      if (requestId !== latestRequestRef.current) return
      setRows(payload.items)
    } catch (loadError) {
      if (requestId !== latestRequestRef.current) return
      setRows([])
      notify({ type: 'error', title: '日历数据加载失败', message: loadError instanceof Error ? loadError.message : '加载失败' })
    } finally {
      if (requestId === latestRequestRef.current) setLoading(false)
    }
  }, [projectId, country, riskFilter, dateFrom, dateTo, notify])

  useEffect(() => {
    void loadData()
  }, [loadData])

  async function handleRefresh() {
    if (!projectId || refreshing) return
    setRefreshing(true)
    try {
      await loadData()
    } finally {
      setRefreshing(false)
    }
  }

  const rowCount = rows.length
  const criticalCount = rows.filter((r) => r.is_critical).length
  const slowMovingCount = rows.filter((r) => r.is_slow_moving).length

  const statItems = [
    { label: 'SKU 总数', value: rowCount, icon: CalendarDays },
    { label: '断货风险', value: criticalCount, icon: AlertTriangle, alert: criticalCount > 0 },
    { label: '滞销警告', value: slowMovingCount, icon: TrendingDown, alert: slowMovingCount > 0 },
  ]

  return (
    <div className="space-y-4">
      <DataCard>
        <DataCardHeader
          title="补货日历"
          badge={<p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">日历视图</p>}
          action={
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!projectId || loading}
                onClick={() => void handleRefresh()}
              >
                <RefreshCw className={cn('mr-1.5 h-4 w-4', refreshing && 'animate-spin')} />
                {refreshing ? '加载中...' : '刷新'}
              </Button>
            </div>
          }
        />
        <DataCardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">风险状态:</span>
              <MultiSelect
                options={RISK_OPTIONS}
                selected={riskFilter}
                onChange={setRiskFilter}
                placeholder="全部状态"
                className="w-48"
              />
            </div>
          </div>

          {/* Stats */}
          <div className="flex flex-wrap gap-3">
            {statItems.map((item) => (
              <div
                key={item.label}
                className={cn(
                  'flex items-center gap-2 rounded-lg border border-border/70 bg-[hsl(var(--surface-soft))]/80 px-3 py-2',
                  item.alert && 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/30'
                )}
              >
                <item.icon className={cn('h-4 w-4 text-muted-foreground', item.alert && 'text-red-500')} />
                <span className="text-xs text-muted-foreground">{item.label}</span>
                <span className={cn('text-sm font-semibold text-foreground', item.alert && 'text-red-600 dark:text-red-400')}>
                  {item.value}
                </span>
              </div>
            ))}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-4 rounded bg-blue-500" />
              <span>补货窗口</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-4 rounded bg-emerald-500" />
              <span>健康库存</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-4 rounded bg-amber-500" />
              <span>滞销警告</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-4 rounded bg-red-500" />
              <span>断货风险</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-4 rounded border-2 border-red-500 bg-transparent" />
              <span>预计断货日</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-3 w-4 border-b-2 border-dashed border-violet-500" />
              <span>今日</span>
            </div>
          </div>
        </DataCardContent>
      </DataCard>

      {/* Gantt Chart */}
      <DataCard>
        <DataCardContent className="p-0">
          {!projectId ? (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              请先选择项目
            </div>
          ) : loading && rows.length === 0 ? (
            <div className="space-y-3 p-6">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              当前筛选条件下没有可显示的 SKU
            </div>
          ) : !chartData ? (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              日历数据加载中...
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-max">
                <TooltipProvider>
                  {/* Header with dates */}
                  <div className="flex border-b border-border/70 bg-[hsl(var(--surface-soft))]/50">
                    <div className="sticky left-0 z-10 w-64 shrink-0 border-r border-border/70 bg-[hsl(var(--surface-panel))]/95 px-3 py-2">
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">SKU</span>
                    </div>
                    <div className="relative" style={{ width: chartData.chartWidth }}>
                      <div className="flex">
                        {chartData.dateMarkers.map((marker, i) => (
                          <div
                            key={marker.date}
                            className={cn(
                              'relative flex-shrink-0 border-r border-border/30 py-2 text-center text-[10px]',
                              marker.isToday && 'bg-violet-100/50 font-semibold text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
                              marker.isWeekend && 'bg-muted/30'
                            )}
                            style={{ width: chartData.dayWidth }}
                          >
                            <div className="text-[10px] text-muted-foreground">{marker.label}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Gantt rows */}
                  {chartData.items.map((item) => (
                    <div key={`${item.sku}-${item.country}`} className="flex border-b border-border/50 hover:bg-[hsl(var(--surface-soft))]/50">
                      {/* SKU label */}
                      <div className="sticky left-0 z-10 flex w-64 shrink-0 items-center gap-2 border-r border-border/70 bg-[hsl(var(--surface-panel))]/95 px-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-foreground">{item.sku}</div>
                          <div className="truncate text-[10px] text-muted-foreground">{item.project_name}</div>
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant="outline"
                              className={cn(
                                'shrink-0 text-[10px]',
                                item.is_critical && 'border-red-200 bg-red-100 text-red-700 dark:border-red-900/50 dark:bg-red-950/50 dark:text-red-300',
                                item.is_slow_moving && 'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/50 dark:text-amber-300',
                                !item.is_critical && !item.is_slow_moving && 'border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground'
                              )}
                            >
                              {item.risk_status.slice(0, 3)}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="max-w-xs">
                            <div className="space-y-1 text-xs">
                              <div className="font-semibold">{item.sku}</div>
                              <div className="text-muted-foreground">{item.project_name}</div>
                              <div className="border-t border-border/50 pt-1">
                                <div>风险状态: {item.risk_status}</div>
                                <div>店铺库存: {item.available_inventory}</div>
                                <div>在途: {item.in_transit_quantity}</div>
                                {item.weighted_dms && <div>加权DMS: {item.weighted_dms.toFixed(2)}</div>}
                                {item.sellout_date && <div>预计断货: {item.sellout_date}</div>}
                                {item.order_date && <div>建议下单: {item.order_date}</div>}
                                {item.warehouse_entry_date && <div>预计入仓: {item.warehouse_entry_date}</div>}
                                {item.estimated_quantity && <div>建议补货: {item.estimated_quantity}</div>}
                              </div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </div>

                      {/* Timeline */}
                      <div className="relative h-12" style={{ width: chartData.chartWidth }}>
                        {/* Weekend backgrounds */}
                        {chartData.dateMarkers.map((marker) =>
                          marker.isWeekend ? (
                            <div
                              key={marker.date}
                              className="absolute top-0 h-full bg-muted/20"
                              style={{ left: marker.dayIndex * chartData.dayWidth, width: chartData.dayWidth }}
                            />
                          ) : null
                        )}

                        {/* Today line */}
                        <div
                          className="absolute top-0 h-full w-0 border-l-2 border-dashed border-violet-500"
                          style={{ left: chartData.todayX - 1 }}
                        />

                        {/* Order window bar */}
                        {item.orderX !== null && item.orderWidth !== null && item.orderWidth > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className="absolute top-2 h-8 cursor-pointer rounded"
                                style={{
                                  left: item.orderX,
                                  width: item.orderWidth,
                                  backgroundColor: item.transitColor,
                                  opacity: 0.75,
                                }}
                              />
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="text-xs">
                                <div className="font-semibold">补货窗口</div>
                                <div className="text-muted-foreground">
                                  {item.order_date} → {item.warehouse_entry_date}
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        )}

                        {/* Sellout marker */}
                        {item.selloutX !== null && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className={cn(
                                  'absolute top-1 h-10 w-0 cursor-pointer border-l-2',
                                  item.is_critical ? 'border-red-500' : item.is_slow_moving ? 'border-amber-500' : 'border-gray-400'
                                )}
                                style={{ left: item.selloutX - 1 }}
                              >
                                <div
                                  className={cn(
                                    'absolute -top-1 left-1/2 -translate-x-1/2 rounded-full border-2 px-1.5 py-0.5 text-[9px] font-semibold',
                                    item.is_critical && 'border-red-500 bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
                                    item.is_slow_moving && 'border-amber-500 bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
                                    !item.is_critical && !item.is_slow_moving && 'border-gray-400 bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
                                  )}
                                >
                                  断货
                                </div>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="text-xs">
                                <div className="font-semibold">预计断货日</div>
                                <div className="text-muted-foreground">{item.sellout_date}</div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  ))}
                </TooltipProvider>
              </div>
            </div>
          )}
        </DataCardContent>
      </DataCard>
    </div>
  )
}