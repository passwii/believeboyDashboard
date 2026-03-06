'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Label,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from 'recharts'
import { Database, Lightbulb, Loader2, RefreshCw, TrendingUp, Upload } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''
const DASHBOARD_PALETTE = {
  blue: 'hsl(217 91% 60%)',
  blueDeep: 'hsl(224 76% 48%)',
  blueSoft: 'hsl(210 98% 78%)',
  cyan: 'hsl(191 91% 42%)',
  indigo: 'hsl(234 89% 74%)',
  gold: 'hsl(43 89% 58%)',
  rose: 'hsl(343 82% 64%)',
}
const PIE_COLORS = [
  DASHBOARD_PALETTE.blue,
  DASHBOARD_PALETTE.cyan,
  DASHBOARD_PALETTE.indigo,
  DASHBOARD_PALETTE.gold,
  DASHBOARD_PALETTE.rose,
]

type CategoryResearchDataset = {
  id: number
  marketplace: string
  category_keyword_en: string
  category_name_zh: string
  version: number
  is_current: boolean
  data_date: string | null
  data_year: number | null
  data_month: number | null
  data_day: number | null
  row_count_products: number
  row_count_trends: number
  quality_warnings: Record<string, number>
  created_at: string | null
}

type CategoryResearchOverview = {
  dataset: CategoryResearchDataset
  kpis: {
    sample_count: number
    brand_count: number
    average_price_usd: number
    total_monthly_sales: number
    total_monthly_revenue_usd: number
    amazon_share: number
  }
  brand_sales_share: Array<{ brand: string; monthly_sales: number; share: number }>
  listing_age_distribution: Array<{ label: string; count: number }>
  fulfillment_distribution: Array<{ label: string; count: number }>
  fixed_price_bands: Array<{ label: string; count: number }>
  quantile_price_bands: Array<{ label: string; min_price: number; max_price: number; count: number }>
  price_stats: { mean: number; median: number; p25: number; p75: number }
  price_sales_correlation: number
  fba_fee_distribution: Array<{ label: string; count: number }>
  price_sales_points: Array<{ asin: string | null; price_usd: number; monthly_sales: number }>
  available_asins: string[]
  advanced_metrics: {
    market_concentration: {
      cr3: number
      cr5: number
      cr10: number
      hhi: number
    }
    brand_monopoly: {
      brand_cr3: number
      brand_cr5: number
      brand_cr10: number
      brand_hhi: number
      risk_level: 'low' | 'medium' | 'high'
    }
    seller_monopoly: {
      seller_count: number
      seller_cr1?: number
      seller_cr3: number
      seller_cr5: number
      seller_cr10: number
      seller_hhi: number
      amazon_seller_sales_share: number
      risk_level: 'low' | 'medium' | 'high'
      top_sellers: Array<{ seller: string; monthly_sales: number; share: number }>
    }
    product_monopoly: {
      asin_top1_share: number
      asin_top3_share: number
      asin_top10_share: number
      top1_to_top100_ratio: number
      risk_level: 'low' | 'medium' | 'high'
      top_asins: Array<{ asin: string; monthly_sales: number; share: number }>
    }
    china_seller_competition: {
      china_seller_count: number
      china_seller_count_share: number
      china_seller_sales_share: number
      risk_level: 'low' | 'medium' | 'high'
    }
    market_growth: {
      trend_slope: number
      last12_vs_prev12_growth: number
      cagr_like_growth: number
      growth_level: 'growing' | 'stable' | 'shrinking'
      growth_tier?: string
      radar_score?: number
      tier_thresholds?: string[]
    }
    seasonality: {
      peak3_month_sales_share: number
      monthly_sales_cv: number
      seasonality_level: 'weak' | 'moderate' | 'strong'
      recommended_entry_months: string[]
      seasonality_tier?: string
      entry_friendliness_score?: number
      tier_thresholds?: string[]
    }
    review_research: {
      average_rating?: number
      review_median: number
      review_p75: number
      review_top10_share: number
      low_review_product_share: number
      low_review_threshold?: number
      bottom_quartile_product_share?: number
      rating_band_distribution?: Array<{ label: string; count: number }>
      review_segment_distribution?: Array<{ label: string; count: number; monthly_sales: number }>
    }
    price_band_opportunities: Array<{
      label: string
      count: number
      monthly_sales: number
      monthly_revenue_usd: number
      sales_share: number
      revenue_share: number
      average_rating: number
      average_review_count: number
    }>
    new_product_opportunity: {
      new_product_count: number
      new_product_share: number
      new_product_sales_share: number
      new_product_avg_monthly_sales: number
      new_product_median_price_usd: number
      opportunity_level?: string
      radar_score?: number
      level_thresholds?: string[]
    }
    supply_complexity: {
      score: number
      fulfillment_mix_score: number
      fba_fee_pressure_score: number
      price_dispersion_score: number
      complexity_level?: string
      radar_score?: number
      level_thresholds?: string[]
      explanation_lines?: string[]
    }
    asin_momentum: Array<{
      asin: string
      avg_monthly_sales: number
      sales_cv: number
      yoy_growth: number
      recent_3m_momentum: number
    }>
    data_quality: {
      score: number
      missing_trend_for_asin_count: number
      invalid_price_count: number
      invalid_fba_fee_count: number
      duplicate_asin_count: number
      missing_fba_fee_count?: number
      missing_seller_country_count?: number
      missing_brand_count?: number
      unknown_fulfillment_count?: number
      completeness_score?: number
      validity_score?: number
      consistency_score?: number
      coverage_score?: number
      level?: string
      warning_density?: number
      summary?: string
    }
    dimension_blocks?: Array<{
      key: 'structure' | 'opportunity' | 'execution'
      label: string
      summary: string
      risk_level: 'low' | 'medium' | 'high'
      metric_keys: string[]
    }>
    metric_definitions?: Array<{
      key: string
      name: string
      formula_text: string
      thresholds: string[]
      interpretation_template: string
      pitfall: string
      action_hint: string
    }>
    action_recommendations?: Array<{
      priority: 'high' | 'medium' | 'low'
      action: string
      why: string
      required_validation: string[]
      linked_dimension: 'structure' | 'opportunity' | 'execution'
      rule_basis?: string[]
    }>
    signals?: Array<{
      key: string
      label: string
      level: 'high' | 'medium' | 'low'
      direction: 'positive' | 'negative' | 'neutral'
      linked_dimension: 'structure' | 'opportunity' | 'execution'
    }>
    price_band_standard?: string
    price_band_breaks?: number[]
    price_band_method?: string
    price_band_method_description?: string
    price_correlation_score?: number
    dimension_price_band_analysis?: Array<{
      key: string
      label: string
      total_count: number
      values: Array<{
        value: string
        count: number
        share: number
        band_distribution: Array<{ label: string; count: number; share: number }>
      }>
    }>
    brand_price_band_analysis?: Array<{
      brand: string
      product_count: number
      monthly_sales: number
      price_range: { min_price: number; max_price: number }
      covered_bands: string[]
      band_distribution: Array<{ label: string; count: number; share: number }>
    }>
  }
}

type CategoryResearchProductRow = {
  id: number
  source_row_no: number
  asin: string | null
  parent_asin: string | null
  product_name: string | null
  brand: string | null
  seller: string | null
  price_usd: number | null
  monthly_sales: number
  monthly_revenue_usd: number | null
  rating: number | null
  review_count: number
  launch_date?: string | null
  listing_age_days: number | null
  fba_fee_usd: number | null
  fulfillment_method: string | null
  is_amazon: boolean
  is_new_90d: boolean
}

type ProductsPayload = {
  dataset_id: number
  page: number
  page_size: number
  has_next: boolean
  rows: CategoryResearchProductRow[]
}

type CategoryResearchMarketTrendPayload = {
  dataset_id: number
  months: number
  points: Array<{ year_month: string; monthly_sales: number }>
}

type ViewTab = 'overview' | 'market' | 'brand' | 'seller' | 'review' | 'price'
type WorkspaceTab = 'research' | 'analysis'
type AlertLevel = 'high' | 'medium' | 'low'

type MetricItem = {
  label: string
  value: ReactNode
  tone?: 'default' | 'positive' | 'negative'
  hint?: string
}

type OverviewRadarDatum = {
  metric: string
  value: number
  fullMark: number
}

type BrandRadarRow = {
  metric: string
  [brand: string]: string | number
}

type SellerStructureDatum = {
  metric: string
  value: number
  fullMark: number
}

type PriceScatterDatum = {
  asin: string
  price_usd: number
  monthly_sales: number
}

type PieDatum = {
  name: string
  value: number
  fill: string
  description?: string
}

const overviewRadarChartConfig = {
  value: { label: '市场画像', color: DASHBOARD_PALETTE.blue },
} satisfies ChartConfig

const riskRadialChartConfig = {
  value: { label: '风险值', color: DASHBOARD_PALETTE.blueDeep },
} satisfies ChartConfig

const signalPieChartConfig = {
  value: { label: '信号数', color: DASHBOARD_PALETTE.blue },
} satisfies ChartConfig

const actionBarChartConfig = {
  count: { label: '建议数', color: DASHBOARD_PALETTE.cyan },
} satisfies ChartConfig

const marketTrendChartConfig = {
  recent12: { label: '近12个月', color: DASHBOARD_PALETTE.blue },
  prior12: { label: 'Last 12个月', color: DASHBOARD_PALETTE.cyan },
} satisfies ChartConfig

const marketStructureChartConfig = {
  count: { label: '产品数', color: DASHBOARD_PALETTE.cyan },
} satisfies ChartConfig

const marketRadialChartConfig = {
  value: { label: '得分', color: DASHBOARD_PALETTE.indigo },
} satisfies ChartConfig

const brandBarChartConfig = {
  monthly_sales: { label: '月销量', color: DASHBOARD_PALETTE.blue },
} satisfies ChartConfig

const brandBandChartConfig = {
  value: { label: '覆盖率', color: DASHBOARD_PALETTE.gold },
} satisfies ChartConfig

const sellerShareChartConfig = {
  sales_share_pct: { label: '销量占比', color: DASHBOARD_PALETTE.blue },
  count_share_pct: { label: '数量占比', color: DASHBOARD_PALETTE.cyan },
  count: { label: '产品数', color: DASHBOARD_PALETTE.gold },
  value: { label: '卖家结构', color: DASHBOARD_PALETTE.indigo },
} satisfies ChartConfig

const reviewChartConfig = {
  count: { label: '产品数', color: DASHBOARD_PALETTE.blue },
  cumulative_share_pct: { label: '累计销量占比', color: DASHBOARD_PALETTE.cyan },
  value: { label: '评论门槛', color: DASHBOARD_PALETTE.rose },
} satisfies ChartConfig

const priceChartConfig = {
  monthly_sales: { label: '月销量', color: DASHBOARD_PALETTE.blue },
  count: { label: '样本数', color: DASHBOARD_PALETTE.gold },
  value: { label: '价格画像', color: DASHBOARD_PALETTE.indigo },
} satisfies ChartConfig

function authHeaders(operator?: string, isAdmin = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (API_KEY) headers['X-API-Key'] = API_KEY
  if (isAdmin) headers['X-Is-Admin'] = 'true'
  if (operator && operator.trim()) headers['X-Operator'] = encodeURIComponent(operator.trim())
  return headers
}

function resolveApiUrl(path: string) {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  if (/^https?:\/\//i.test(path)) return path
  if (!path.startsWith('/')) return `${base}/${path}`
  return `${base}${path}`
}

function parseErrorBody(text: string, status: number): string {
  if (!text) return `请求失败 (${status})`
  if (text === '[object Object]') return `请求失败 (${status})`
  try {
    const payload = JSON.parse(text) as { detail?: string | unknown[] | Record<string, unknown> }
    if (typeof payload.detail === 'string') return payload.detail
    if (Array.isArray(payload.detail)) {
      return payload.detail
        .map((item) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object') {
            const record = item as { msg?: unknown; loc?: unknown }
            const message = typeof record.msg === 'string' ? record.msg : JSON.stringify(item)
            const location = Array.isArray(record.loc) ? record.loc.join('.') : null
            return location ? `${location}: ${message}` : message
          }
          return String(item)
        })
        .join('; ')
    }
    if (payload.detail && typeof payload.detail === 'object') {
      const detailRecord = payload.detail as { message?: unknown; error?: unknown; detail?: unknown }
      if (typeof detailRecord.message === 'string') return detailRecord.message
      if (typeof detailRecord.error === 'string') return detailRecord.error
      if (typeof detailRecord.detail === 'string') return detailRecord.detail
      return JSON.stringify(payload.detail)
    }
    return text
  } catch {
    return text
  }
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value))
}

function normalizeToPercent(value: number | null | undefined, multiplier = 100) {
  if (!Number.isFinite(value)) return 0
  return clamp(Number(value) * multiplier)
}

function riskLevelText(level: string | undefined): string {
  if (level === 'high') return '高风险'
  if (level === 'medium') return '中风险'
  return '低风险'
}

function normalizeRiskLevel(level: string | undefined): AlertLevel {
  if (level === 'high') return 'high'
  if (level === 'medium') return 'medium'
  return 'low'
}

function alertBadgeClass(level: AlertLevel) {
  if (level === 'high') return 'border-rose-300 bg-rose-50 text-rose-700'
  if (level === 'medium') return 'border-amber-300 bg-amber-50 text-amber-700'
  return 'border-emerald-300 bg-emerald-50 text-emerald-700'
}

