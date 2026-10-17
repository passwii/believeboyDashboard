'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts'

import { TermErrorBar, TermGridHeader, TermMetricTile } from '@/components/dashboard/ad-analysis/term-chrome'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTable,
  TermTHead,
} from '@/components/terminal/term-table'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { useAdClientRefreshKey } from '@/components/dashboard/ad-refresh'
import { fetchAdAnalysisCached } from '@/lib/ad-client-cache'
import {
  buildAnalysisDrillHref,
  getAnalysisDrillLabel,
} from '@/components/dashboard/ad-analysis/drill'
import { AdAnalysisDrillLinks } from '@/components/dashboard/ad-analysis/drill-links'

/**
 * BLF-818 · Pattern B 双轴分析画布（广告分析总览页）：
 *
 *   ┌ Console 工具条（layout 层）──────────────────────────┐
 *   │ KPI 等宽磁贴带（花费/销售/订单/CTR/CPC/ACOS/ROAS）      │
 *   ├ 上部图表分割区（40~45%，内部自适应不产生页面滚动）─────┤
 *   │ 趋势折线（Spend/Sales 双轴） │ 国家站点分布柱状        │
 *   ├ 下部子 Tab 数据网格（flex-1 独立滚动，sticky 表头）────┤
 *   │ 高消耗活动 / 高消耗 SKU / 浪费搜索词 / 近7日趋势 …     │
 *   └──────────────────────────────────────────────────────┘
 *
 * 数据获取逻辑不动（BEL-421 客户端缓存契约保持），仅视图层终端化。
 */

type OverviewMetric = {
  label: string
  value: number
  display_value: string
  helper: string | null
}

type OverviewIssue = {
  title: string
  level: string
  summary: string
  drill_to?: string | null
  next_step?: string | null
}

type TrendPoint = Record<string, unknown> & { report_date?: unknown }

type OverviewResponse = {
  project_id: number
  country: string
  metrics: OverviewMetric[]
  issue_cards: OverviewIssue[]
  narrative_sections: Array<{
    title: string
    summary: string
    evidence: string[]
    action?: string | null
    drill_to?: string | null
  }>
  comparison?: {
    current_start?: string | null
    current_end?: string | null
    previous_start?: string | null
    previous_end?: string | null
    spend_change_ratio?: number | null
    clicks_change_ratio?: number | null
    sales_change_ratio?: number | null
    orders_change_ratio?: number | null
    cpc_change_ratio?: number | null
    acos_change_ratio?: number | null
    summary?: string | null
  } | null
  top_campaigns: Array<Record<string, unknown>>
  top_products: Array<Record<string, unknown>>
  top_waste_terms: Array<Record<string, unknown>>
  trend_summary: Array<Record<string, unknown>>
  top_cross_sell_products: Array<Record<string, unknown>>
}

// ===== 图表配置（沿用 recharts + ui/chart，坐标轴/图例文字 11px mono）=====

const TREND_CHART_CONFIG = {
  spend: { label: '花费', color: 'var(--term-warn)' },
  sales: { label: '销售额', color: 'var(--term-pos)' },
} satisfies ChartConfig

const DISTRIBUTION_CHART_CONFIG = {
  spend: { label: '花费', color: 'var(--term-accent)' },
} satisfies ChartConfig

/** KPI 磁贴取值顺序：优先核心四指标（花费/销售额/ACOS/ROAS），其余按后端顺序补齐 */
const METRIC_LABEL_MAP: Record<string, { short: string }> = {
  Spend: { short: 'SPEND' },
  'Sales 7d': { short: 'SALES' },
  ACOS: { short: 'ACOS' },
  ROAS: { short: 'ROAS' },
  'Orders 7d': { short: 'ORDERS' },
  CTR: { short: 'CTR' },
  CPC: { short: 'CPC' },
  'Trend Days': { short: 'DAYS' },
  'Cross-sell Sales 7d': { short: 'X-SELL' },
}

