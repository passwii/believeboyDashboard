'use client'

import { useEffect, useState, useCallback } from 'react'
import { Monitor, RefreshCw, X, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { cn } from '@/lib/utils'
import { fetchProjectOptionsCached } from '@/lib/project-client-cache'

// ─── types ──────────────────────────────────────────────────────────────────

interface SalesTrendItem {
  date: string
  order_qty: number
  sales_amount: number
  sessions: number
}

interface DisplayData {
  project_id: number
  project_name: string
  country: string
  server_time: string
  sales: {
    today_order_qty: number
    today_sales_amount: number
    today_sessions: number
    today_ordered_sales_amount: number
    prev_order_qty: number
    prev_sales_amount: number
    prev_sessions: number
  }
  sales_trend: SalesTrendItem[]
  inventory: {
    sku_count: number
    out_of_stock_count: number
    available_qty: number
  }
  shipments: {
    in_transit_count: number
    in_transit_qty: number
  }
  returns: {
    total_returns: number
    total_quantity: number
    return_rate: number
    top_reason: string | null
  }
  ads: {
    period_spend: number
    period_sales: number
    period_roas: number
    period_acos: number
    period_ctr: number
    period_impressions: number
    period_clicks: number
    period_orders: number
  }
}

interface Project {
  id: number
  project_name: string
}

// ─── formatters ─────────────────────────────────────────────────────────────

function fmtMoney(v: number) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(v)
}

function fmtNum(v: number) {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(v)
}

function fmtRate(v: number) {
  return `${v.toFixed(1)}%`
}

function changeColor(current: number, prev: number) {
  if (prev === 0) return 'text-foreground'
  const pct = ((current - prev) / prev) * 100
  return pct >= 0 ? 'text-emerald-400' : 'text-red-400'
}

function changeArrow(current: number, prev: number) {
  if (prev === 0) return ''
  const pct = ((current - prev) / prev) * 100
  return pct >= 0 ? '↑' : '↓'
}

function changePct(current: number, prev: number) {
  if (prev === 0) return ''
  const pct = ((current - prev) / prev) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

// ─── sub-components ──────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  accent = 'text-foreground',
  change,
}: {
  label: string
  value: string
  sub?: string
  accent?: string
  change?: string
}) {
  return (
    <div className="rounded-none border border-term-border bg-term-panel p-4 text-center sm:p-5">
      <p className={cn('font-mono text-4xl font-bold tabular-nums sm:text-5xl', accent)}>{value}</p>
      <p className="mt-1 text-base font-medium text-muted-foreground sm:text-lg">{label}</p>
      {sub && <p className="mt-0.5 text-sm text-muted-foreground/60">{sub}</p>}
      {change && <p className="mt-1 text-sm text-muted-foreground/80">{change}</p>}
    </div>
  )
}

function BigKpiCard({
  label,
  value,
  sub,
  accent = 'text-foreground',
}: {
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <div className="rounded-none border border-term-border bg-term-panel p-5 text-center sm:p-6">
      <p className={cn('font-mono text-5xl font-bold tabular-nums sm:text-7xl', accent)}>{value}</p>
      <p className="mt-2 text-lg font-semibold text-muted-foreground sm:text-2xl">{label}</p>
      {sub && <p className="mt-1 text-lg text-muted-foreground/60">{sub}</p>}
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-none border border-term-border bg-term-panel p-5">
      <h3 className="mb-4 text-xl font-semibold text-muted-foreground">{title}</h3>
      {children}
    </div>
  )
}

// ─── main page ───────────────────────────────────────────────────────────────

const POLL_INTERVAL = 30000 // 30s

