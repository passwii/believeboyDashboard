/**
 * 广告原始数据查看器 —— 纯函数与配置（可单测）。
 *
 * 数据来源：后端 `/external/projects/{id}/ad-{endpoint}-raw` 接口，返回
 * `Ad*RawRow`（已解析的英文 typed 字段）。本文件负责：
 *   1. 10 种报表类型的列配置（字段 -> 中文列名 -> 格式化方式）。
 *   2. 最小可读化的数值格式化（% / 金额 / 整数）。
 *   3. CSV 导出构造。
 *
 * 设计原则：只做"最小可读化"，不引入任何分析/分级/建议逻辑。
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

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"'
  }
  return value
}

/** 把（已筛选/排序后的）行构造成 CSV 文本，列头用中文 label。 */
export function buildAdDataCsv(
  rows: Record<string, unknown>[],
  columns: AdDataColumn[],
): string {
  const header = columns.map((col) => escapeCsvCell(col.label)).join(',')
  const body = rows
    .map((row) =>
      columns
        .map((col) => escapeCsvCell(formatAdDataValue(row[col.key], col.format)))
        .join(','),
    )
    .join('\n')
  return header + '\n' + body
}

/** 判断某格式是否按数值排序（其余按字符串排序）。 */
export function isNumericFormat(format: AdDataFormat): boolean {
  return format !== 'text' && format !== 'date'
}
