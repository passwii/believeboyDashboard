/**
 * 广告原始数据查看器 —— 纯函数与配置（可单测）。
 *
 * 数据来源：后端 `/external/projects/{id}/ad-{endpoint}-raw` 接口，返回
 * `Ad*RawRow`（已解析的英文 typed 字段）。本文件负责：
 *   1. 10 种报表类型的列配置（字段 -> 中文列名 -> 格式化方式）+ 聚合分组键。
 *   2. 最小可读化的数值格式化（% / 金额 / 整数）。
 *   3. 前端聚合：按分组键归并明细行，加总可加指标、重算比率、拼接周期。
 *   4. CSV 导出构造。
 *
 * 设计原则：只做"最小可读化 + 初步聚合"，不引入任何分析/分级/建议逻辑。
 */

export type AdDataFormat = 'text' | 'int' | 'money' | 'percent' | 'ratio' | 'date'

export type AdDataColumn = {
  /** Ad*RawRow 上的字段名（也是排序/取值 key） */
  key: string
  /** 中文列名 */
  label: string
  format: AdDataFormat
}

export type AdDataReportType = {
  /** 后端 report_type，如 'ad_campaign_report' */
  reportType: string
  /** 选择器 / 导航显示名 */
  label: string
  /** 接口路径段：'campaigns' -> /ad-campaigns-raw */
  endpoint: string
  /** 聚合时的分组维度（自然业务键） */
  groupBy: string[]
  columns: AdDataColumn[]
}

const DATE_COLS: AdDataColumn[] = [
  { key: 'report_start_date', label: '报告开始日期', format: 'date' },
  { key: 'report_end_date', label: '报告结束日期', format: 'date' },
]