function growthLevelText(level: string | undefined): string {
  if (level === 'growing') return '增长'
  if (level === 'shrinking') return '收缩'
  return '平稳'
}

function growthTierText(level: string | undefined): string {
  if (level === 'explosive') return '爆发增长'
  if (level === 'fast_growing') return '快速增长'
  if (level === 'growing') return '温和增长'
  if (level === 'softening') return '增长走弱'
  if (level === 'shrinking') return '持续收缩'
  return '平稳'
}

function seasonalityLevelText(level: string | undefined): string {
  if (level === 'strong') return '强季节性'
  if (level === 'moderate') return '中季节性'
  return '弱季节性'
}

function seasonalityTierText(level: string | undefined): string {
  if (level === 'extreme') return '极强季节性'
  if (level === 'strong') return '强季节性'
  if (level === 'elevated') return '偏强季节性'
  if (level === 'moderate') return '中季节性'
  if (level === 'mild') return '轻季节性'
  return '全年较均衡'
}

function opportunityLevelText(level: string | undefined): string {
  if (level === 'very_high') return '极高'
  if (level === 'high') return '高'
  if (level === 'medium') return '中'
  if (level === 'low') return '低'
  return '极低'
}

function supplyComplexityText(level: string | undefined): string {
  if (level === 'very_high') return '极高复杂度'
  if (level === 'high') return '高复杂度'
  if (level === 'medium') return '中复杂度'
  if (level === 'low') return '低复杂度'
  return '极低复杂度'
}

function dataQualityLevelText(level: string | undefined): string {
  if (level === 'excellent') return '优秀'
  if (level === 'good') return '良好'
  if (level === 'fair') return '一般'
  return '较差'
}

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return `${(value * 100).toFixed(2)}%`
}

function formatSignedPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  const sign = value > 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(2)}%`
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return value.toLocaleString('en-US')
}

function trendValueClass(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'text-muted-foreground'
  if (value > 0) return 'text-emerald-600'
  if (value < 0) return 'text-rose-600'
  return 'text-muted-foreground'
}

function formatMonthTick(value: string) {
  const [year, month] = value.split('-')
  if (!year || !month) return value
  return `${year.slice(-2)}/${month}`
}

function formatMonthShort(value: string) {
  const [year, month] = value.split('-')
  if (!year || !month) return value
  return `${month}`
}

function formatDatasetDate(dataset: Pick<CategoryResearchDataset, 'data_date' | 'data_year' | 'data_month' | 'data_day'>) {
  if (dataset.data_date) return dataset.data_date
  if (dataset.data_year && dataset.data_month && dataset.data_day) {
    return `${dataset.data_year}-${String(dataset.data_month).padStart(2, '0')}-${String(dataset.data_day).padStart(2, '0')}`
  }
  return '-'
}

function formatDatasetFreshness(dataset: Pick<CategoryResearchDataset, 'data_date' | 'data_year' | 'data_month' | 'data_day'>) {
  const normalized = formatDatasetDate(dataset)
  if (normalized === '-') return '时效未知'

  const target = new Date(`${normalized}T00:00:00`)
  if (Number.isNaN(target.getTime())) return normalized

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const diffMs = today.getTime() - target.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays <= 0) return `${normalized} · 今日入库`
  if (diffDays === 1) return `${normalized} · 1天前入库`
  return `${normalized} · ${diffDays}天前入库`
}

function compactPercentLabel(value: number) {
  return `${value.toFixed(0)}%`
}

function reviewSegmentTierLabel(index: number, total: number) {
  if (total <= 0) return `S${index + 1}`
  if (index === 0) return `冷启动段 S1`
  if (index === total - 1) return `头部壁垒段 S${index + 1}`
  return `过渡段 S${index + 1}`
}

function priorityWeight(priority: 'high' | 'medium' | 'low') {
  if (priority === 'high') return 3
  if (priority === 'medium') return 2
  return 1
}

function average(values: number[]) {
  const valid = values.filter((value) => Number.isFinite(value))
  if (valid.length === 0) return 0
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function buildOverviewChartModels(overview: CategoryResearchOverview | null, datasets: CategoryResearchDataset[]) {
  if (!overview) {
    return {
      radarData: [] as OverviewRadarDatum[],
      radialRisks: [] as Array<{ label: string; value: number; text: string; detail: string }>,
      metrics: [] as MetricItem[],
      warningItems: [] as Array<{ label: string; value: number }>,
      actions: [] as NonNullable<CategoryResearchOverview['advanced_metrics']['action_recommendations']>,
      historyData: [] as Array<{ label: string; products: number; versions: number }>,
      radarNotes: [] as string[],
      metricDefinitionCards: [] as Array<{ title: string; formula: string; thresholds: string[]; interpretation: string; actionHint: string }>,
    }
  }

  const { advanced_metrics: metrics, dataset } = overview
  const competitionOpennessScore = average([
    clamp((1 - metrics.brand_monopoly.brand_cr3) * 100),
    clamp((1 - metrics.seller_monopoly.seller_cr3) * 100),
    clamp((1 - metrics.china_seller_competition.china_seller_sales_share) * 100),
  ])
  const reviewAccessibilityScore = clamp(metrics.review_research.low_review_product_share * 100)
  const historyRows = datasets
    .slice()
    .sort((a, b) => a.version - b.version)
    .map((item) => ({
      label: `V${item.version}`,
      products: item.row_count_products,
      versions: item.version,
    }))
  const datedHistory = datasets
    .map((item) => ({ ...item, normalizedDate: formatDatasetDate(item) }))
    .filter((item) => item.normalizedDate !== '-')
    .sort((a, b) => a.normalizedDate.localeCompare(b.normalizedDate))
  const historySpanText =
    datedHistory.length >= 2 ? `${datedHistory[0]!.normalizedDate} -> ${datedHistory[datedHistory.length - 1]!.normalizedDate}` : formatDatasetDate(dataset)
  const definitions = new Map((metrics.metric_definitions ?? []).map((item) => [item.key, item]))
  return {
    radarData: [
      { metric: '增长机会', value: clamp(metrics.market_growth.radar_score ?? (metrics.market_growth.last12_vs_prev12_growth + 1) * 50), fullMark: 100 },
      { metric: '淡旺季友好度', value: clamp(metrics.seasonality.entry_friendliness_score ?? 50), fullMark: 100 },
      { metric: '新品承接度', value: clamp(metrics.new_product_opportunity.radar_score ?? 0), fullMark: 100 },
      { metric: '供给友好度', value: clamp(metrics.supply_complexity.radar_score ?? (100 - metrics.supply_complexity.score)), fullMark: 100 },
      { metric: '竞争开放度', value: competitionOpennessScore, fullMark: 100 },
      { metric: '数据可信度', value: clamp(metrics.data_quality.score), fullMark: 100 },
    ],
    radialRisks: [
      {
        label: '品牌垄断',
        value: metrics.brand_monopoly.risk_level === 'high' ? 86 : metrics.brand_monopoly.risk_level === 'medium' ? 58 : 32,
        text: riskLevelText(metrics.brand_monopoly.risk_level),
        detail: `按 Top3 品牌销量占比(CR3) 与 HHI 判定，当前 CR3 ${formatPercent(metrics.brand_monopoly.brand_cr3)}。`,
      },
      {
        label: '卖家垄断',
        value: metrics.seller_monopoly.risk_level === 'high' ? 86 : metrics.seller_monopoly.risk_level === 'medium' ? 58 : 32,
        text: riskLevelText(metrics.seller_monopoly.risk_level),
        detail: `按 Top3 卖家销量占比(CR3) 与 HHI 判定，当前 CR3 ${formatPercent(metrics.seller_monopoly.seller_cr3)}。`,
      },
      {
        label: '中国卖家竞争',
        value: normalizeToPercent(metrics.china_seller_competition.china_seller_sales_share),
        text: `${riskLevelText(metrics.china_seller_competition.risk_level)} · ${formatPercent(metrics.china_seller_competition.china_seller_sales_share)}`,
        detail: '按中国卖家销量 / 全部销量判定，优先使用 seller_country_region 字段识别。',
      },
    ],
    metrics: [
      {
        label: '市场增长等级',
        value: `${growthTierText(metrics.market_growth.growth_tier)} · ${formatSignedPercent(metrics.market_growth.last12_vs_prev12_growth)}`,
        hint: (metrics.market_growth.tier_thresholds ?? []).join(' / '),
      },
      {
        label: '季节性等级',
        value: `${seasonalityTierText(metrics.seasonality.seasonality_tier)} · Peak3 ${formatPercent(metrics.seasonality.peak3_month_sales_share)}`,
        hint: (metrics.seasonality.tier_thresholds ?? []).join(' / '),
      },
      {
        label: '新品机会等级',
        value: `${opportunityLevelText(metrics.new_product_opportunity.opportunity_level)} · 数量 ${formatPercent(metrics.new_product_opportunity.new_product_share)} / 销量 ${formatPercent(metrics.new_product_opportunity.new_product_sales_share)}`,
        hint: (metrics.new_product_opportunity.level_thresholds ?? []).join(' / '),
      },
      {
        label: '供给复杂度',
        value: `${supplyComplexityText(metrics.supply_complexity.complexity_level)} · ${metrics.supply_complexity.score.toFixed(1)} / 100`,
        hint: `履约 ${metrics.supply_complexity.fulfillment_mix_score.toFixed(1)} / FBA ${metrics.supply_complexity.fba_fee_pressure_score.toFixed(1)} / 价格 ${metrics.supply_complexity.price_dispersion_score.toFixed(1)}`,
      },
      {
        label: '数据质量',
        value: `${dataQualityLevelText(metrics.data_quality.level)} · ${metrics.data_quality.score.toFixed(1)} / 100`,
        hint: metrics.data_quality.summary ?? '',
      },
      {
        label: '样本产品数',
        value: `${formatNumber(dataset.row_count_products)} 个样本`,
        hint: `共 ${datasets.length || 1} 个版本，时间跨度 ${historySpanText}`,
      },
    ],
    warningItems: [
      { label: 'ASIN 缺失趋势', value: dataset.quality_warnings?.missing_trend_for_asin_count ?? 0 },
      { label: '无效价格', value: dataset.quality_warnings?.invalid_price_count ?? 0 },
      { label: '无效 FBA 费用', value: dataset.quality_warnings?.invalid_fba_fee_count ?? 0 },
      { label: '重复 ASIN', value: dataset.quality_warnings?.duplicate_asin_count ?? 0 },
      { label: '缺失 FBA 费用', value: metrics.data_quality.missing_fba_fee_count ?? 0 },
      { label: '缺失卖家国家', value: metrics.data_quality.missing_seller_country_count ?? 0 },
      { label: '缺失品牌', value: metrics.data_quality.missing_brand_count ?? 0 },
      { label: '未知履约方式', value: metrics.data_quality.unknown_fulfillment_count ?? 0 },
    ],
    actions: (metrics.action_recommendations ?? []).slice().sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority)),
    historyData: historyRows,
    radarNotes: [
      '雷达已统一成“越高越好”的正向口径。',
      '季节性、供给复杂度、品牌/卖家集中等天然带风险的指标，已做反向修正后再入雷达。',
      '满分标准对应：高增长、弱季节性、新品承接强、供给复杂度低、竞争更开放、数据质量高。',
    ],
    metricDefinitionCards: [
      'last12_vs_prev12_growth',
      'seasonality_level',
      'new_product_sales_share',
      'supply_complexity_score',
      'data_quality_score',
      'china_seller_sales_share',
    ]
      .map((key) => definitions.get(key))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => ({
        title: item.name,
        formula: item.formula_text,
        thresholds: item.thresholds,
        interpretation: item.interpretation_template,
        actionHint: item.action_hint,
      })),
  }
}

function buildMarketChartModels(
  overview: CategoryResearchOverview | null,
  marketTrendPoints: Array<{ year_month: string; monthly_sales: number }>,
  products: CategoryResearchProductRow[]
) {
  if (!overview) {
    return {
      trendMetrics: [] as MetricItem[],
      listingAgeData: [] as Array<{ label: string; count: number }>,
      listingYearMonthData: [] as Array<{ label: string; count: number; monthly_sales: number }>,
      launchSegmentRows: [] as Array<{ label: string; count: number; monthly_sales: number; sales_share: number }>,
      compareTrendData: [] as Array<{ label: string; recent12: number | null; prior12: number | null; recentMonth: string; priorMonth: string }>,
      peakMonth: null as { year_month: string; monthly_sales: number } | null,
      seasonalityPanels: [] as Array<{ title: string; pieData: PieDatum[]; primaryText: string; secondaryText: string; thresholds: string[] }>,
    }
  }

  const latestIndex = marketTrendPoints.length - 1
  const latest = latestIndex >= 0 ? marketTrendPoints[latestIndex] : null
  const prev = latestIndex >= 1 ? marketTrendPoints[latestIndex - 1] : null
  const prevYear = latestIndex >= 12 ? marketTrendPoints[latestIndex - 12] : null
  const peak = marketTrendPoints.reduce(
    (best, item) => (item.monthly_sales > best.monthly_sales ? item : best),
    marketTrendPoints[0] ?? { year_month: '-', monthly_sales: 0 }
  )
  const peakIndex = marketTrendPoints.findIndex((item) => item.year_month === peak.year_month)
  const peakPrev = peakIndex > 0 ? marketTrendPoints[peakIndex - 1] : null
  const peakPrevYear = peakIndex >= 12 ? marketTrendPoints[peakIndex - 12] : null
  const launchMonthMap = new Map<string, { count: number; monthly_sales: number }>()
  const ageBuckets = [
    { label: '0-90天', min: 0, max: 90 },
    { label: '91-180天', min: 91, max: 180 },
    { label: '181-365天', min: 181, max: 365 },
    { label: '1年+', min: 366, max: 730 },
    { label: '2年+', min: 731, max: 1095 },
    { label: '3年+', min: 1096, max: Number.POSITIVE_INFINITY },
  ]
  const ageBucketCounter = new Map(ageBuckets.map((item) => [item.label, 0]))

  products.forEach((row) => {
    const age = row.listing_age_days
    if (Number.isFinite(age)) {
      const matched = ageBuckets.find((item) => Number(age) >= item.min && Number(age) <= item.max)
      if (matched) ageBucketCounter.set(matched.label, (ageBucketCounter.get(matched.label) ?? 0) + 1)
    }

    if (!row.launch_date) return
    const normalized = String(row.launch_date).slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(normalized)) return
    const current = launchMonthMap.get(normalized) ?? { count: 0, monthly_sales: 0 }
    current.count += 1
    current.monthly_sales += row.monthly_sales ?? 0
    launchMonthMap.set(normalized, current)
  })

  const orderedLaunchRows = Array.from(launchMonthMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-18)
    .map(([label, value]) => ({ label, count: value.count, monthly_sales: value.monthly_sales }))
  const totalLaunchSales = orderedLaunchRows.reduce((sum, item) => sum + item.monthly_sales, 0)
  const recent12 = marketTrendPoints.slice(-12)
  const prior12 = marketTrendPoints.slice(-24, -12)
  const compareTrendData = recent12.map((item, index) => ({
    label: formatMonthShort(item.year_month),
    recent12: item.monthly_sales,
    prior12: prior12[index]?.monthly_sales ?? null,
    recentMonth: item.year_month,
    priorMonth: prior12[index]?.year_month ?? '-',
  }))

  return {
    trendMetrics: [
      { label: '最新月份', value: latest?.year_month ?? '-' },
      { label: '最新月销量', value: formatNumber(latest?.monthly_sales ?? 0) },
      {
        label: '环比',
        value: formatSignedPercent(prev && prev.monthly_sales > 0 ? (latest!.monthly_sales - prev.monthly_sales) / prev.monthly_sales : null),
        tone: (prev && latest && latest.monthly_sales >= prev.monthly_sales ? 'positive' : 'negative') as MetricItem['tone'],
      },
      {
        label: '同比',
        value: formatSignedPercent(prevYear && prevYear.monthly_sales > 0 ? (latest!.monthly_sales - prevYear.monthly_sales) / prevYear.monthly_sales : null),
        tone: (prevYear && latest && latest.monthly_sales >= prevYear.monthly_sales ? 'positive' : 'negative') as MetricItem['tone'],
      },
      { label: '峰值月份', value: peak.year_month },
      { label: '峰值销量', value: formatNumber(peak.monthly_sales) },
      {
        label: '峰值环比',
        value: formatSignedPercent(peakPrev && peakPrev.monthly_sales > 0 ? (peak.monthly_sales - peakPrev.monthly_sales) / peakPrev.monthly_sales : null),
        tone: (peakPrev && peak.monthly_sales >= peakPrev.monthly_sales ? 'positive' : 'negative') as MetricItem['tone'],
      },
      {
        label: '峰值同比',
        value: formatSignedPercent(peakPrevYear && peakPrevYear.monthly_sales > 0 ? (peak.monthly_sales - peakPrevYear.monthly_sales) / peakPrevYear.monthly_sales : null),
        tone: (peakPrevYear && peak.monthly_sales >= peakPrevYear.monthly_sales ? 'positive' : 'negative') as MetricItem['tone'],
      },
    ],
    listingAgeData: ageBuckets.map((item) => ({ label: item.label, count: ageBucketCounter.get(item.label) ?? 0 })),
    listingYearMonthData: orderedLaunchRows,
    launchSegmentRows: orderedLaunchRows
      .slice()
      .sort((a, b) => b.monthly_sales - a.monthly_sales)
      .slice(0, 8)
      .map((item) => ({
        ...item,
        sales_share: totalLaunchSales > 0 ? item.monthly_sales / totalLaunchSales : 0,
      })),
    compareTrendData,
    peakMonth: peak,
    seasonalityPanels: [
      {
        title: '季节性',
        pieData: [
          {
            name: 'Peak3 月份占比',
            value: normalizeToPercent(overview.advanced_metrics.seasonality.peak3_month_sales_share),
            fill: PIE_COLORS[3],
            description: '销量最高的 3 个月合计占比，越高说明旺季越集中。',
          },
          {
            name: '其他月份',
            value: 100 - normalizeToPercent(overview.advanced_metrics.seasonality.peak3_month_sales_share),
            fill: 'hsl(210 20% 90%)',
            description: '除旺季外的其余月份销量占比。',
          },
        ],
        primaryText: `${seasonalityTierText(overview.advanced_metrics.seasonality.seasonality_tier)} · ${formatPercent(overview.advanced_metrics.seasonality.peak3_month_sales_share)}`,
        secondaryText: `CV ${overview.advanced_metrics.seasonality.monthly_sales_cv.toFixed(2)} · 入场月 ${overview.advanced_metrics.seasonality.recommended_entry_months.join(', ') || '无'}`,
        thresholds: overview.advanced_metrics.seasonality.tier_thresholds ?? [],
      },
      {
        title: '增长',
        pieData: [
          {
            name: '增长得分',
            value: clamp((overview.advanced_metrics.market_growth.last12_vs_prev12_growth + 1) * 50),
            fill: PIE_COLORS[0],
            description: '把近 12 个月相对上一轮 12 个月的增幅折算成 0-100 分。',
          },
          {
            name: '剩余区间',
            value: 100 - clamp((overview.advanced_metrics.market_growth.last12_vs_prev12_growth + 1) * 50),
            fill: 'hsl(210 20% 90%)',
            description: '距离满分区间的剩余部分，用于直观看增长强弱。',
          },
        ],
        primaryText: `${growthTierText(overview.advanced_metrics.market_growth.growth_tier)} · ${formatSignedPercent(overview.advanced_metrics.market_growth.last12_vs_prev12_growth)}`,
        secondaryText: `CAGR-like ${formatSignedPercent(overview.advanced_metrics.market_growth.cagr_like_growth)} · 趋势斜率 ${overview.advanced_metrics.market_growth.trend_slope.toFixed(2)}`,
        thresholds: overview.advanced_metrics.market_growth.tier_thresholds ?? [],
      },
    ],
  }
}

function buildBrandChartModels(overview: CategoryResearchOverview | null) {
  if (!overview) {
    return {
      top10: [] as CategoryResearchOverview['brand_sales_share'],
      pieData: [] as PieDatum[],
      radarData: [] as BrandRadarRow[],
      bandCoverageData: [] as Array<Record<string, string | number>>,
      metrics: [] as MetricItem[],
      tableRows: [] as NonNullable<CategoryResearchOverview['advanced_metrics']['brand_price_band_analysis']>,
      radarBrands: [] as string[],
      explanationCards: [] as Array<{ title: string; formula: string; thresholds: string[]; interpretation: string }>,
    }
  }

  const top10 = overview.brand_sales_share.slice(0, 10)
  const top5Analysis = (overview.advanced_metrics.brand_price_band_analysis ?? []).slice(0, 5)
  const totalTop10Share = top10.reduce((sum, item) => sum + item.share, 0)
  const brandShareMap = new Map(overview.brand_sales_share.map((item) => [item.brand, item.share]))
  const bandLabels = Array.from(
    new Set(top5Analysis.flatMap((item) => item.band_distribution.map((band) => band.label)))
  )
  const top5MaxShare = Math.max(0.01, ...top5Analysis.map((item) => brandShareMap.get(item.brand) ?? 0))

  const radarBrands = top5Analysis.map((item) => item.brand)
  const definitionMap = new Map((overview.advanced_metrics.metric_definitions ?? []).map((item) => [item.key, item]))
  const radarData = [
    {
      metric: '销量',
      ...Object.fromEntries(top5Analysis.map((item) => [item.brand, clamp((item.monthly_sales / Math.max(1, top5Analysis[0]?.monthly_sales ?? 1)) * 100)])),
    },
    {
      metric: '份额',
      ...Object.fromEntries(top5Analysis.map((item) => [item.brand, clamp(((brandShareMap.get(item.brand) ?? 0) / top5MaxShare) * 100)])),
    },
    {
      metric: '价格跨度',
      ...Object.fromEntries(top5Analysis.map((item) => [item.brand, clamp((item.price_range.max_price - item.price_range.min_price) * 2)])),
    },
    {
      metric: '覆盖价格带',
      ...Object.fromEntries(top5Analysis.map((item) => [item.brand, clamp((item.covered_bands.length / Math.max(1, bandLabels.length)) * 100)])),
    },
    {
      metric: '产品数',
      ...Object.fromEntries(top5Analysis.map((item) => [item.brand, clamp((item.product_count / Math.max(1, top5Analysis[0]?.product_count ?? 1)) * 100)])),
    },
  ]

  return {
    top10,
    pieData: [
      { name: 'Top10 品牌', value: totalTop10Share * 100, fill: PIE_COLORS[0], description: '前 10 品牌合计销量份额。' },
      { name: '其他品牌', value: Math.max(0, (1 - totalTop10Share) * 100), fill: PIE_COLORS[3], description: '除 Top10 外其余品牌合计销量份额。' },
    ],
    radarData,
    bandCoverageData: bandLabels.map((bandLabel) => {
      const row: Record<string, string | number> = { label: bandLabel }
      top5Analysis.forEach((item) => {
        const matched = item.band_distribution.find((band) => band.label === bandLabel)
        row[item.brand] = clamp((matched?.share ?? 0) * 100)
      })
      return row
    }),
    metrics: [
      { label: '品牌总数', value: formatNumber(overview.kpis.brand_count) },
      { label: 'Top1 占比', value: formatPercent(top10[0]?.share ?? null) },
      { label: '品牌 CR3', value: formatPercent(overview.advanced_metrics.brand_monopoly.brand_cr3) },
      { label: '品牌 CR5', value: formatPercent(overview.advanced_metrics.brand_monopoly.brand_cr5) },
      { label: '品牌 CR10', value: formatPercent(overview.advanced_metrics.brand_monopoly.brand_cr10) },
      { label: '品牌 HHI', value: formatNumber(overview.advanced_metrics.brand_monopoly.brand_hhi) },
      { label: '风险等级', value: riskLevelText(overview.advanced_metrics.brand_monopoly.risk_level) },
    ],
    tableRows: top5Analysis,
    radarBrands,
    explanationCards: ['brand_cr3', 'brand_hhi']
      .map((key) => definitionMap.get(key))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => ({
        title: item.name,
        formula: item.formula_text,
        thresholds: item.thresholds,
        interpretation: item.interpretation_template,
      })),
  }
}

function buildSellerChartModels(overview: CategoryResearchOverview | null) {
  if (!overview) {
    return {
      nationalityPieData: [] as PieDatum[],
      nationalityBarData: [] as Array<{ label: string; sales_share_pct: number; count_share_pct: number }>,
      radialData: [] as Array<{ label: string; value: number; text: string }>,
      fulfillmentData: [] as Array<{ label: string; count: number }>,
      radarData: [] as SellerStructureDatum[],
      metrics: [] as MetricItem[],
      explanationCards: [] as Array<{ title: string; formula: string; thresholds: string[]; interpretation: string }>,
    }
  }

  const china = overview.advanced_metrics.china_seller_competition
  const seller = overview.advanced_metrics.seller_monopoly
  const definitionMap = new Map((overview.advanced_metrics.metric_definitions ?? []).map((item) => [item.key, item]))
  const fulfillmentData = overview.fulfillment_distribution.map((item) => ({ label: item.label || '未知', count: item.count }))
  const totalFulfillment = fulfillmentData.reduce((sum, item) => sum + item.count, 0)
  const fbaShare = totalFulfillment > 0
    ? fulfillmentData
      .filter((item) => item.label.toUpperCase().includes('FBA'))
      .reduce((sum, item) => sum + item.count, 0) / totalFulfillment
    : 0

  return {
    nationalityPieData: [
      { name: '中国卖家', value: china.china_seller_sales_share * 100, fill: PIE_COLORS[0], description: '中国卖家贡献的销量占比。' },
      { name: '非中国卖家', value: (1 - china.china_seller_sales_share) * 100, fill: PIE_COLORS[2], description: '非中国卖家贡献的销量占比。' },
    ],
    nationalityBarData: [
      {
        label: '中国卖家',
        sales_share_pct: china.china_seller_sales_share * 100,
        count_share_pct: china.china_seller_count_share * 100,
      },
      {
        label: '非中国卖家',
        sales_share_pct: (1 - china.china_seller_sales_share) * 100,
        count_share_pct: (1 - china.china_seller_count_share) * 100,
      },
    ],
    radialData: [
      { label: 'FBA占比', value: fbaShare * 100, text: formatPercent(fbaShare) },
      { label: '自营占比', value: seller.amazon_seller_sales_share * 100, text: formatPercent(seller.amazon_seller_sales_share) },
      { label: '中国卖家销量占比', value: china.china_seller_sales_share * 100, text: formatPercent(china.china_seller_sales_share) },
    ],
    fulfillmentData,
    radarData: [
      { metric: '卖家数量', value: clamp((seller.seller_count / 100) * 100), fullMark: 100 },
      { metric: 'CR3', value: normalizeToPercent(seller.seller_cr3), fullMark: 100 },
      { metric: 'CR5', value: normalizeToPercent(seller.seller_cr5), fullMark: 100 },
      { metric: 'HHI', value: clamp(seller.seller_hhi / 100), fullMark: 100 },
      { metric: 'FBA占比', value: fbaShare * 100, fullMark: 100 },
      { metric: '非自营空间', value: (1 - seller.amazon_seller_sales_share) * 100, fullMark: 100 },
    ],
    metrics: [
      { label: '卖家数', value: formatNumber(seller.seller_count) },
      { label: '卖家 TOP1 (CR1)', value: formatPercent(seller.seller_cr1) },
      { label: '卖家 CR3', value: formatPercent(seller.seller_cr3) },
      { label: '卖家 CR5', value: formatPercent(seller.seller_cr5) },
      { label: '卖家 CR10', value: formatPercent(seller.seller_cr10) },
      { label: '卖家 HHI', value: formatNumber(seller.seller_hhi) },
      { label: '中国卖家数量占比', value: formatPercent(china.china_seller_count_share) },
      { label: '卖家垄断风险', value: riskLevelText(seller.risk_level) },
    ],
    explanationCards: ['seller_monopoly_ratio', 'seller_hhi', 'china_seller_sales_share']
      .map((key) => definitionMap.get(key))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => ({
        title: item.name,
        formula: item.formula_text,
        thresholds: item.thresholds,
        interpretation: item.interpretation_template,
      })),
  }
}

function buildReviewChartModels(overview: CategoryResearchOverview | null) {
  if (!overview) {
    return {
      ratingDistribution: [] as Array<{ label: string; count: number }>,
      lowReviewPieData: [] as PieDatum[],
      cumulativeShareData: [] as Array<{ label: string; monthly_sales: number; cumulative_share_pct: number }>,
      radialData: [] as Array<{ label: string; value: number; text: string }>,
      metrics: [] as MetricItem[],
      detailRows: [] as Array<{ label: string; stage: string; count: number; monthly_sales: number; cumulative_share_pct: number }>,
      methodologyNotes: [] as string[],
    }
  }

  const review = overview.advanced_metrics.review_research
  const buckets = review.rating_band_distribution ?? []
  const segments = review.review_segment_distribution ?? []

  const totalSales = segments.reduce((sum, item) => sum + item.monthly_sales, 0)
  let running = 0
  const cumulativeShareData = segments.map((item) => {
    running += item.monthly_sales
    return {
      ...item,
      cumulative_share_pct: totalSales > 0 ? (running / totalSales) * 100 : 0,
    }
  })

  return {
    ratingDistribution: buckets,
    lowReviewPieData: [
      { name: '末尾25%产品数', value: (review.bottom_quartile_product_share ?? 0) * 100, fill: PIE_COLORS[0], description: '评论数处于样本底部 25% 的产品占比。' },
      { name: '其他产品数', value: (1 - (review.bottom_quartile_product_share ?? 0)) * 100, fill: PIE_COLORS[3], description: '不在末尾评论层的其他产品占比。' },
    ],
    cumulativeShareData,
    radialData: [
      { label: '评价中位数', value: clamp((review.review_median / Math.max(1, review.review_p75)) * 100), text: formatNumber(review.review_median) },
      { label: '评价 P75', value: clamp((review.review_p75 / Math.max(1, review.review_p75)) * 100), text: formatNumber(review.review_p75) },
      { label: 'Top10评价占比', value: review.review_top10_share * 100, text: formatPercent(review.review_top10_share) },
      { label: '低评价产品占比', value: review.low_review_product_share * 100, text: formatPercent(review.low_review_product_share) },
    ],
    metrics: [
      { label: '平均评分', value: (review.average_rating ?? 0).toFixed(2) },
      { label: '评价中位数', value: formatNumber(review.review_median) },
      { label: '评价P75', value: formatNumber(review.review_p75) },
      { label: 'Top10评价占比', value: formatPercent(review.review_top10_share) },
      { label: '低评价产品占比', value: formatPercent(review.low_review_product_share), hint: `低于 ${review.low_review_threshold ?? 100} 条评论` },
      { label: '评分档位数', value: formatNumber(buckets.filter((item) => item.count > 0).length) },
      { label: '主力评论段', value: cumulativeShareData.slice().sort((a, b) => b.monthly_sales - a.monthly_sales)[0]?.label ?? '-' },
    ],
    detailRows: cumulativeShareData.map((item, index) => ({
      ...item,
      stage: reviewSegmentTierLabel(index, cumulativeShareData.length),
      count: segments[index]?.count ?? 0,
    })),
    methodologyNotes: [
      '评论分段完全基于数据库 review_count，不再借用其他代理指标。',
      '系统按评论分布自动切成约 10 个分段，优先保留低评论冷启动段和高评论壁垒段。',
      `低评价产品占比单独按 <${review.low_review_threshold ?? 100} 条评论计算。`,
      '末尾25%产品数 Pie 用于看弱势评论层的样本占比，不等同于销量占比。',
    ],
  }
}

function buildPriceChartModels(overview: CategoryResearchOverview | null) {
  if (!overview) {
    return {
      largeBandData: [] as Array<{ label: string; monthly_sales: number; count: number }>,
      smallBandData: [] as Array<{ label: string; monthly_sales: number; count: number }>,
      scatterData: [] as PriceScatterDatum[],
      pieData: [] as PieDatum[],
      radarData: [] as Array<{ metric: string; value: number; fullMark: number }>,
      metrics: [] as MetricItem[],
      detailRows: [] as Array<{ label: string; monthly_sales: number; count: number; group: string }>,
      methodologyNotes: [] as string[],
    }
  }

  const salesMap = new Map<string, number>(
    overview.advanced_metrics.price_band_opportunities.map((item) => [item.label, item.monthly_sales])
  )
  const largeBandData = overview.fixed_price_bands.map((item) => ({
    label: item.label,
    monthly_sales: salesMap.get(item.label) ?? 0,
    count: item.count,
  }))

  const smallBandData = largeBandData.map((item) => ({ ...item }))

  const totalLargeCount = largeBandData.reduce((sum, item) => sum + item.count, 0)
  const priceSpread = overview.price_stats.p75 - overview.price_stats.p25
  const priceCorrelationScore = overview.advanced_metrics.price_correlation_score ?? clamp(100 - Math.abs(overview.price_sales_correlation) * 100)

  return {
    largeBandData,
    smallBandData,
    scatterData: overview.price_sales_points
      .filter((point) => Number.isFinite(point.price_usd) && Number.isFinite(point.monthly_sales))
      .slice(0, 200)
      .map((point) => ({
        asin: point.asin ?? '-',
        price_usd: point.price_usd,
        monthly_sales: point.monthly_sales,
      })),
    pieData: largeBandData.map((item, index) => ({
      name: item.label,
      value: totalLargeCount > 0 ? (item.count / totalLargeCount) * 100 : 0,
      fill: PIE_COLORS[index % PIE_COLORS.length],
      description: `${formatNumber(item.count)} 个样本落在该价格带。`,
    })),
    radarData: [
      { metric: '均价', value: clamp((overview.price_stats.mean / Math.max(1, overview.price_stats.p75)) * 100), fullMark: 100 },
      { metric: '中位价', value: clamp((overview.price_stats.median / Math.max(1, overview.price_stats.p75)) * 100), fullMark: 100 },
      { metric: 'P25', value: clamp((overview.price_stats.p25 / Math.max(1, overview.price_stats.p75)) * 100), fullMark: 100 },
      { metric: 'P75', value: clamp((overview.price_stats.p75 / Math.max(1, overview.price_stats.p75)) * 100), fullMark: 100 },
      { metric: '价格离散度', value: clamp(priceSpread * 2), fullMark: 100 },
      { metric: '价格相关得分', value: priceCorrelationScore, fullMark: 100 },
    ],
    metrics: [
      { label: '均价', value: formatCurrency(overview.price_stats.mean) },
      { label: '中位价', value: formatCurrency(overview.price_stats.median) },
      { label: 'P25', value: formatCurrency(overview.price_stats.p25) },
      { label: 'P75', value: formatCurrency(overview.price_stats.p75) },
      {
        label: '价格-销量相关',
        value: `${overview.price_sales_correlation.toFixed(4)} / ${priceCorrelationScore.toFixed(1)}分`,
        hint: '皮尔逊绝对值越低，说明价格对销量解释力越弱，价格带自由度越高。',
      },
      {
        label: '销量最高区间',
        value: largeBandData.slice().sort((a, b) => b.monthly_sales - a.monthly_sales)[0]?.label ?? '-',
        hint: overview.advanced_metrics.price_band_method_description ?? '',
      },
    ],
    detailRows: [
      ...largeBandData.map((item) => ({ ...item, group: '精细价格带' })),
    ],
    methodologyNotes: [
      `当前价格带方法: ${overview.advanced_metrics.price_band_method_description ?? '基于价格分布自动生成。'}`,
      '默认方法会先看价格分布的 IQR，再用 nice step 生成可读性更好的断点，而不是固定写死 $50 / $100 / $150。',
      `当前断点: ${(overview.advanced_metrics.price_band_breaks ?? []).map((item) => `$${item}`).join(' / ') || '无'}`,
      `价格相关得分 ${priceCorrelationScore.toFixed(1)} / 100，来自皮尔逊系数 ${overview.price_sales_correlation.toFixed(4)} 的反向转换。`,
    ],
  }
}

function MetricGridCard({ title, description, items }: { title: string; description: string; items: MetricItem[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <div key={item.label} className="rounded-xl border border-border/70 bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p
              className={cn(
                'mt-1 text-lg font-semibold',
                item.tone === 'positive' && 'text-emerald-600',
                item.tone === 'negative' && 'text-rose-600'
              )}
            >
              {item.value}
            </p>
            {item.hint ? <p className="mt-1 text-xs text-muted-foreground">{item.hint}</p> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function InsightChartCard({
  title,
  description,
  children,
  footer,
  className,
  contentClassName,
}: {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className={cn('space-y-4', contentClassName)}>
        {children}
        {footer ? <div className="border-t border-border/60 pt-3 text-xs text-muted-foreground">{footer}</div> : null}
      </CardContent>
    </Card>
  )
}

function PieLegendNotes({
  items,
  className,
}: {
  items: PieDatum[]
  className?: string
}) {
  if (items.length === 0) return null

  return (
    <div className={cn('grid gap-2 sm:grid-cols-2', className)}>
      {items.map((item) => (
        <div key={item.name} className="rounded-xl border border-border/60 bg-muted/10 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.fill }} />
              <span className="truncate text-sm text-foreground">{item.name}</span>
            </div>
            <span className="shrink-0 text-sm font-medium text-foreground">{compactPercentLabel(item.value)}</span>
          </div>
          {item.description ? <p className="mt-1 text-xs text-muted-foreground">{item.description}</p> : null}
        </div>
      ))}
    </div>
  )
}

function EmptyChartState({ message, height = 'h-[280px]' }: { message: string; height?: string }) {
  return (
    <div className={cn('flex items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/10 text-sm text-muted-foreground', height)}>
      {message}
    </div>
  )
}

function SingleRadialGauge({
  title,
  value,
  text,
  color,
}: {
  title: string
  value: number
  text: string
  color: string
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-muted/10 p-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <div className="mt-2 h-[180px]">
        <ChartContainer
          config={{ value: { label: title, color } }}
          className="h-full w-full"
        >
          <RadialBarChart
            accessibilityLayer
            data={[{ name: title, value }]}
            startAngle={90}
            endAngle={-270}
            innerRadius="70%"
            outerRadius="100%"
          >
            <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
              <Label
                content={({ viewBox }) => {
                  if (!viewBox || !('cx' in viewBox) || !('cy' in viewBox)) return null
                  return (
                    <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle">
                      <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-2xl font-semibold">
                        {Math.round(value)}
                      </tspan>
                      <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 20} className="fill-muted-foreground text-xs">
                        {text}
                      </tspan>
                    </text>
                  )
                }}
              />
            </PolarRadiusAxis>
            <RadialBar dataKey="value" cornerRadius={8} fill="var(--color-value)" background />
          </RadialBarChart>
        </ChartContainer>
      </div>
    </div>
  )
}

export default function CategoryResearchPage() {
  const { data: session } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  const currentOperator = (session?.user?.operatorNameZh || session?.user?.name || session?.user?.email || '').trim()

  const [marketplace, setMarketplace] = useState('US')
  const [keywordEn, setKeywordEn] = useState('')
  const [nameZh, setNameZh] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [recomputingCurrent, setRecomputingCurrent] = useState(false)
  const [recomputingHistory, setRecomputingHistory] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSuccess, setFormSuccess] = useState<string | null>(null)

  const [datasets, setDatasets] = useState<CategoryResearchDataset[]>([])
  const [datasetLoading, setDatasetLoading] = useState(false)
  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(null)

  const [overview, setOverview] = useState<CategoryResearchOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [marketTrendPoints, setMarketTrendPoints] = useState<Array<{ year_month: string; monthly_sales: number }>>([])
  const [marketTrendLoading, setMarketTrendLoading] = useState(false)
  const [productSample, setProductSample] = useState<CategoryResearchProductRow[]>([])
  const [productSampleLoading, setProductSampleLoading] = useState(false)

  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('research')
  const [analysisKeyword, setAnalysisKeyword] = useState('')
  const [keywordLoading, setKeywordLoading] = useState(false)
  const [availableKeywords, setAvailableKeywords] = useState<Array<{ keyword: string; nameZh: string }>>([])
  const [tab, setTab] = useState<ViewTab>('overview')

  const loadKeywordOptions = useCallback(async () => {
    setKeywordLoading(true)
    try {
      const params = new URLSearchParams({
        marketplace,
        current_only: 'true',
      })
      const response = await fetch(resolveApiUrl(`/api/v1/category-research/datasets?${params.toString()}`), {
        cache: 'no-store',
        headers: authHeaders(currentOperator, isAdmin),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }
      const rows = (await response.json()) as CategoryResearchDataset[]
      const uniqueKeywords = Array.from(
        rows.reduce((acc, item) => {
          if (!acc.has(item.category_keyword_en)) {
            acc.set(item.category_keyword_en, {
              keyword: item.category_keyword_en,
              nameZh: item.category_name_zh,
            })
          }
          return acc
        }, new Map<string, { keyword: string; nameZh: string }>())
      ).map(([, item]) => item)
      setAvailableKeywords(uniqueKeywords)
      setAnalysisKeyword((prev) => {
        if (prev && uniqueKeywords.some((item) => item.keyword === prev)) return prev
        return uniqueKeywords[0]?.keyword ?? ''
      })
      return true
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '关键词加载失败')
      return false
    } finally {
      setKeywordLoading(false)
    }
  }, [marketplace, currentOperator, isAdmin])

  const loadDatasets = useCallback(async (keyword: string) => {
    const normalizedKeyword = keyword.trim()
    if (!normalizedKeyword) {
      setDatasets([])
      setSelectedDatasetId(null)
      return true
    }
    setDatasetLoading(true)
    try {
      const params = new URLSearchParams({
        marketplace,
        category_keyword_en: normalizedKeyword,
        include_history: 'true',
      })
      const response = await fetch(resolveApiUrl(`/api/v1/category-research/datasets?${params.toString()}`), {
        cache: 'no-store',
        headers: authHeaders(currentOperator, isAdmin),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }
      const rows = (await response.json()) as CategoryResearchDataset[]
      setDatasets(rows)
      setSelectedDatasetId((prev) => rows.find((item) => item.id === prev)?.id ?? rows[0]?.id ?? null)
      return true
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '历史版本加载失败')
      return false
    } finally {
      setDatasetLoading(false)
    }
  }, [marketplace, currentOperator, isAdmin])

  const loadOverview = useCallback(async (datasetId: number) => {
    setOverviewLoading(true)
    try {
      const response = await fetch(resolveApiUrl(`/api/v1/category-research/datasets/${datasetId}`), {
        cache: 'no-store',
        headers: authHeaders(currentOperator, isAdmin),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }
      const payload = (await response.json()) as CategoryResearchOverview
      setOverview(payload)
      return true
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '看板数据加载失败')
      setOverview(null)
      return false
    } finally {
      setOverviewLoading(false)
    }
  }, [currentOperator, isAdmin])

  const loadProducts = useCallback(async (datasetId: number) => {
    setProductSampleLoading(true)
    try {
      const response = await fetch(
        resolveApiUrl(`/api/v1/category-research/datasets/${datasetId}/products?page=1&page_size=500`),
        {
          cache: 'no-store',
          headers: authHeaders(currentOperator, isAdmin),
        }
      )
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }
      const payload = (await response.json()) as ProductsPayload
      setProductSample(payload.rows ?? [])
      return true
    } catch (error) {
      setProductSample([])
      setFormError(error instanceof Error ? error.message : '产品样本加载失败')
      return false
    } finally {
      setProductSampleLoading(false)
    }
  }, [currentOperator, isAdmin])

  const loadMarketTrend = useCallback(async (datasetId: number) => {
    setMarketTrendLoading(true)
    try {
      const response = await fetch(resolveApiUrl(`/api/v1/category-research/datasets/${datasetId}/market-trend?months=24`), {
        cache: 'no-store',
        headers: authHeaders(currentOperator, isAdmin),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }
      const payload = (await response.json()) as CategoryResearchMarketTrendPayload
      setMarketTrendPoints(payload.points || [])
      return true
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '市场趋势加载失败')
      setMarketTrendPoints([])
      return false
    } finally {
      setMarketTrendLoading(false)
    }
  }, [currentOperator, isAdmin])

  useEffect(() => {
    void loadKeywordOptions()
  }, [loadKeywordOptions])

  useEffect(() => {
    if (!analysisKeyword.trim()) {
      setDatasets([])
      setSelectedDatasetId(null)
      return
    }
    void loadDatasets(analysisKeyword)
  }, [analysisKeyword, loadDatasets])

  useEffect(() => {
    if (!selectedDatasetId) {
      setOverview(null)
      setMarketTrendPoints([])
      setProductSample([])
      return
    }
    void loadOverview(selectedDatasetId)
    void loadMarketTrend(selectedDatasetId)
    void loadProducts(selectedDatasetId)
  }, [selectedDatasetId, loadMarketTrend, loadOverview, loadProducts])

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setUploadFile(event.target.files?.[0] ?? null)
  }

  const onSubmit = async () => {
    setFormError(null)
    setFormSuccess(null)

    if (!keywordEn.trim()) {
      setFormError('请输入品类关键词（英文）')
      return
    }
    if (!nameZh.trim()) {
      setFormError('请输入品类名称（中文）')
      return
    }
    if (!uploadFile) {
      setFormError('请上传 xlsx 文件')
      return
    }

    setSubmitting(true)
    try {
      const formData = new FormData()
      formData.append('marketplace', marketplace)
      formData.append('category_keyword_en', keywordEn.trim())
      formData.append('category_name_zh', nameZh.trim())
      formData.append('file', uploadFile)

      const response = await fetch(resolveApiUrl('/api/v1/category-research/datasets/import'), {
        method: 'POST',
        headers: authHeaders(currentOperator, isAdmin),
        body: formData,
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }
      const payload = (await response.json()) as {
        dataset_id: number
        version: number
        row_count_products: number
        row_count_trends: number
      }
      const normalizedKeyword = keywordEn.trim()
      setSelectedDatasetId(payload.dataset_id)
      setAnalysisKeyword(normalizedKeyword)
      setWorkspaceTab('analysis')
      setTab('overview')
      setFormSuccess(`导入成功：版本 V${payload.version}，产品 ${payload.row_count_products} 条，趋势 ${payload.row_count_trends} 条`)
      await loadDatasets(normalizedKeyword)
      await loadKeywordOptions()
      await loadOverview(payload.dataset_id)
      await loadMarketTrend(payload.dataset_id)
      await loadProducts(payload.dataset_id)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '导入失败')
    } finally {
      setSubmitting(false)
    }
  }

  const onRecomputeCurrent = async () => {
    if (!selectedDatasetId) {
      setFormError('请先选择需要重算的版本')
      return
    }
    setFormError(null)
    setFormSuccess(null)
    setRecomputingCurrent(true)
    try {
      const response = await fetch(resolveApiUrl(`/api/v1/category-research/datasets/${selectedDatasetId}/recompute`), {
        method: 'POST',
        headers: authHeaders(currentOperator, isAdmin),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }
      const payload = (await response.json()) as { dataset_id: number; row_count_products: number; row_count_trends: number }
      const refreshResults = await Promise.all([
        loadDatasets(analysisKeyword || keywordEn),
        loadOverview(payload.dataset_id),
        loadMarketTrend(payload.dataset_id),
        loadProducts(payload.dataset_id),
      ])
      if (refreshResults.some((item) => item === false)) {
        throw new Error('重算完成，但页面数据刷新失败，请手动刷新后重试')
      }
      setFormError(null)
      setFormSuccess(`重算完成：版本ID ${payload.dataset_id}，产品 ${payload.row_count_products} 条，趋势 ${payload.row_count_trends} 条`)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '重算失败')
    } finally {
      setRecomputingCurrent(false)
    }
  }

  const onRecomputeHistory = async () => {
    const keyword = analysisKeyword.trim() || keywordEn.trim()
    if (!keyword) {
      setFormError('请先选择调研关键词后再批量重算')
      return
    }
    setFormError(null)
    setFormSuccess(null)
    setRecomputingHistory(true)
    try {
      const params = new URLSearchParams({
        marketplace,
        category_keyword_en: keyword,
        include_history: 'true',
      })
      const response = await fetch(resolveApiUrl(`/api/v1/category-research/datasets/recompute?${params.toString()}`), {
        method: 'POST',
        headers: authHeaders(currentOperator, isAdmin),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }
      const payload = (await response.json()) as { matched: number; recomputed: number }
      const refreshTasks: Array<Promise<boolean>> = [loadDatasets(keyword)]
      if (selectedDatasetId) {
        refreshTasks.push(loadOverview(selectedDatasetId))
        refreshTasks.push(loadMarketTrend(selectedDatasetId))
        refreshTasks.push(loadProducts(selectedDatasetId))
      }
      const refreshResults = await Promise.all(refreshTasks)
      if (refreshResults.some((item) => item === false)) {
        throw new Error('历史重算完成，但页面数据刷新失败，请手动刷新后重试')
      }
      setFormError(null)
      setFormSuccess(`历史重算完成：匹配 ${payload.matched} 个版本，重算 ${payload.recomputed} 个版本`)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '历史重算失败')
    } finally {
      setRecomputingHistory(false)
    }
  }

  const overviewModels = useMemo(() => buildOverviewChartModels(overview, datasets), [datasets, overview])
  const marketModels = useMemo(() => buildMarketChartModels(overview, marketTrendPoints, productSample), [overview, marketTrendPoints, productSample])
  const brandModels = useMemo(() => buildBrandChartModels(overview), [overview])
  const sellerModels = useMemo(() => buildSellerChartModels(overview), [overview])
  const reviewModels = useMemo(() => buildReviewChartModels(overview), [overview])
  const priceModels = useMemo(() => buildPriceChartModels(overview), [overview])

  const analysisHeaderBadges = useMemo(() => {
    if (!overview) return []
    return [
      `关键词: ${overview.dataset.category_keyword_en}`,
      `版本: V${overview.dataset.version}`,
      `数据日期: ${formatDatasetDate(overview.dataset)}`,
      `时效: ${formatDatasetFreshness(overview.dataset)}`,
      `产品: ${formatNumber(overview.dataset.row_count_products)}`,
      `趋势: ${formatNumber(overview.dataset.row_count_trends)}`,
    ]
  }, [overview])

  const brandBandKeys = useMemo(() => brandModels.tableRows.map((item) => item.brand), [brandModels.tableRows])

  return (
    <Tabs
      value={workspaceTab}
      onValueChange={(value) => setWorkspaceTab(value as WorkspaceTab)}
      className="w-full space-y-6"
    >
      <div className="flex items-center justify-between">
        <TabsList className="grid h-11 w-full max-w-[320px] grid-cols-2">
          <TabsTrigger value="research">调研</TabsTrigger>
          <TabsTrigger value="analysis">分析</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="research" className="space-y-6">
        <Card className="overflow-hidden border-border/80 shadow-[0_20px_45px_-24px_rgba(15,23,42,0.3)]">
          <CardHeader className="border-b bg-gradient-to-r from-cyan-500/10 via-sky-500/5 to-transparent">
            <CardTitle className="flex items-center gap-2 text-xl">
              <Upload className="h-5 w-5" />
              调研工作台
            </CardTitle>
            <CardDescription>上传 BestSeller 类目表并完成核算，生成可复用的调研版本。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 p-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">站点</p>
                <Select value={marketplace} onValueChange={setMarketplace}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择站点" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="US">US</SelectItem>
                    <SelectItem value="UK">UK</SelectItem>
                    <SelectItem value="DE">DE</SelectItem>
                    <SelectItem value="JP">JP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 xl:col-span-2">
                <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">品类关键词（英文）</p>
                <Input placeholder="例如: reciprocating saws" value={keywordEn} onChange={(event) => setKeywordEn(event.target.value)} />
              </div>
              <div className="space-y-2 xl:col-span-2">
                <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">品类名称（中文）</p>
                <Input placeholder="例如: 往复锯" value={nameZh} onChange={(event) => setNameZh(event.target.value)} />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">上传文件（xlsx）</p>
                <Input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onFileChange} />
              </div>
              <Button onClick={onSubmit} disabled={submitting}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                上传并核算
              </Button>
            </div>

            {formError ? <p className="text-sm text-rose-600">{formError}</p> : null}
            {formSuccess ? <p className="text-sm text-emerald-600">{formSuccess}</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">核心过程</CardTitle>
            <CardDescription>保持上传与版本流转逻辑不变，分析端升级为图表工作台。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {[
              '填写站点与关键词',
              '上传 xlsx 原始数据',
              '执行核算/重算生成版本',
              '切换到分析查看结果',
            ].map((item, index) => (
              <div key={item} className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">Step {index + 1}</p>
                <p className="text-sm font-medium">{item}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="analysis" className="space-y-6">
        <Card className="overflow-hidden border-border/80 shadow-[0_20px_45px_-24px_rgba(15,23,42,0.3)]">
          <CardHeader className="border-b bg-gradient-to-r from-emerald-500/10 via-teal-500/5 to-transparent">
            <CardTitle className="flex items-center gap-2 text-xl">
              <Database className="h-5 w-5" />
              分析工作台
            </CardTitle>
            <CardDescription>按官方 shadcn 图表体系重构的高密度分析界面，聚焦机会、风险与结构判断。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 p-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">站点</p>
                <Select value={marketplace} onValueChange={setMarketplace}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择站点" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="US">US</SelectItem>
                    <SelectItem value="UK">UK</SelectItem>
                    <SelectItem value="DE">DE</SelectItem>
                    <SelectItem value="JP">JP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 xl:col-span-2">
                <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">调研关键词</p>
                <Select value={analysisKeyword || ''} onValueChange={setAnalysisKeyword}>
                  <SelectTrigger>
                    <SelectValue placeholder={keywordLoading ? '加载中...' : '选择已有调研关键词'} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableKeywords.map((item) => (
                      <SelectItem key={item.keyword} value={item.keyword}>
                        {`${item.keyword} · ${item.nameZh}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button variant="outline" className="w-full" onClick={() => void loadKeywordOptions()} disabled={keywordLoading}>
                  {keywordLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Database className="mr-2 h-4 w-4" />}
                  刷新关键词
                </Button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto] md:items-end">
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">版本选择</p>
                <Select value={selectedDatasetId ? String(selectedDatasetId) : ''} onValueChange={(value) => setSelectedDatasetId(Number(value))}>
                  <SelectTrigger>
                    <SelectValue placeholder={datasetLoading ? '加载中...' : '请选择版本'} />
                  </SelectTrigger>
                  <SelectContent>
                    {datasets.map((item) => (
                      <SelectItem key={item.id} value={String(item.id)}>
                        {`V${item.version} · ${item.marketplace} · ${item.category_name_zh} · ${formatDatasetDate(item)}${item.is_current ? ' (Current)' : ''}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button variant="outline" onClick={() => void loadDatasets(analysisKeyword)} disabled={datasetLoading || !analysisKeyword.trim()}>
                {datasetLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Database className="mr-2 h-4 w-4" />}
                加载版本
              </Button>
              <Button variant="outline" onClick={() => void onRecomputeCurrent()} disabled={recomputingCurrent || !selectedDatasetId}>
                {recomputingCurrent ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                重算当前版本
              </Button>
              <Button variant="outline" onClick={() => void onRecomputeHistory()} disabled={recomputingHistory || !analysisKeyword.trim()}>
                {recomputingHistory ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                重算历史版本
              </Button>
            </div>

            {formError ? <p className="text-sm text-rose-600">{formError}</p> : null}
            {formSuccess ? <p className="text-sm text-emerald-600">{formSuccess}</p> : null}

            {analysisHeaderBadges.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {analysisHeaderBadges.map((item) => (
                  <Badge key={item} variant="outline">
                    {item}
                  </Badge>
                ))}
                {productSampleLoading ? <Badge variant="outline">产品样本加载中...</Badge> : null}
              </div>
            ) : null}
          </CardContent>
        </Card>

        {overviewLoading ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-48 rounded-xl" />
            ))}
          </div>
        ) : overview ? (
          <Tabs value={tab} onValueChange={(value) => setTab(value as ViewTab)} className="space-y-6">
            <TabsList className="grid h-11 w-full max-w-[920px] grid-cols-3 md:grid-cols-6">
              <TabsTrigger value="overview">总览</TabsTrigger>
              <TabsTrigger value="market">市场</TabsTrigger>
              <TabsTrigger value="brand">品牌</TabsTrigger>
              <TabsTrigger value="seller">卖家</TabsTrigger>
              <TabsTrigger value="review">评论</TabsTrigger>
              <TabsTrigger value="price">价格</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-6">
              <MetricGridCard title="总览结论板" description="把增长、季节性、新品窗口、供给复杂度、数据质量和样本跨度放在同一屏做决策扫描。" items={overviewModels.metrics} />

              <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                <InsightChartCard
                  title="市场画像雷达"
                  description="把机会、结构和执行三个维度压成一张决策图。分数越高，越接近可进入状态。"
                  footer={
                    <div className="space-y-1">
                      {overviewModels.radarNotes.map((item) => (
                        <p key={item}>{item}</p>
                      ))}
                    </div>
                  }
                >
                  {overviewModels.radarData.length > 0 ? (
                    <ChartContainer config={overviewRadarChartConfig} className="h-[340px] w-full">
                      <RadarChart accessibilityLayer data={overviewModels.radarData}>
                        <PolarGrid />
                        <PolarAngleAxis dataKey="metric" />
                        <PolarRadiusAxis tick={false} axisLine={false} />
                        <ChartTooltip content={<ChartTooltipContent formatter={(value) => <span className="font-medium">{value}/100</span>} />} />
                        <Radar dataKey="value" fill="var(--color-value)" fillOpacity={0.24} stroke="var(--color-value)" strokeWidth={2} />
                      </RadarChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无总览雷达数据" height="h-[340px]" />
                  )}
                </InsightChartCard>

                <InsightChartCard
                  title="关键风险环"
                  description="先看最容易否决决策的三类风险：品牌垄断、卖家垄断、中国卖家竞争。"
                  contentClassName="grid gap-3 md:grid-cols-3 xl:grid-cols-1"
                >
                  {overviewModels.radialRisks.map((item, index) => (
                    <div key={item.label} className="space-y-2">
                      <SingleRadialGauge title={item.label} value={item.value} text={item.text} color={PIE_COLORS[index % PIE_COLORS.length]} />
                      <p className="text-xs leading-5 text-muted-foreground">{item.detail}</p>
                    </div>
                  ))}
                </InsightChartCard>
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <InsightChartCard title="版本样本历史" description="先确认样本是否足够稳定，再决定是否进入下一层判断。">
                  {overviewModels.historyData.length > 0 ? (
                    <ChartContainer config={{ products: { label: '样本数', color: DASHBOARD_PALETTE.blue } }} className="h-[300px] w-full">
                      <BarChart accessibilityLayer data={overviewModels.historyData}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} />
                        <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="products" fill="var(--color-products)" radius={8} />
                      </BarChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无版本历史数据" height="h-[300px]" />
                  )}
                </InsightChartCard>

                <InsightChartCard
                  title="行动建议"
                  description="把当前最值得先验证的动作排出来，避免分析停在结论描述。"
                >
                  <div className="space-y-3">
                    {overviewModels.actions.length > 0 ? (
                      overviewModels.actions.map((item) => (
                        <div key={`${item.priority}-${item.action}`} className="rounded-xl border border-border/70 bg-muted/10 p-4">
                          <div className="flex items-center justify-between gap-3">
                            <p className="font-medium text-foreground">{item.action}</p>
                            <Badge variant="outline" className={alertBadgeClass(normalizeRiskLevel(item.priority))}>
                              {item.priority.toUpperCase()}
                            </Badge>
                          </div>
                          <p className="mt-2 text-sm text-muted-foreground">{item.why}</p>
                          {item.rule_basis && item.rule_basis.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {item.rule_basis.map((rule) => (
                                <Badge key={rule} variant="secondary" className="bg-muted/60 text-muted-foreground">
                                  {rule}
                                </Badge>
                              ))}
                            </div>
                          ) : null}
                          {item.required_validation.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {item.required_validation.map((rule) => (
                                <Badge key={rule} variant="outline">
                                  {rule}
                                </Badge>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <EmptyChartState message="暂无行动建议" height="h-[300px]" />
                    )}
                  </div>
                </InsightChartCard>
              </div>

              <InsightChartCard
                title="等级与公式说明"
                description="关键等级都给出口径、阈值和当前解释，避免出现只有结论、没有依据。"
                contentClassName="grid gap-3 xl:grid-cols-2"
              >
                {overviewModels.metricDefinitionCards.map((item) => (
                  <div key={item.title} className="rounded-xl border border-border/70 bg-muted/10 p-4">
                    <p className="font-medium text-foreground">{item.title}</p>
                    <p className="mt-2 text-xs text-muted-foreground">{item.formula}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.thresholds.map((threshold) => (
                        <Badge key={threshold} variant="outline">
                          {threshold}
                        </Badge>
                      ))}
                    </div>
                    <p className="mt-3 text-sm text-muted-foreground">{item.interpretation}</p>
                    <p className="mt-2 text-xs text-muted-foreground">{item.actionHint}</p>
                  </div>
                ))}
              </InsightChartCard>

              <InsightChartCard
                title="数据质量警报"
                description="先识别会误导判断的原始问题，再决定这份样本是否值得继续分析。"
                contentClassName="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
              >
                {overviewModels.warningItems.map((item) => (
                  <div key={item.label} className="rounded-xl border border-border/70 bg-muted/10 p-4">
                    <p className="text-xs text-muted-foreground">{item.label}</p>
                    <p className={cn('mt-1 text-2xl font-semibold', item.value > 0 ? 'text-amber-600' : 'text-emerald-600')}>{formatNumber(item.value)}</p>
                  </div>
                ))}
              </InsightChartCard>
            </TabsContent>

            <TabsContent value="market" className="space-y-6">
              <MetricGridCard title="市场节奏总览" description="先看增长斜率、峰值位置和同比环比，再判断这个市场是在扩张、波动还是回落。" items={marketModels.trendMetrics} />

              <div className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
                <InsightChartCard
                  title="类目月度销量趋势"
                  description={`默认展示近12个月，并与上一轮12个月逐月对比。${marketModels.peakMonth ? `峰值月份：${marketModels.peakMonth.year_month}` : ''}`}
                  footer={marketTrendLoading ? '趋势数据加载中...' : '深色代表当前周期，浅色代表上一轮周期，用来看增长是否可持续。'}
                >
                  {marketModels.compareTrendData.length > 0 ? (
                    <ChartContainer config={marketTrendChartConfig} className="h-[360px] w-full">
                      <AreaChart accessibilityLayer data={marketModels.compareTrendData} margin={{ left: 6, right: 6 }}>
                        <defs>
                          <linearGradient id="marketTrendRecentFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="var(--color-recent12)" stopOpacity={0.65} />
                            <stop offset="95%" stopColor="var(--color-recent12)" stopOpacity={0.08} />
                          </linearGradient>
                          <linearGradient id="marketTrendPriorFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="var(--color-prior12)" stopOpacity={0.45} />
                            <stop offset="95%" stopColor="var(--color-prior12)" stopOpacity={0.04} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={20} />
                        <YAxis tickLine={false} axisLine={false} />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              labelFormatter={(_, payload) => {
                                const point = payload?.[0]?.payload as { recentMonth?: string; priorMonth?: string } | undefined
                                return `近12 ${point?.recentMonth ?? '-'} / Last12 ${point?.priorMonth ?? '-'}`
                              }}
                              formatter={(value, name) => (
                                <div className="flex w-full items-center justify-between gap-4">
                                  <span className="text-muted-foreground">{name === 'recent12' ? '近12个月' : 'Last 12个月'}</span>
                                  <span className="font-medium">{formatNumber(Number(value))}</span>
                                </div>
                              )}
                            />
                          }
                        />
                        <Area dataKey="prior12" type="monotone" stroke="var(--color-prior12)" fill="url(#marketTrendPriorFill)" strokeWidth={2} />
                        <Area dataKey="recent12" type="monotone" stroke="var(--color-recent12)" fill="url(#marketTrendRecentFill)" strokeWidth={2.5} />
                      </AreaChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无市场趋势数据" height="h-[360px]" />
                  )}
                </InsightChartCard>

                <InsightChartCard title="季节性 / 增长判断" description="把入场时机最关键的两个问题拆开看：有没有季节窗口，增长是不是还在继续。">
                  <div className="grid gap-3">
                    {marketModels.seasonalityPanels.map((item) => (
                      <div key={item.title} className="rounded-xl border border-border/70 bg-muted/10 p-3">
                        <div className="grid gap-3 md:grid-cols-[180px_1fr] md:items-center">
                          <ChartContainer config={signalPieChartConfig} className="h-[180px] w-full">
                            <PieChart accessibilityLayer>
                              <ChartTooltip
                                content={
                                  <ChartTooltipContent
                                    nameKey="name"
                                    formatter={(value, name) => (
                                      <div className="flex w-full items-center justify-between gap-4">
                                        <span className="text-muted-foreground">{name}</span>
                                        <span className="font-medium">{compactPercentLabel(Number(value))}</span>
                                      </div>
                                    )}
                                  />
                                }
                              />
                              <Pie data={item.pieData} dataKey="value" nameKey="name" innerRadius={44} outerRadius={68} strokeWidth={3}>
                                {item.pieData.map((entry) => (
                                  <Cell key={entry.name} fill={entry.fill} />
                                ))}
                              </Pie>
                            </PieChart>
                          </ChartContainer>
                          <div className="space-y-3">
                            <div>
                              <p className="text-sm font-medium text-foreground">{item.title}</p>
                              <p className="mt-1 text-sm text-muted-foreground">{item.primaryText}</p>
                              <p className="mt-1 text-xs text-muted-foreground">{item.secondaryText}</p>
                            </div>
                            <PieLegendNotes items={item.pieData} />
                            <div className="flex flex-wrap gap-2">
                              {item.thresholds.map((threshold) => (
                                <Badge key={threshold} variant="outline">
                                  {threshold}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </InsightChartCard>
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <InsightChartCard title="上架时间天数分布" description="看这个类目是靠老品统治，还是仍然有新上架产品持续进入。">
                  {marketModels.listingAgeData.length > 0 ? (
                    <ChartContainer config={marketStructureChartConfig} className="h-[280px] w-full">
                      <BarChart accessibilityLayer data={marketModels.listingAgeData}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} />
                        <YAxis tickLine={false} axisLine={false} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="count" fill="var(--color-count)" radius={6} />
                      </BarChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无上架时间分布" />
                  )}
                </InsightChartCard>

                <InsightChartCard title="上架年月趋势" description="看每一批上架产品现在还能拿走多少销量，判断新老批次的生命力。">
                  {marketModels.listingYearMonthData.length > 0 ? (
                    <ChartContainer config={{ count: { label: '上架产品数', color: DASHBOARD_PALETTE.gold }, monthly_sales: { label: '当前月销量', color: DASHBOARD_PALETTE.blue } }} className="h-[280px] w-full">
                      <LineChart accessibilityLayer data={marketModels.listingYearMonthData}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" tickFormatter={formatMonthTick} tickLine={false} axisLine={false} minTickGap={20} />
                        <YAxis yAxisId="left" tickLine={false} axisLine={false} allowDecimals={false} />
                        <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} allowDecimals={false} />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              formatter={(value, name) => (
                                <div className="flex w-full items-center justify-between gap-4">
                                  <span className="text-muted-foreground">{name === 'count' ? '上架产品数' : '当前月销量'}</span>
                                  <span className="font-medium">{formatNumber(Number(value))}</span>
                                </div>
                              )}
                            />
                          }
                        />
                        <Line yAxisId="left" dataKey="count" type="monotone" stroke="var(--color-count)" strokeWidth={2.3} dot={{ r: 3, fill: 'var(--color-count)' }} />
                        <Line yAxisId="right" dataKey="monthly_sales" type="monotone" stroke="var(--color-monthly_sales)" strokeWidth={2.8} dot={false} />
                      </LineChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无上架年月数据" />
                  )}
                </InsightChartCard>
              </div>

              <InsightChartCard title="上架分段表（销量相关）" description="按 launch_date 分批次看销量贡献，直接识别近年新品有没有承接能力。">
                {marketModels.launchSegmentRows.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>上架月份</TableHead>
                        <TableHead className="text-right">产品数</TableHead>
                        <TableHead className="text-right">当前月销量</TableHead>
                        <TableHead className="text-right">销量占比</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {marketModels.launchSegmentRows.map((item) => (
                        <TableRow key={item.label}>
                          <TableCell>{item.label}</TableCell>
                          <TableCell className="text-right">{formatNumber(item.count)}</TableCell>
                          <TableCell className="text-right">{formatNumber(item.monthly_sales)}</TableCell>
                          <TableCell className="text-right">{formatPercent(item.sales_share)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <EmptyChartState message="暂无上架分段数据" />
                )}
              </InsightChartCard>
            </TabsContent>

            <TabsContent value="brand" className="space-y-6">
              <MetricGridCard title="品牌竞争总览" description="先看品牌集中度，再看头部品牌覆盖力和价格带控制力。 " items={brandModels.metrics} />

              <InsightChartCard title="品牌指标说明" description="把 CR / HHI 的公式、阈值和当前值统一放在一起，避免品牌判断只剩一个风险词。">
                <div className="grid gap-3 xl:grid-cols-2">
                  {brandModels.explanationCards.map((item) => (
                    <div key={item.title} className="rounded-xl border border-border/70 bg-muted/10 p-4">
                      <p className="font-medium text-foreground">{item.title}</p>
                      <p className="mt-2 text-xs text-muted-foreground">{item.formula}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {item.thresholds.map((threshold) => (
                          <Badge key={threshold} variant="outline">
                            {threshold}
                          </Badge>
                        ))}
                      </div>
                      <p className="mt-3 text-sm text-muted-foreground">{item.interpretation}</p>
                    </div>
                  ))}
                </div>
              </InsightChartCard>

              <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
                <InsightChartCard title="Top10 品牌销量" description="先认清谁在拿走市场，再决定是否要正面竞争。">
                  {brandModels.top10.length > 0 ? (
                    <ChartContainer config={brandBarChartConfig} className="h-[340px] w-full">
                      <BarChart accessibilityLayer data={brandModels.top10} layout="vertical" margin={{ left: 12, right: 12 }}>
                        <CartesianGrid horizontal={false} />
                        <XAxis type="number" tickLine={false} axisLine={false} />
                        <YAxis type="category" dataKey="brand" width={112} tickLine={false} axisLine={false} />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              formatter={(value, _name, item) => (
                                <div className="flex w-full items-center justify-between gap-4">
                                  <span className="text-muted-foreground">{item.payload.brand}</span>
                                  <span className="font-medium">{formatNumber(Number(value))}</span>
                                </div>
                              )}
                            />
                          }
                        />
                        <Bar dataKey="monthly_sales" fill="var(--color-monthly_sales)" radius={6} />
                      </BarChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无品牌销量数据" height="h-[340px]" />
                  )}
                </InsightChartCard>

                <InsightChartCard title="Top10 vs 其他品牌" description="看头部品牌合计拿走了多少份额，判断市场是不是已经过度集中。">
                  {brandModels.pieData.length > 0 ? (
                    <div className="space-y-4">
                      <ChartContainer config={signalPieChartConfig} className="h-[340px] w-full">
                        <PieChart accessibilityLayer>
                          <ChartTooltip
                            content={
                              <ChartTooltipContent
                                formatter={(value, name) => (
                                  <div className="flex w-full items-center justify-between gap-4">
                                    <span className="text-muted-foreground">{name}</span>
                                    <span className="font-medium">{compactPercentLabel(Number(value))}</span>
                                  </div>
                                )}
                              />
                            }
                          />
                          <Pie data={brandModels.pieData} dataKey="value" nameKey="name" innerRadius={72} outerRadius={108} strokeWidth={4}>
                            {brandModels.pieData.map((item) => (
                              <Cell key={item.name} fill={item.fill} />
                            ))}
                          </Pie>
                        </PieChart>
                      </ChartContainer>
                      <PieLegendNotes items={brandModels.pieData} />
                    </div>
                  ) : (
                    <EmptyChartState message="暂无品牌结构数据" height="h-[340px]" />
                  )}
                </InsightChartCard>
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <InsightChartCard
                  title="Top5 品牌对比雷达"
                  description="比较头部品牌的覆盖能力，不只看销量，还看它们对价格带和产品矩阵的控制力。"
                  footer="雷达按维度做相对归一，不直接展示加权总分；其中“份额”轴已改为 Top5 内相对份额，最大品牌记为 100，避免百分比口径把分数压扁。"
                >
                  {brandModels.radarData.length > 0 ? (
                    <ChartContainer
                      config={brandModels.radarBrands.reduce((acc, brand, index) => {
                        acc[brand] = { label: brand, color: PIE_COLORS[index % PIE_COLORS.length] }
                        return acc
                      }, {} as ChartConfig)}
                      className="h-[320px] w-full"
                    >
                      <RadarChart accessibilityLayer data={brandModels.radarData}>
                        <PolarGrid />
                        <PolarAngleAxis dataKey="metric" />
                        <PolarRadiusAxis tick={false} axisLine={false} />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              labelFormatter={(value) => `指标 ${String(value)}`}
                              formatter={(value, name) => (
                                <div className="flex w-full items-center justify-between gap-4">
                                  <span className="text-muted-foreground">{String(name)}</span>
                                  <span className="font-medium">{Math.round(Number(value))}</span>
                                </div>
                              )}
                            />
                          }
                        />
                        <ChartLegend content={<ChartLegendContent />} />
                        {brandModels.radarBrands.map((brand) => (
                          <Radar key={brand} dataKey={brand} fill={`var(--color-${brand})`} fillOpacity={0.08} stroke={`var(--color-${brand})`} strokeWidth={2} />
                        ))}
                      </RadarChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无品牌雷达数据" height="h-[320px]" />
                  )}
                </InsightChartCard>

                <InsightChartCard title="Top5 品牌价格带覆盖" description="看头部品牌是不是已经把主流价格带铺满。">
                  {brandModels.bandCoverageData.length > 0 && brandBandKeys.length > 0 ? (
                    <ChartContainer
                      config={brandBandKeys.reduce((acc, key, index) => {
                        acc[key] = { label: key, color: PIE_COLORS[index % PIE_COLORS.length] }
                        return acc
                      }, {} as ChartConfig)}
                      className="h-[320px] w-full"
                    >
                      <BarChart accessibilityLayer data={brandModels.bandCoverageData}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} />
                        <YAxis tickLine={false} axisLine={false} tickFormatter={(value) => `${value}%`} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <ChartLegend content={<ChartLegendContent />} />
                        {brandBandKeys.map((key) => (
                          <Bar key={key} dataKey={key} fill={`var(--color-${key})`} radius={4} />
                        ))}
                      </BarChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无价格带覆盖数据" height="h-[320px]" />
                  )}
                </InsightChartCard>
              </div>

              <InsightChartCard title="Top5 品牌价格段表" description="用一张明细表确认头部品牌的产品数、销量和价格覆盖是否一致。">
                <div className="overflow-x-auto rounded-xl border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>品牌</TableHead>
                        <TableHead className="text-right">产品数</TableHead>
                        <TableHead className="text-right">月销量</TableHead>
                        <TableHead className="text-right">价格跨度</TableHead>
                        <TableHead>覆盖价格带</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {brandModels.tableRows.length > 0 ? brandModels.tableRows.map((item) => (
                        <TableRow key={item.brand}>
                          <TableCell>{item.brand}</TableCell>
                          <TableCell className="text-right">{formatNumber(item.product_count)}</TableCell>
                          <TableCell className="text-right">{formatNumber(item.monthly_sales)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(item.price_range.min_price)} - {formatCurrency(item.price_range.max_price)}</TableCell>
                          <TableCell>{item.covered_bands.join(', ') || '-'}</TableCell>
                        </TableRow>
                      )) : (
                        <TableRow>
                          <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">暂无数据</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </InsightChartCard>
            </TabsContent>

            <TabsContent value="seller" className="space-y-6">
              <MetricGridCard title="卖家结构总览" description="把国籍、自营、履约和渠道集中度放在一起，看第三方卖家有没有空间。 " items={sellerModels.metrics} />

              <InsightChartCard title="卖家指标说明" description="统一解释 CR、HHI、中国卖家占比和卖家垄断系数，让卖家结构判断有明确口径。">
                <div className="grid gap-3 xl:grid-cols-3">
                  {sellerModels.explanationCards.map((item) => (
                    <div key={item.title} className="rounded-xl border border-border/70 bg-muted/10 p-4">
                      <p className="font-medium text-foreground">{item.title}</p>
                      <p className="mt-2 text-xs text-muted-foreground">{item.formula}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {item.thresholds.map((threshold) => (
                          <Badge key={threshold} variant="outline">
                            {threshold}
                          </Badge>
                        ))}
                      </div>
                      <p className="mt-3 text-sm text-muted-foreground">{item.interpretation}</p>
                    </div>
                  ))}
                </div>
              </InsightChartCard>

              <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
                <InsightChartCard title="卖家国籍构成" description="先看中国卖家有没有拿走核心销量，再看数量占比是否同步抬升。">
                  {sellerModels.nationalityPieData.length > 0 ? (
                    <div className="space-y-4">
                      <ChartContainer config={signalPieChartConfig} className="h-[300px] w-full">
                        <PieChart accessibilityLayer>
                          <ChartTooltip
                            content={
                              <ChartTooltipContent
                                formatter={(value, name) => (
                                  <div className="flex w-full items-center justify-between gap-4">
                                    <span className="text-muted-foreground">{name}</span>
                                    <span className="font-medium">{compactPercentLabel(Number(value))}</span>
                                  </div>
                                )}
                              />
                            }
                          />
                          <Pie data={sellerModels.nationalityPieData} dataKey="value" nameKey="name" innerRadius={70} outerRadius={106} strokeWidth={4}>
                            {sellerModels.nationalityPieData.map((item) => (
                              <Cell key={item.name} fill={item.fill} />
                            ))}
                          </Pie>
                        </PieChart>
                      </ChartContainer>
                      <PieLegendNotes items={sellerModels.nationalityPieData} />
                    </div>
                  ) : (
                    <EmptyChartState message="暂无卖家国籍数据" height="h-[300px]" />
                  )}
                </InsightChartCard>

                <InsightChartCard title="销量占比 vs 数量占比" description="识别哪类卖家用更少数量拿走更多销量，判断竞争效率。">
                  {sellerModels.nationalityBarData.length > 0 ? (
                    <ChartContainer config={sellerShareChartConfig} className="h-[300px] w-full">
                      <BarChart accessibilityLayer data={sellerModels.nationalityBarData}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} />
                        <YAxis tickLine={false} axisLine={false} tickFormatter={(value) => `${value}%`} />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              formatter={(value) => <span className="font-medium">{compactPercentLabel(Number(value))}</span>}
                            />
                          }
                        />
                        <ChartLegend content={<ChartLegendContent />} />
                        <Bar dataKey="sales_share_pct" fill="var(--color-sales_share_pct)" radius={6} />
                        <Bar dataKey="count_share_pct" fill="var(--color-count_share_pct)" radius={6} />
                      </BarChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无卖家占比数据" height="h-[300px]" />
                  )}
                </InsightChartCard>
              </div>

              <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
                <InsightChartCard title="卖家结构仪表" description="用三项快读指标先判断履约、自营和国别竞争压力。">
                  <div className="grid gap-3 md:grid-cols-3">
                    {sellerModels.radialData.map((item, index) => (
                      <SingleRadialGauge key={item.label} title={item.label} value={item.value} text={item.text} color={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </div>
                </InsightChartCard>

                <InsightChartCard
                  title="卖家结构画像雷达"
                  description="把集中度、履约和非自营空间放进一张雷达，看这个类目更偏渠道竞争还是运营竞争。"
                  footer="已做反向处理: 自营占比越低，雷达分越高，代表第三方卖家可进入空间更大。自营识别来自 bbx_seller_attribute 命中“亚马逊自营”。"
                >
                  {sellerModels.radarData.length > 0 ? (
                    <ChartContainer config={sellerShareChartConfig} className="h-[320px] w-full">
                      <RadarChart accessibilityLayer data={sellerModels.radarData}>
                        <PolarGrid />
                        <PolarAngleAxis dataKey="metric" />
                        <PolarRadiusAxis tick={false} axisLine={false} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Radar dataKey="value" fill="var(--color-value)" fillOpacity={0.22} stroke="var(--color-value)" strokeWidth={2} />
                      </RadarChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无卖家结构雷达数据" height="h-[320px]" />
                  )}
                </InsightChartCard>
              </div>

              <InsightChartCard title="物流方式分布" description="确认主流履约方式，判断进入后更像供应链竞争还是内容竞争。">
                {sellerModels.fulfillmentData.length > 0 ? (
                  <ChartContainer config={sellerShareChartConfig} className="h-[280px] w-full">
                    <BarChart accessibilityLayer data={sellerModels.fulfillmentData}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} />
                      <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="count" fill="var(--color-count)" radius={6} />
                    </BarChart>
                  </ChartContainer>
                ) : (
                  <EmptyChartState message="暂无物流方式数据" />
                )}
              </InsightChartCard>
            </TabsContent>

            <TabsContent value="review" className="space-y-6">
              <MetricGridCard title="评论门槛总览" description="重点回答两个问题：评论门槛高不高，低评论产品还有没有拿量机会。 " items={reviewModels.metrics} />

              <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
                <InsightChartCard title="评分星级分布" description="看高评分是不是已经高度集中，避免只看到评论数看不到口碑结构。">
                  {reviewModels.ratingDistribution.length > 0 ? (
                    <ChartContainer config={reviewChartConfig} className="h-[300px] w-full">
                      <BarChart accessibilityLayer data={reviewModels.ratingDistribution}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} />
                        <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="count" fill="var(--color-count)" radius={6} />
                      </BarChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无评分分布数据" height="h-[300px]" />
                  )}
                </InsightChartCard>

                <InsightChartCard title="低评价产品占比" description="看低评论层样本是不是还占了足够空间，判断冷启动机会。">
                  {reviewModels.lowReviewPieData.length > 0 ? (
                    <div className="space-y-4">
                      <ChartContainer config={signalPieChartConfig} className="h-[300px] w-full">
                        <PieChart accessibilityLayer>
                          <ChartTooltip
                            content={
                              <ChartTooltipContent
                                formatter={(value, name) => (
                                  <div className="flex w-full items-center justify-between gap-4">
                                    <span className="text-muted-foreground">{name}</span>
                                    <span className="font-medium">{compactPercentLabel(Number(value))}</span>
                                  </div>
                                )}
                              />
                            }
                          />
                          <Pie data={reviewModels.lowReviewPieData} dataKey="value" nameKey="name" innerRadius={72} outerRadius={106} strokeWidth={4}>
                            {reviewModels.lowReviewPieData.map((item) => (
                              <Cell key={item.name} fill={item.fill} />
                            ))}
                          </Pie>
                        </PieChart>
                      </ChartContainer>
                      <PieLegendNotes items={reviewModels.lowReviewPieData} />
                    </div>
                  ) : (
                    <EmptyChartState message="暂无低评价占比数据" height="h-[300px]" />
                  )}
                </InsightChartCard>
              </div>

              <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                <InsightChartCard title="评价数量段累计销量占比" description="看销量是不是被高评论段快速吃掉，判断后发进入难度。">
                  {reviewModels.cumulativeShareData.length > 0 ? (
                    <ChartContainer config={reviewChartConfig} className="h-[320px] w-full">
                      <AreaChart accessibilityLayer data={reviewModels.cumulativeShareData}>
                        <defs>
                          <linearGradient id="reviewShareFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="var(--color-cumulative_share_pct)" stopOpacity={0.7} />
                            <stop offset="95%" stopColor="var(--color-cumulative_share_pct)" stopOpacity={0.08} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} />
                        <YAxis tickLine={false} axisLine={false} tickFormatter={(value) => `${value}%`} />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              formatter={(value, name, item) => (
                                <div className="space-y-1">
                                  <div className="flex items-center justify-between gap-4">
                                    <span className="text-muted-foreground">{String(name)}</span>
                                    <span className="font-medium">{compactPercentLabel(Number(value))}</span>
                                  </div>
                                  <div className="text-xs text-muted-foreground">销量 {formatNumber(item.payload.monthly_sales)}</div>
                                </div>
                              )}
                            />
                          }
                        />
                        <Area dataKey="cumulative_share_pct" type="monotone" stroke="var(--color-cumulative_share_pct)" fill="url(#reviewShareFill)" strokeWidth={2.5} />
                      </AreaChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无评论段销量数据" height="h-[320px]" />
                  )}
                </InsightChartCard>

                <InsightChartCard title="评论门槛仪表" description="把评论门槛压成四个快读指标，先判断进入阻力。">
                  <div className="grid gap-3 md:grid-cols-2">
                    {reviewModels.radialData.map((item, index) => (
                      <SingleRadialGauge key={item.label} title={item.label} value={item.value} text={item.text} color={PIE_COLORS[(index + 1) % PIE_COLORS.length]} />
                    ))}
                  </div>
                </InsightChartCard>
              </div>

              <InsightChartCard title="评价数量段明细" description="把评论段、产品数和销量放在一张表里，便于确认壁垒具体落在哪一层。">
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {reviewModels.methodologyNotes.map((item) => (
                      <Badge key={item} variant="outline">
                        {item}
                      </Badge>
                    ))}
                  </div>
                  <div className="overflow-x-auto rounded-xl border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>阶段</TableHead>
                        <TableHead>评价数量段</TableHead>
                        <TableHead className="text-right">产品数</TableHead>
                        <TableHead className="text-right">销量</TableHead>
                        <TableHead className="text-right">累计销量占比</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {reviewModels.detailRows.length > 0 ? reviewModels.detailRows.map((item) => (
                        <TableRow key={item.label}>
                          <TableCell>{item.stage}</TableCell>
                          <TableCell>{item.label}</TableCell>
                          <TableCell className="text-right">{formatNumber(item.count)}</TableCell>
                          <TableCell className="text-right">{formatNumber(item.monthly_sales)}</TableCell>
                          <TableCell className="text-right">{compactPercentLabel(item.cumulative_share_pct)}</TableCell>
                        </TableRow>
                      )) : (
                        <TableRow>
                          <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">暂无数据</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                </div>
              </InsightChartCard>
            </TabsContent>

            <TabsContent value="price" className="space-y-6">
              <MetricGridCard title="价格结构总览" description="先看主力价格带，再看价格和销量到底是强绑定还是弱绑定。 " items={priceModels.metrics} />

              <InsightChartCard title="精细价格带方法" description="先把分段方法讲清楚，再看价格图，避免误把粗断点当市场结构。">
                <div className="flex flex-wrap gap-2">
                  {priceModels.methodologyNotes.map((item) => (
                    <Badge key={item} variant="outline">
                      {item}
                    </Badge>
                  ))}
                </div>
              </InsightChartCard>

              <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
                <InsightChartCard title="价格区间销量" description="先找主战场价格带，判断销量到底集中在哪些价位。">
                  {priceModels.largeBandData.length > 0 ? (
                    <ChartContainer config={priceChartConfig} className="h-[300px] w-full">
                      <BarChart accessibilityLayer data={priceModels.largeBandData}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} />
                        <YAxis tickLine={false} axisLine={false} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="monthly_sales" fill="var(--color-monthly_sales)" radius={6} />
                      </BarChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无大价格区间数据" height="h-[300px]" />
                  )}
                </InsightChartCard>

                <InsightChartCard title="价格带样本占比" description="看样本密度是不是和销量密度一致，避免误判虚高价格带。">
                  {priceModels.pieData.length > 0 ? (
                    <div className="space-y-4">
                      <ChartContainer config={signalPieChartConfig} className="h-[300px] w-full">
                        <PieChart accessibilityLayer>
                          <ChartTooltip
                            content={
                              <ChartTooltipContent
                                formatter={(value, name) => (
                                  <div className="flex w-full items-center justify-between gap-4">
                                    <span className="text-muted-foreground">{name}</span>
                                    <span className="font-medium">{compactPercentLabel(Number(value))}</span>
                                  </div>
                                )}
                              />
                            }
                          />
                          <Pie data={priceModels.pieData} dataKey="value" nameKey="name" innerRadius={72} outerRadius={106} strokeWidth={4}>
                            {priceModels.pieData.map((item) => (
                              <Cell key={item.name} fill={item.fill} />
                            ))}
                          </Pie>
                        </PieChart>
                      </ChartContainer>
                      <PieLegendNotes items={priceModels.pieData} />
                    </div>
                  ) : (
                    <EmptyChartState message="暂无价格带样本占比数据" height="h-[300px]" />
                  )}
                </InsightChartCard>
              </div>

              <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                <InsightChartCard title="价格区间销量趋势" description="看价格带之间的销量迁移，判断消费者是否只认少数价位。">
                  {priceModels.smallBandData.length > 0 ? (
                    <ChartContainer config={priceChartConfig} className="h-[320px] w-full">
                      <LineChart accessibilityLayer data={priceModels.smallBandData}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={18} />
                        <YAxis tickLine={false} axisLine={false} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Line dataKey="monthly_sales" type="monotone" stroke="var(--color-monthly_sales)" strokeWidth={2.5} dot={{ r: 3, fill: 'var(--color-monthly_sales)' }} />
                      </LineChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无小价格区间趋势" height="h-[320px]" />
                  )}
                </InsightChartCard>

                <InsightChartCard title="价格结构雷达" description="把价格层级、离散度和价格相关得分压缩成一张图，看价格是不是决定性因素。">
                  {priceModels.radarData.length > 0 ? (
                    <ChartContainer config={priceChartConfig} className="h-[320px] w-full">
                      <RadarChart accessibilityLayer data={priceModels.radarData}>
                        <PolarGrid />
                        <PolarAngleAxis dataKey="metric" />
                        <PolarRadiusAxis tick={false} axisLine={false} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Radar dataKey="value" fill="var(--color-value)" fillOpacity={0.22} stroke="var(--color-value)" strokeWidth={2} />
                      </RadarChart>
                    </ChartContainer>
                  ) : (
                    <EmptyChartState message="暂无价格雷达数据" height="h-[320px]" />
                  )}
                </InsightChartCard>
              </div>

              <InsightChartCard title="价格 vs 月销量散点图" description="直接看价格和销量的真实分布，识别有没有异常拥挤或空白价位。">
                {priceModels.scatterData.length > 0 ? (
                  <ChartContainer config={priceChartConfig} className="h-[340px] w-full">
                    <ScatterChart accessibilityLayer margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
                      <CartesianGrid />
                      <XAxis dataKey="price_usd" name="价格" type="number" tickLine={false} axisLine={false} tickFormatter={(value) => `$${value}`} />
                      <YAxis dataKey="monthly_sales" name="月销量" type="number" tickLine={false} axisLine={false} />
                      <ChartTooltip
                        cursor={{ strokeDasharray: '4 4' }}
                        content={
                          <ChartTooltipContent
                            formatter={(_value, _name, item) => (
                              <div className="space-y-1">
                                <div className="font-medium">{item.payload.asin}</div>
                                <div className="flex items-center justify-between gap-4">
                                  <span className="text-muted-foreground">价格</span>
                                  <span className="font-medium">{formatCurrency(item.payload.price_usd)}</span>
                                </div>
                                <div className="flex items-center justify-between gap-4">
                                  <span className="text-muted-foreground">月销量</span>
                                  <span className="font-medium">{formatNumber(item.payload.monthly_sales)}</span>
                                </div>
                              </div>
                            )}
                          />
                        }
                      />
                      <Scatter data={priceModels.scatterData} fill="var(--color-monthly_sales)" />
                    </ScatterChart>
                  </ChartContainer>
                ) : (
                  <EmptyChartState message="暂无散点数据" height="h-[340px]" />
                )}
              </InsightChartCard>

              <InsightChartCard title="价格带明细" description="把精细价格带的样本数和销量放在一张表里，方便做落点验证。">
                <div className="overflow-x-auto rounded-xl border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>分组</TableHead>
                        <TableHead>价格区间</TableHead>
                        <TableHead className="text-right">销量</TableHead>
                        <TableHead className="text-right">样本数</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {priceModels.detailRows.length > 0 ? priceModels.detailRows.map((item) => (
                        <TableRow key={`${item.group}-${item.label}`}>
                          <TableCell>{item.group}</TableCell>
                          <TableCell>{item.label}</TableCell>
                          <TableCell className="text-right">{formatNumber(item.monthly_sales)}</TableCell>
                          <TableCell className="text-right">{formatNumber(item.count)}</TableCell>
                        </TableRow>
                      )) : (
                        <TableRow>
                          <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">暂无数据</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </InsightChartCard>
            </TabsContent>
          </Tabs>
        ) : (
          <Card className="border-dashed">
            <CardContent className="flex h-48 flex-col items-center justify-center gap-2 text-center">
              <Lightbulb className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">请先在上方分析工作台选择关键词和版本，或在“调研”标签页先上传生成调研版本。</p>
            </CardContent>
          </Card>
        )}
      </TabsContent>
    </Tabs>
  )
}