export default function DigitalDisplayPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [displayData, setDisplayData] = useState<DisplayData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [now, setNow] = useState(new Date())
  const [secondsLeft, setSecondsLeft] = useState(POLL_INTERVAL / 1000)
  const [showProjectMenu, setShowProjectMenu] = useState(false)

  // ── dark mode + fullscreen ──
  useEffect(() => {
    document.documentElement.classList.add('dark')
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {})
    }
    const ticker = setInterval(() => setNow(new Date()), 1000)
    return () => {
      document.documentElement.classList.remove('dark')
      clearInterval(ticker)
    }
  }, [])

  // ── load project list ──
  useEffect(() => {
    const saved = localStorage.getItem('digital-display-project')
    // 复用 projects 列表 2min 客户端缓存（BEL-424）：与首页 / 其他页共享。
    fetchProjectOptionsCached<{ items?: Project[] }>()
      .then((data) => {
        const items = data?.items ?? []
        setProjects(items)
        if (saved) {
          const found = items.find((p: Project) => String(p.id) === saved)
          if (found) setSelectedProjectId(found.id)
        }
        if (!selectedProjectId && items.length > 0) {
          setSelectedProjectId(items[0].id)
        }
      })
      .catch(() => {})
  }, [])

  // ── fetch display data ──
  const fetchData = useCallback(async (projectId: number) => {
    setIsLoading(true)
    try {
      const params = new URLSearchParams({ country: 'US', days: '7' })
      const res = await fetch(`/api/backend/api/v1/digital-display/${projectId}?${params}`, {
        cache: 'no-store',
      })
      if (res.ok) {
        const data: DisplayData = await res.json()
        setDisplayData(data)
        setSecondsLeft(POLL_INTERVAL / 1000)
      }
    } catch {
      // silently fail, keep stale data
    } finally {
      setIsLoading(false)
    }
  }, [])

  // ── poll + project change ──
  useEffect(() => {
    if (!selectedProjectId) return
    fetchData(selectedProjectId)

    const pollTimer = setInterval(() => {
      if (selectedProjectId) fetchData(selectedProjectId)
    }, POLL_INTERVAL)

    return () => clearInterval(pollTimer)
  }, [selectedProjectId, fetchData])

  // ── countdown ticker ──
  useEffect(() => {
    const ticker = setInterval(() => {
      setSecondsLeft((s) => (s <= 1 ? POLL_INTERVAL / 1000 : s - 1))
    }, 1000)
    return () => clearInterval(ticker)
  }, [])

  const selectedProject = projects.find((p) => p.id === selectedProjectId)

  const exitFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
  }

  return (
    <div className={cn('min-h-screen bg-background p-6 text-foreground', '[&_*]:!text-foreground')}>
      {/* ── Header ── */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Monitor className="h-8 w-8 text-[hsl(var(--primary))]" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              {displayData?.project_name ?? '数字大屏'}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {now.toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'medium' })}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* 项目选择（DropdownMenu） */}
          <DropdownMenu open={showProjectMenu} onOpenChange={setShowProjectMenu}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                {selectedProject?.project_name ?? '选择项目'}
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {projects.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => {
                    setSelectedProjectId(p.id)
                    localStorage.setItem('digital-display-project', String(p.id))
                    setShowProjectMenu(false)
                  }}
                >
                  {p.project_name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Refresh countdown */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
            <span>{secondsLeft}s</span>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => selectedProjectId && fetchData(selectedProjectId)}
            className="gap-1.5"
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>

          <Button variant="outline" size="sm" onClick={exitFullscreen} className="gap-1.5">
            <X className="h-4 w-4" />
            退出全屏
          </Button>
        </div>
      </div>

      {/* ── Loading overlay ── */}
      {isLoading && !displayData && (
        <div className="grid h-[70vh] place-items-center">
          <div className="flex flex-col items-center gap-4">
            <RefreshCw className="h-10 w-10 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground">加载数据中...</p>
          </div>
        </div>
      )}

      {displayData && (
        <>
          {/* ── Sales KPIs (top row) ── */}
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard
              label="今日订单量"
              value={fmtNum(displayData.sales.today_order_qty)}
              change={changePct(
                displayData.sales.today_order_qty,
                displayData.sales.prev_order_qty
              )}
              accent={changeColor(
                displayData.sales.today_order_qty,
                displayData.sales.prev_order_qty
              )}
            />
            <BigKpiCard
              label="今日销售额"
              value={fmtMoney(displayData.sales.today_sales_amount)}
              sub={
                changeArrow(
                  displayData.sales.today_sales_amount,
                  displayData.sales.prev_sales_amount
                ) +
                ' ' +
                changePct(displayData.sales.today_sales_amount, displayData.sales.prev_sales_amount)
              }
              accent="text-emerald-400"
            />
            <KpiCard
              label="今日会话"
              value={fmtNum(displayData.sales.today_sessions)}
              change={changePct(displayData.sales.today_sessions, displayData.sales.prev_sessions)}
              accent={changeColor(
                displayData.sales.today_sessions,
                displayData.sales.prev_sessions
              )}
            />
            <KpiCard
              label="7日退货率"
              value={fmtRate(displayData.returns.return_rate)}
              sub={displayData.returns.top_reason ?? undefined}
              accent={displayData.returns.return_rate > 5 ? 'text-amber-400' : 'text-emerald-400'}
            />
          </div>

          {/* ── Sales Trend Chart ── */}
          <div className="mb-6">
            <ChartCard title="7日销售趋势">
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={displayData.sales_trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 14 }}
                    tickFormatter={(v) => v.slice(5)}
                    stroke="rgba(255,255,255,0.1)"
                  />
                  <YAxis
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 14 }}
                    stroke="rgba(255,255,255,0.1)"
                    tickFormatter={(v) => fmtNum(v)}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 12,
                      fontSize: 14,
                    }}
                    formatter={(value: number, name: string) => [
                      name === 'sales_amount' ? fmtMoney(value) : fmtNum(value),
                      name === 'sales_amount' ? '销售额' : name === 'order_qty' ? '订单量' : '会话',
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey="sales_amount"
                    stroke="#6366f1"
                    fill="rgba(99,102,241,0.15)"
                    strokeWidth={2}
                    name="sales_amount"
                  />
                  <Area
                    type="monotone"
                    dataKey="order_qty"
                    stroke="#10b981"
                    fill="rgba(16,185,129,0.1)"
                    strokeWidth={2}
                    name="order_qty"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          {/* ── Bottom row: Inventory + Shipment + Ads ── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
            {/* Inventory */}
            <div className="rounded-none border border-term-border bg-term-panel p-5">
              <h3 className="mb-4 text-xl font-semibold text-muted-foreground">库存概况</h3>
              <div className="space-y-4">
                <div className="text-center">
                  <p className="text-3xl font-bold tabular-nums text-foreground sm:text-5xl">
                    {fmtNum(displayData.inventory.sku_count)}
                  </p>
                  <p className="mt-1 text-base text-muted-foreground">在售 SKU</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-none border border-term-border bg-term-bg p-3 text-center">
                    <p className="text-3xl font-bold tabular-nums text-amber-400">
                      {displayData.inventory.out_of_stock_count}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">缺货</p>
                  </div>
                  <div className="rounded-none border border-term-border bg-term-bg p-3 text-center">
                    <p className="text-3xl font-bold tabular-nums text-blue-400">
                      {fmtNum(displayData.inventory.available_qty)}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">总库存</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Shipment */}
            <div className="rounded-none border border-term-border bg-term-panel p-5">
              <h3 className="mb-4 text-xl font-semibold text-muted-foreground">发货在途</h3>
              <div className="space-y-4">
                <div className="text-center">
                  <p className="text-3xl font-bold tabular-nums text-blue-400 sm:text-5xl">
                    {displayData.shipments.in_transit_count}
                  </p>
                  <p className="mt-1 text-base text-muted-foreground">在途批次</p>
                </div>
                <div className="rounded-none border border-term-border bg-term-bg p-3 text-center">
                  <p className="text-3xl font-bold tabular-nums text-foreground">
                    {fmtNum(displayData.shipments.in_transit_qty)}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">在途总量</p>
                </div>
              </div>
            </div>

            {/* Return */}
            <div className="rounded-none border border-term-border bg-term-panel p-5">
              <h3 className="mb-4 text-xl font-semibold text-muted-foreground">退货概况</h3>
              <div className="space-y-4">
                <div className="text-center">
                  <p
                    className={cn(
                      'text-3xl font-bold tabular-nums sm:text-5xl',
                      displayData.returns.return_rate > 5 ? 'text-amber-400' : 'text-emerald-400'
                    )}
                  >
                    {fmtRate(displayData.returns.return_rate)}
                  </p>
                  <p className="mt-1 text-base text-muted-foreground">退货率</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-none border border-term-border bg-term-bg p-3 text-center">
                    <p className="text-3xl font-bold tabular-nums text-foreground">
                      {displayData.returns.total_returns}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">退货单数</p>
                  </div>
                  <div className="rounded-none border border-term-border bg-term-bg p-3 text-center">
                    <p className="text-3xl font-bold tabular-nums text-foreground">
                      {displayData.returns.total_quantity}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">退货件数</p>
                  </div>
                </div>
                {displayData.returns.top_reason && (
                  <p className="text-center text-sm text-muted-foreground/80">
                    最高原因：{displayData.returns.top_reason}
                  </p>
                )}
              </div>
            </div>

            {/* Ads */}
            <div className="rounded-none border border-term-border bg-term-panel p-5">
              <h3 className="mb-4 text-xl font-semibold text-muted-foreground">广告数据</h3>
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-none border border-term-border bg-term-bg p-2 text-center">
                    <p className="text-2xl font-bold tabular-nums text-foreground">
                      {fmtMoney(displayData.ads.period_spend)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">花费</p>
                  </div>
                  <div className="rounded-none border border-term-border bg-term-bg p-2 text-center">
                    <p className="text-2xl font-bold tabular-nums text-emerald-400">
                      {displayData.ads.period_roas}x
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">ROAS</p>
                  </div>
                  <div className="rounded-none border border-term-border bg-term-bg p-2 text-center">
                    <p
                      className={cn(
                        'text-2xl font-bold tabular-nums',
                        displayData.ads.period_acos > 30 ? 'text-amber-400' : 'text-foreground'
                      )}
                    >
                      {displayData.ads.period_acos}%
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">ACOS</p>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-none border border-term-border bg-term-bg p-2 text-center">
                    <p className="text-2xl font-bold tabular-nums text-foreground">
                      {fmtNum(displayData.ads.period_impressions)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">展示</p>
                  </div>
                  <div className="rounded-none border border-term-border bg-term-bg p-2 text-center">
                    <p className="text-2xl font-bold tabular-nums text-foreground">
                      {fmtNum(displayData.ads.period_clicks)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">点击</p>
                  </div>
                  <div className="rounded-none border border-term-border bg-term-bg p-2 text-center">
                    <p className="text-2xl font-bold tabular-nums text-blue-400">
                      {displayData.ads.period_ctr}%
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">CTR</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