export const AD_DATA_REPORT_TYPES: AdDataReportType[] = [
  {
    reportType: 'ad_campaign_report',
    label: '广告活动',
    endpoint: 'campaigns',
    groupBy: ['campaign_name'],
    columns: [
      ...DATE_COLS,
      { key: 'campaign_name', label: '广告活动名称', format: 'text' },
      { key: 'portfolio_name', label: '投资组合', format: 'text' },
      { key: 'campaign_type', label: '广告活动类型', format: 'text' },
      { key: 'targeting_type', label: '定位类型', format: 'text' },
      { key: 'bidding_strategy', label: '竞价策略', format: 'text' },
      { key: 'status', label: '状态', format: 'text' },
      { key: 'budget', label: '预算', format: 'money' },
      { key: 'impressions', label: '展示量', format: 'int' },
      { key: 'clicks', label: '点击量', format: 'int' },
      { key: 'ctr', label: '点击率 CTR', format: 'percent' },
      { key: 'spend', label: '花费', format: 'money' },
      { key: 'cpc', label: '单次点击成本 CPC', format: 'money' },
      { key: 'orders_7d', label: '7天订单数', format: 'int' },
      { key: 'sales_7d', label: '7天销售额', format: 'money' },
      { key: 'acos', label: 'ACOS', format: 'percent' },
      { key: 'roas', label: 'ROAS', format: 'ratio' },
    ],
  },
  {
    reportType: 'ad_budget_report',
    label: '预算',
    endpoint: 'budgets',
    groupBy: ['campaign_name'],
    columns: [
      ...DATE_COLS,
      { key: 'campaign_name', label: '广告活动名称', format: 'text' },
      { key: 'status', label: '状态', format: 'text' },
      { key: 'budget', label: '当前预算', format: 'money' },
      { key: 'suggested_budget', label: '建议预算', format: 'money' },
      { key: 'budget_utilization_rate', label: '预算利用率', format: 'percent' },
      { key: 'missed_impressions_min', label: '预计错失展示(最小)', format: 'int' },
      { key: 'missed_impressions_max', label: '预计错失展示(最大)', format: 'int' },
      { key: 'missed_clicks_min', label: '预计错失点击(最小)', format: 'int' },
      { key: 'missed_clicks_max', label: '预计错失点击(最大)', format: 'int' },
      { key: 'missed_sales_min', label: '预计错失销售(最小)', format: 'money' },
      { key: 'missed_sales_max', label: '预计错失销售(最大)', format: 'money' },
      { key: 'spend', label: '花费', format: 'money' },
      { key: 'sales_7d', label: '7天销售额', format: 'money' },
      { key: 'orders_7d', label: '7天订单数', format: 'int' },
      { key: 'acos', label: 'ACOS', format: 'percent' },
    ],
  },
  {
    reportType: 'ad_target_report',
    label: '搜索词投放',
    endpoint: 'targets',
    groupBy: ['target_text'],
    columns: [
      ...DATE_COLS,
      { key: 'campaign_name', label: '广告活动名称', format: 'text' },
      { key: 'ad_group_name', label: '广告组名称', format: 'text' },
      { key: 'target_text', label: '投放', format: 'text' },
      { key: 'match_type', label: '匹配类型', format: 'text' },
      { key: 'impressions', label: '展示量', format: 'int' },
      { key: 'top_of_search_impression_share', label: '首页首位展示量份额', format: 'percent' },
      { key: 'clicks', label: '点击量', format: 'int' },
      { key: 'ctr', label: '点击率 CTR', format: 'percent' },
      { key: 'cpc', label: '单次点击成本 CPC', format: 'money' },
      { key: 'spend', label: '花费', format: 'money' },
      { key: 'sales_7d', label: '7天销售额', format: 'money' },
      { key: 'orders_7d', label: '7天订单数', format: 'int' },
      { key: 'units_7d', label: '7天单位数', format: 'int' },
      { key: 'acos', label: 'ACOS', format: 'percent' },
      { key: 'roas', label: 'ROAS', format: 'ratio' },
      { key: 'cvr_7d', label: '7天转化率', format: 'percent' },
    ],
  },
  {
    reportType: 'ad_placement_report',
    label: '广告位',
    endpoint: 'placements',
    groupBy: ['placement'],
    columns: [
      ...DATE_COLS,
      { key: 'campaign_name', label: '广告活动名称', format: 'text' },
      { key: 'placement', label: '广告位', format: 'text' },
      { key: 'bidding_strategy', label: '竞价策略', format: 'text' },
      { key: 'impressions', label: '展示量', format: 'int' },
      { key: 'clicks', label: '点击量', format: 'int' },
      { key: 'spend', label: '花费', format: 'money' },
      { key: 'cpc', label: '单次点击成本 CPC', format: 'money' },
      { key: 'sales_7d', label: '7天销售额', format: 'money' },
      { key: 'orders_7d', label: '7天订单数', format: 'int' },
      { key: 'units_7d', label: '7天单位数', format: 'int' },
      { key: 'acos', label: 'ACOS', format: 'percent' },
      { key: 'roas', label: 'ROAS', format: 'ratio' },
    ],
  },
  {
    reportType: 'ad_search_term_report',
    label: '搜索词',
    endpoint: 'search-terms',
    groupBy: ['search_term'],
    columns: [
      ...DATE_COLS,
      { key: 'campaign_name', label: '广告活动名称', format: 'text' },
      { key: 'ad_group_name', label: '广告组名称', format: 'text' },
      { key: 'match_type', label: '匹配类型', format: 'text' },
      { key: 'search_term', label: '客户搜索词', format: 'text' },
      { key: 'targeting_type', label: '定位类型', format: 'text' },
      { key: 'impressions', label: '展示量', format: 'int' },
      { key: 'clicks', label: '点击量', format: 'int' },
      { key: 'ctr', label: '点击率 CTR', format: 'percent' },
      { key: 'spend', label: '花费', format: 'money' },
      { key: 'cpc', label: '单次点击成本 CPC', format: 'money' },
      { key: 'orders_7d', label: '7天订单数', format: 'int' },
      { key: 'sales_7d', label: '7天销售额', format: 'money' },
      { key: 'acos', label: 'ACOS', format: 'percent' },
      { key: 'roas', label: 'ROAS', format: 'ratio' },
      { key: 'cvr_7d', label: '7天转化率', format: 'percent' },
    ],
  },
  {
    reportType: 'ad_search_term_share_report',
    label: '搜索词展示量份额',
    endpoint: 'search-term-shares',
    groupBy: ['search_term'],
    columns: [
      ...DATE_COLS,
      { key: 'search_term', label: '客户搜索词', format: 'text' },
      { key: 'impression_rank', label: '展示量排名', format: 'int' },
      { key: 'impression_share', label: '展示量份额', format: 'percent' },
      { key: 'target_text', label: '投放', format: 'text' },
      { key: 'match_type', label: '匹配类型', format: 'text' },
      { key: 'campaign_name', label: '广告活动名称', format: 'text' },
      { key: 'ad_group_name', label: '广告组名称', format: 'text' },
      { key: 'clicks', label: '点击量', format: 'int' },
      { key: 'impressions', label: '展示量', format: 'int' },
      { key: 'ctr', label: '点击率 CTR', format: 'percent' },
      { key: 'spend', label: '花费', format: 'money' },
      { key: 'cpc', label: '单次点击成本 CPC', format: 'money' },
      { key: 'orders_7d', label: '7天订单数', format: 'int' },
      { key: 'sales_7d', label: '7天销售额', format: 'money' },
      { key: 'acos', label: 'ACOS', format: 'percent' },
      { key: 'roas', label: 'ROAS', format: 'ratio' },
      { key: 'cvr_7d', label: '7天转化率', format: 'percent' },
    ],
  },
  {
    reportType: 'ad_promoted_product_report',
    label: '推广的商品',
    endpoint: 'promoted-products',
    groupBy: ['ad_sku'],
    columns: [
      ...DATE_COLS,
      { key: 'campaign_name', label: '广告活动名称', format: 'text' },
      { key: 'ad_group_name', label: '广告组名称', format: 'text' },
      { key: 'ad_sku', label: '广告SKU', format: 'text' },
      { key: 'ad_asin', label: '广告ASIN', format: 'text' },
      { key: 'impressions', label: '展示量', format: 'int' },
      { key: 'clicks', label: '点击量', format: 'int' },
      { key: 'ctr', label: '点击率 CTR', format: 'percent' },
      { key: 'spend', label: '花费', format: 'money' },
      { key: 'cpc', label: '单次点击成本 CPC', format: 'money' },
      { key: 'orders_7d', label: '7天订单数', format: 'int' },
      { key: 'units_7d', label: '7天单位数', format: 'int' },
      { key: 'sales_7d', label: '7天销售额', format: 'money' },
      { key: 'acos', label: 'ACOS', format: 'percent' },
      { key: 'roas', label: 'ROAS', format: 'ratio' },
      { key: 'cvr_7d', label: '7天转化率', format: 'percent' },
      { key: 'ad_sku_units_7d', label: '广告SKU 7天单位数', format: 'int' },
      { key: 'other_sku_units_7d', label: '其他SKU 7天单位数', format: 'int' },
      { key: 'ad_sku_sales_7d', label: '广告SKU 7天销售额', format: 'money' },
      { key: 'other_sku_sales_7d', label: '其他SKU 7天销售额', format: 'money' },
      { key: 'scope_status', label: '范围状态', format: 'text' },
    ],
  },
  {
    reportType: 'ad_time_trend_report',
    label: '按时间查看效果',
    endpoint: 'time-trends',
    groupBy: ['report_end_date'],
    columns: [
      ...DATE_COLS,
      { key: 'country', label: '国家/地区', format: 'text' },
      { key: 'currency', label: '货币', format: 'text' },
      { key: 'clicks', label: '点击量', format: 'int' },
      { key: 'cpc', label: '单次点击成本 CPC', format: 'money' },
      { key: 'spend', label: '花费', format: 'money' },
    ],
  },
  {
    reportType: 'ad_invalid_traffic_report',
    label: '总流量和无效流量',
    endpoint: 'invalid-traffic',
    groupBy: ['campaign_name'],
    columns: [
      ...DATE_COLS,
      { key: 'campaign_name', label: '广告活动名称', format: 'text' },
      { key: 'status', label: '状态', format: 'text' },
      { key: 'total_impressions', label: '总展示量', format: 'int' },
      { key: 'valid_impressions', label: '有效展示量', format: 'int' },
      { key: 'invalid_impressions', label: '无效展示量', format: 'int' },
      { key: 'invalid_impression_rate', label: '无效展示率', format: 'percent' },
      { key: 'total_clicks', label: '总点击量', format: 'int' },
      { key: 'valid_clicks', label: '有效点击量', format: 'int' },
      { key: 'invalid_clicks', label: '无效点击量', format: 'int' },
      { key: 'invalid_click_rate', label: '无效点击率', format: 'percent' },
    ],
  },
  {
    reportType: 'ad_purchased_product_report',
    label: '已购买商品',
    endpoint: 'purchased-products',
    groupBy: ['purchased_asin'],
    columns: [
      ...DATE_COLS,
      { key: 'campaign_name', label: '广告活动名称', format: 'text' },
      { key: 'ad_group_name', label: '广告组名称', format: 'text' },
      { key: 'ad_sku', label: '广告SKU', format: 'text' },
      { key: 'ad_asin', label: '广告ASIN', format: 'text' },
      { key: 'target_text', label: '投放', format: 'text' },
      { key: 'match_type', label: '匹配类型', format: 'text' },
      { key: 'purchased_asin', label: '已购买ASIN', format: 'text' },
      { key: 'other_sku_units_7d', label: '其他SKU 7天单位数', format: 'int' },
      { key: 'other_sku_orders_7d', label: '其他SKU 7天订单数', format: 'int' },
      { key: 'other_sku_sales_7d', label: '其他SKU 7天销售额', format: 'money' },
    ],
  },
]