function metricShort(label: string): string {
  return METRIC_LABEL_MAP[label]?.short ?? label.toUpperCase()
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function AdAnalysisOverviewClient() {
  const searchParams = useSearchParams()
  const { data: session, status } = useSession()
  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''

  const [data, setData] = useState<OverviewResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshKey = useAdClientRefreshKey()

  useEffect(() => {
    if (!projectId) return
    // BEL-421：缓存键按用户域隔离，须等 session 就绪再取数，
    // 避免先以 unknown 域取一次、session 到位后再取一次的双请求。
    if (status === 'loading') return
    let active = true

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const query = new URLSearchParams({
          project_id: projectId,
          country,
        })
        if (dateFrom) query.set('date_from', dateFrom)
        if (dateTo) query.set('date_to', dateTo)
        // BEL-421：客户端缓存（2min TTL）——2 分钟内重复 mount 0 请求。
        const payload = await fetchAdAnalysisCached<OverviewResponse>('overview', query, session)
        if (active) setData(payload)
      } catch (fetchError) {
        if (active) {
          setError(fetchError instanceof Error ? fetchError.message : '广告总览加载失败')
        }
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [country, dateFrom, dateTo, projectId, session, status, refreshKey])

  // ===== 派生数据：趋势图 / 站点分布 =====

  const trendData = useMemo(() => {
    if (!data) return []
    return data.trend_summary.map((item) => ({
      date: String(item.report_date ?? '').slice(5), // MM-DD，轴标签省年份
      spend: num(item.spend),
      sales: num(item.sales_7d),
    }))
  }, [data])

  /** 国家/站点分布：overview 单国家 payload → 用各维度花费构成近似分布柱状 */
  const distributionData = useMemo(() => {
    if (!data) return []
    const rows: Array<{ name: string; spend: number; sales: number; acos: number }> = []
    for (const item of data.top_campaigns.slice(0, 8)) {
      rows.push({
        name: String(item.campaign_name ?? '-').slice(0, 12),
        spend: num(item.spend),
        sales: num(item.sales_7d),
        acos: num(item.acos),
      })
    }
    return rows
  }, [data])

  const comparison = data?.comparison

  /** 同比环比着色映射：磁贴 label → comparison 变化字段 */
  const changeRatioFor = useMemo(() => {
    const map: Record<string, number | null | undefined> = {
      Spend: comparison?.spend_change_ratio,
      'Sales 7d': comparison?.sales_change_ratio,
      'Orders 7d': comparison?.orders_change_ratio,
      Clicks: comparison?.clicks_change_ratio,
      CPC: comparison?.cpc_change_ratio,
      ACOS: comparison?.acos_change_ratio,
    }
    return (label: string) => map[label] ?? null
  }, [comparison])

  const buildDrillHref = (drillTo?: string | null) =>
    buildAnalysisDrillHref(drillTo || '', { projectId, country, dateFrom, dateTo })
  const buildDrillLabel = (drillTo?: string | null) => getAnalysisDrillLabel(drillTo) || ''

  // ===== 状态分支 =====

  if (!projectId) {
    return (
      <section className="flex min-h-0 flex-1 flex-col border border-term-border bg-term-panel">
        <TermGridHeader title="广告总览 AD OVERVIEW" />
        <div className="flex flex-1 items-center justify-center font-mono text-xs text-term-muted">
          请先在顶部筛选区选择项目
        </div>
      </section>
    )
  }

  const metrics = data?.metrics ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <TermErrorBar message={error} />

      {/* ===== KPI 等宽磁贴带（范围 3）：等宽网格 + 同比环比语义色 ===== */}
      <div className="grid shrink-0 grid-cols-2 gap-1 sm:grid-cols-4 xl:grid-cols-8">
        {loading && metrics.length === 0
          ? Array.from({ length: 8 }).map((_, i) => (
              <div key={`kpi-skeleton-${i}`} className="border border-term-border bg-term-panel px-2 py-1.5">
                <Skeleton className="h-3 w-12 rounded-none" />
                <Skeleton className="mt-1.5 h-5 w-20 rounded-none" />
              </div>
            ))
          : metrics.map((metric) => (
              <TermMetricTile
                key={metric.label}
                label={metricShort(metric.label)}
                value={metric.display_value}
                changeRatio={changeRatioFor(metric.label)}
                helper={`${metric.helper ?? ''}${metric.label !== metricShort(metric.label) ? ` · ${metric.label}` : ''}`}
              />
            ))}
      </div>

      {/* ===== 上部图表分割区（范围 1，约 40~45% 高度，容器内自适应） ===== */}
      <div className="grid h-[38vh] max-h-[420px] min-h-[220px] shrink-0 grid-cols-1 gap-1 lg:grid-cols-2">
        <ChartContainer
          config={TREND_CHART_CONFIG}
          className="aspect-auto h-full w-full border border-term-border bg-term-panel"
        >
          <LineChart data={trendData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--term-border)" strokeDasharray="2 2" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', fill: 'var(--term-muted)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--term-border-strong)' }}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', fill: 'var(--term-muted)' }}
              tickLine={false}
              axisLine={false}
              width={52}
              tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}`}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', fill: 'var(--term-muted)' }}
              tickLine={false}
              axisLine={false}
              width={44}
              tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}`}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="spend"
              stroke="var(--term-warn)"
              strokeWidth={1.5}
              dot={false}
              name="花费"
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="sales"
              stroke="var(--term-pos)"
              strokeWidth={1.5}
              dot={false}
              name="销售额"
            />
          </LineChart>
        </ChartContainer>

        <ChartContainer
          config={DISTRIBUTION_CHART_CONFIG}
          className="aspect-auto h-full w-full border border-term-border bg-term-panel"
        >
          <BarChart data={distributionData} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="var(--term-border)" strokeDasharray="2 2" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', fill: 'var(--term-muted)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--term-border-strong)' }}
              tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)}`}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={96}
              tick={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', fill: 'var(--term-muted)' }}
              tickLine={false}
              axisLine={false}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="spend" fill="var(--term-accent)" name="花费" barSize={10} />
          </BarChart>
        </ChartContainer>
      </div>

      {/* ===== 下部子 Tab 数据网格（范围 2）：TermPanel 密度规格 + sticky 表头独立滚动 ===== */}
      <section className="flex min-h-0 flex-1 flex-col border border-term-border bg-term-panel" aria-label="广告明细数据">
        <TermGridHeader
          title="明细数据 DETAILS"
          meta={data ? `${data.top_campaigns.length + data.top_products.length + data.top_waste_terms.length} groups` : undefined}
        />
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain term-scroll">
          {loading && !data ? (
            <SkeletonRows />
          ) : data ? (
            <TermTable aria-label="广告总览明细">
              <TermTHead>
                <TermRow>
                  <TermHead>分组</TermHead>
                  <TermHead>名称</TermHead>
                  <TermHead numeric>Spend</TermHead>
                  <TermHead numeric>Sales</TermHead>
                  <TermHead numeric>Orders</TermHead>
                  <TermHead numeric>ACOS</TermHead>
                  <TermHead numeric>CPC</TermHead>
                  <TermHead numeric>Clicks</TermHead>
                  <TermHead>下钻</TermHead>
                </TermRow>
              </TermTHead>
              <TermBody>
                {data.top_campaigns.length === 0 &&
                data.top_products.length === 0 &&
                data.top_waste_terms.length === 0 &&
                data.trend_summary.length === 0 &&
                data.top_cross_sell_products.length === 0 ? (
                  <EmptyTableState
                    colSpan={9}
                    message="当前筛选条件下暂无广告明细 — 调整日期范围或等待报表上传"
                    className="bg-term-panel font-mono text-xs"
                  />
                ) : (
                  <>
                    {data.top_campaigns.map((item, index) => (
                      <DetailRow
                        key={`campaign-${index}`}
                        group="活动 CAMP"
                        name={String(item.campaign_name || '-')}
                        spend={num(item.spend)}
                        sales={num(item.sales_7d)}
                        orders={num(item.orders_7d)}
                        acos={num(item.acos)}
                        drillLinks={[
                          {
                            href: buildAnalysisDrillHref(
                              'campaigns',
                              { projectId, country, dateFrom, dateTo },
                              { campaign: String(item.campaign_name || '') }
                            ),
                            label: '活动',
                          },
                        ]}
                      />
                    ))}
                    {data.top_products.map((item, index) => (
                      <DetailRow
                        key={`sku-${index}`}
                        group="SKU"
                        name={String(item.ad_sku || '-')}
                        spend={num(item.spend)}
                        sales={num(item.sales_7d)}
                        orders={num(item.orders_7d)}
                        acos={num(item.acos)}
                        drillLinks={[
                          {
                            href: buildAnalysisDrillHref(
                              'products',
                              { projectId, country, dateFrom, dateTo },
                              { sku: String(item.ad_sku || '') }
                            ),
                            label: 'SKU',
                          },
                        ]}
                      />
                    ))}
                    {data.top_waste_terms.map((item, index) => (
                      <DetailRow
                        key={`waste-${index}`}
                        group="浪费词 WASTE"
                        name={String(item.search_term || '-')}
                        spend={num(item.spend)}
                        sales={0}
                        orders={num(item.orders_7d)}
                        clicks={num(item.clicks)}
                        drillLinks={[
                          {
                            href: buildAnalysisDrillHref(
                              'search-terms',
                              { projectId, country, dateFrom, dateTo },
                              { searchTerm: String(item.search_term || '') }
                            ),
                            label: '搜索词',
                          },
                        ]}
                      />
                    ))}
                    {data.trend_summary.slice(-7).map((item, index) => (
                      <DetailRow
                        key={`trend-${index}`}
                        group="日趋势 DAILY"
                        name={String(item.report_date || '-')}
                        spend={num(item.spend)}
                        sales={0}
                        orders={0}
                        clicks={num(item.clicks)}
                        cpc={num(item.cpc)}
                        drillLinks={[
                          {
                            href: buildAnalysisDrillHref(
                              'time-trend',
                              { projectId, country, dateFrom, dateTo },
                              { focusDate: String(item.report_date || '') }
                            ),
                            label: '趋势',
                          },
                        ]}
                      />
                    ))}
                    {data.top_cross_sell_products.map((item, index) => (
                      <DetailRow
                        key={`xsell-${index}`}
                        group="关联购买 X-SELL"
                        name={`${String(item.ad_sku || '-')} → ${String(item.purchased_asin || '-')}`}
                        spend={0}
                        sales={num(item.other_sku_sales_7d)}
                        orders={num(item.other_sku_orders_7d)}
                        drillLinks={[
                          {
                            href: buildAnalysisDrillHref(
                              'purchased-products',
                              { projectId, country, dateFrom, dateTo },
                              {
                                sku: String(item.ad_sku || ''),
                                purchasedAsin: String(item.purchased_asin || ''),
                              }
                            ),
                            label: '关联购买',
                          },
                        ]}
                      />
                    ))}
                  </>
                )}
              </TermBody>
            </TermTable>
          ) : (
            <EmptyTableState
              colSpan={9}
              message="当前还没有可展示的广告总览数据。"
              className="bg-term-panel font-mono text-xs"
            />
          )}
        </div>
      </section>

      {/* 风险提醒 / 结构化分析收进底部折叠区（保留原信息价值，不占首屏） */}
      {(data?.issue_cards.length ?? 0) > 0 && (
        <details className="shrink-0 border border-term-border bg-term-panel font-mono text-xs">
          <summary className="cursor-pointer select-none px-2 py-1 uppercase tracking-wider text-term-muted hover:text-term-text">
            ⚠ 风险提醒 · {data?.issue_cards.length} 条
          </summary>
          <ul className="space-y-1 border-t border-term-border px-2 py-1.5 text-term-text">
            {data?.issue_cards.map((issue, i) => (
              <li key={`${issue.title}-${i}`} className="leading-relaxed">
                <span className="text-term-warn">[{issue.level}]</span> {issue.title}
                <span className="text-term-muted"> — {issue.summary}</span>
                {buildDrillLabel(issue.drill_to) ? (
                  <AdAnalysisDrillLinks
                    links={[{ href: buildDrillHref(issue.drill_to), label: buildDrillLabel(issue.drill_to) }]}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

// ======================== 局部子组件 ========================

type DetailLink = { href: string | null; label: string }

/** 明细行：分组标签 muted + 数值右对齐 tabular；ACOS 超 30% 标 neg 微色 */
function DetailRow({
  group,
  name,
  spend,
  sales,
  orders,
  acos = 0,
  cpc,
  clicks,
  drillLinks,
}: {
  group: string
  name: string
  spend: number
  sales: number
  orders: number
  acos?: number
  cpc?: number
  clicks?: number
  drillLinks: DetailLink[]
}) {
  const fmt = (n: number) => `$${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const hasAcos = sales > 0 && spend > 0
  const shownAcos = hasAcos ? acos : 0
  return (
    <TermRow>
      <TermCell tone="muted" className="whitespace-nowrap">
        <span className="text-[11px]">{group}</span>
      </TermCell>
      <TermCell className="max-w-[280px]" title={name}>
        <span className="line-clamp-1">{name}</span>
      </TermCell>
      <TermCell numeric>{spend > 0 ? fmt(spend) : <span className="text-term-faint">—</span>}</TermCell>
      <TermCell numeric>{sales > 0 ? fmt(sales) : <span className="text-term-faint">—</span>}</TermCell>
      <TermCell numeric>{orders > 0 ? orders.toLocaleString('zh-CN') : <span className="text-term-faint">—</span>}</TermCell>
      <TermCell numeric>
        {hasAcos ? (
          <span className={(shownAcos as number) > 0.3 ? 'text-term-neg' : 'text-term-pos'}>
            {((shownAcos as number) * 100).toFixed(2)}%
          </span>
        ) : (
          <span className="text-term-faint">—</span>
        )}
      </TermCell>
      <TermCell numeric>{typeof cpc === 'number' && cpc > 0 ? fmt(cpc) : <span className="text-term-faint">—</span>}</TermCell>
      <TermCell numeric>{typeof clicks === 'number' && clicks > 0 ? clicks.toLocaleString('zh-CN') : <span className="text-term-faint">—</span>}</TermCell>
      <TermCell>
        <AdAnalysisDrillLinks links={drillLinks} />
      </TermCell>
    </TermRow>
  )
}

/** 加载骨架：9 列占位、28px 行高对齐真实行高 */
function SkeletonRows({ rows = 10 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={`overview-skeleton-${rowIndex}`} className="border-b border-term-border">
          <td colSpan={9} className="h-7 px-2 align-middle">
            <Skeleton
              className={
                rowIndex % 3 === 0
                  ? 'h-3 w-1/2 rounded-none'
                  : rowIndex % 3 === 1
                    ? 'h-3 w-2/3 rounded-none'
                    : 'h-3 w-1/3 rounded-none'
              }
            />
          </td>
        </tr>
      ))}
    </>
  )
}