export function getAdDataReportType(reportType: string): AdDataReportType | undefined {
  return AD_DATA_REPORT_TYPES.find((item) => item.reportType === reportType)
}

/** 最小可读化：把原始数值转成展示字符串。空值返回 '-'。 */
export function formatAdDataValue(value: unknown, format: AdDataFormat): string {
  if (value === null || value === undefined || value === '') return '-'
  switch (format) {
    case 'int':
      return Number(value).toLocaleString()
    case 'money':
      return (
        '$' +
        Number(value).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
      )
    case 'percent':
      return (Number(value) * 100).toFixed(2) + '%'
    case 'ratio':
      return Number(value).toFixed(2)
    case 'date':
      return String(value)
    case 'text':
    default:
      return String(value)
  }
}

/** 可跨时间正确加总的指标 key（曝光/点击/花费/销售/订单/单位等）。 */
const ADDITIVE_KEYS = new Set<string>([
  'impressions',
  'clicks',
  'spend',
  'sales_7d',
  'orders_7d',
  'units_7d',
  'ad_sku_units_7d',
  'other_sku_units_7d',
  'ad_sku_sales_7d',
  'other_sku_sales_7d',
  'total_impressions',
  'valid_impressions',
  'invalid_impressions',
  'total_clicks',
  'valid_clicks',
  'invalid_clicks',
])

/** 需要从加总后的基数重算的比率（避免把比率直接相加）。 */
const RATIO_FORMULAS: Record<string, (s: Record<string, number>) => number> = {
  ctr: (s) => (s.impressions > 0 ? s.clicks / s.impressions : 0),
  cpc: (s) => (s.clicks > 0 ? s.spend / s.clicks : 0),
  acos: (s) => (s.sales_7d > 0 ? s.spend / s.sales_7d : 0),
  roas: (s) => (s.spend > 0 ? s.sales_7d / s.spend : 0),
  cvr_7d: (s) => (s.clicks > 0 ? s.orders_7d / s.clicks : 0),
  invalid_impression_rate: (s) =>
    s.total_impressions > 0 ? s.invalid_impressions / s.total_impressions : 0,
  invalid_click_rate: (s) => (s.total_clicks > 0 ? s.invalid_clicks / s.total_clicks : 0),
}

const RATIO_FORMULA_KEYS = new Set(Object.keys(RATIO_FORMULAS))

/** 聚合视图展示的列：分组键 + 周期 + 可加指标 + 重算比率（其余列隐藏）。 */
export function getAggregateColumns(config: AdDataReportType): AdDataColumn[] {
  return config.columns.filter(
    (col) =>
      col.key === 'report_start_date' ||
      col.key === 'report_end_date' ||
      config.groupBy.includes(col.key) ||
      ADDITIVE_KEYS.has(col.key) ||
      RATIO_FORMULA_KEYS.has(col.key)
  )
}

type AggBucket = {
  values: Record<string, unknown>
  sums: Record<string, number>
  minStart: string
  maxEnd: string
}

/**
 * 前端聚合：把明细行按 groupBy 归并。
 *  - 可加指标求和；比率从加总基数重算；周期取 [min(开始), max(结束)]（拼接）。
 *  - 非可加/非重算列（预算、排名、份额等）不在聚合视图出现。
 */
export function aggregateAdDataRows(
  rows: Record<string, unknown>[],
  config: AdDataReportType
): Record<string, unknown>[] {
  const groupKeys = config.groupBy
  const buckets = new Map<string, AggBucket>()

  for (const row of rows) {
    const gk = groupKeys.map((k) => String(row[k] ?? '')).join(' ')
    let bucket = buckets.get(gk)
    if (!bucket) {
      bucket = { values: {}, sums: {}, minStart: '', maxEnd: '' }
      buckets.set(gk, bucket)
    }
    groupKeys.forEach((k) => {
      bucket!.values[k] = row[k]
    })
    for (const key of ADDITIVE_KEYS) {
      const v = row[key]
      if (v !== undefined && v !== null && v !== '') {
        bucket!.sums[key] = (bucket!.sums[key] ?? 0) + Number(v)
      }
    }
    const s = String(row.report_start_date ?? '')
    const e = String(row.report_end_date ?? '')
    if (s && (bucket!.minStart === '' || s < bucket!.minStart)) bucket!.minStart = s
    if (e && (bucket!.maxEnd === '' || e > bucket!.maxEnd)) bucket!.maxEnd = e
  }

  const out: Record<string, unknown>[] = []
  for (const bucket of buckets.values()) {
    const agg: Record<string, unknown> = {
      report_start_date: bucket.minStart,
      report_end_date: bucket.maxEnd,
    }
    groupKeys.forEach((k) => {
      agg[k] = bucket.values[k]
    })
    for (const key of ADDITIVE_KEYS) {
      if (config.columns.some((c) => c.key === key)) {
        agg[key] = bucket.sums[key] ?? 0
      }
    }
    for (const key of RATIO_FORMULA_KEYS) {
      if (config.columns.some((c) => c.key === key)) {
        agg[key] = RATIO_FORMULAS[key](bucket.sums)
      }
    }
    out.push(agg)
  }
  return out
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"'
  }
  return value
}

/** 把（已筛选/排序后的）行构造成 CSV 文本，列头用中文 label。 */
export function buildAdDataCsv(rows: Record<string, unknown>[], columns: AdDataColumn[]): string {
  const header = columns.map((col) => escapeCsvCell(col.label)).join(',')
  const body = rows
    .map((row) =>
      columns.map((col) => escapeCsvCell(formatAdDataValue(row[col.key], col.format))).join(',')
    )
    .join('\n')
  return header + '\n' + body
}

/** 判断某格式是否按数值排序（其余按字符串排序）。 */
export function isNumericFormat(format: AdDataFormat): boolean {
  return format !== 'text' && format !== 'date'
}
