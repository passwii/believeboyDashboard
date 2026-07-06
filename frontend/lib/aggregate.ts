/**
 * Aggregation utilities for daily-analysis data.
 *
 * 当用户在日期选择器里选了「本年度至今」等跨度超过 90 天的范围时，
 * 把按天返回的销售数据按月汇总，让图表 / 表格的 X 轴在月维度上更可读。
 *
 * 设计要点：
 *  1. **sum-then-divide** —— 对 cpc / conversion_rate 这类比率字段，必须先把
 *     分子分母按月累加再算比率，不能对每天的值取平均（沿用页面 `aggregateMetric`
 *     在 daily-analysis/page.tsx 第 411-426 行的语义）。
 *  2. **available_qty / ordered_sales_amount 取月末快照** —— 这两个字段是「当日
 *     快照值」而非日累加，按月汇总时取同月最后一条的值，避免把库存计数相加
 *     产生无意义的数字。
 *  3. **date 统一为 YYYY-MM-01** —— 下游 chart / 表头可按 `.slice(0, 7)` 拿到
 *     `YYYY-MM` 用于显示，按完整字符串则可作为 React key。
 */

/** 与 daily-analysis 的 DailyAnalysisRow 同构，但 date 改为 'YYYY-MM-01'。 */
export interface DailySummaryBucket {
  date: string
  order_qty: number
  sales_amount: number
  impressions: number
  clicks: number
  /** 月内总广告花费 / 月内总点击；分母为 0 时为 0。 */
  cpc: number
  ad_spend: number
  ad_orders: number
  /** 月末最后一天的快照值。 */
  available_qty: number
  page_views: number
  units_ordered: number
  sessions: number
  /** 月内总销量 / 月内总页面浏览；分母为 0 时为 0。 */
  conversion_rate: number
  /** 月内日订单销售额累加（与 daily-analysis 字段同名，保留以便未来图表使用）。 */
  ordered_sales_amount: number
}

/** 在 DailySummaryBucket 基础上加 SKU / 在途数量。 */
export interface DailyDetailBucket extends DailySummaryBucket {
  sku: string
  asin: string | null
  in_transit_qty: number
}

/** 输入行最少的字段要求 —— 调用方保证有这些字段。 */
interface BucketInput {
  date: string
  order_qty: number
  sales_amount: number
  impressions: number
  clicks: number
  cpc: number
  ad_spend: number
  ad_orders: number
  available_qty: number
  page_views: number
  units_ordered: number
  sessions: number
  ordered_sales_amount: number
  conversion_rate: number
}

interface BucketDetailInput extends BucketInput {
  sku: string
  asin: string | null
  in_transit_qty: number
}

function dateToMonthKey(date: string): string {
  // 'YYYY-MM-DD' → 'YYYY-MM'；空 / 异常格式时原样截前 7 位，调用方应保证日期格式。
  return date.slice(0, 7)
}

function monthKeyToBucketDate(monthKey: string): string {
  return `${monthKey}-01`
}

function finalizeBucket<T extends BucketInput>(
  bucketKey: string,
  sumOrderQty: number,
  sumSalesAmount: number,
  sumImpressions: number,
  sumClicks: number,
  sumAdSpend: number,
  sumAdOrders: number,
  lastAvailableQty: number,
  sumPageViews: number,
  sumUnitsOrdered: number,
  sumSessions: number,
  sumOrderedSalesAmount: number,
): T {
  return {
    date: bucketKey,
    order_qty: sumOrderQty,
    sales_amount: sumSalesAmount,
    impressions: sumImpressions,
    clicks: sumClicks,
    cpc: sumClicks > 0 ? sumAdSpend / sumClicks : 0,
    ad_spend: sumAdSpend,
    ad_orders: sumAdOrders,
    available_qty: lastAvailableQty,
    page_views: sumPageViews,
    units_ordered: sumUnitsOrdered,
    sessions: sumSessions,
    conversion_rate:
      sumPageViews > 0 ? sumUnitsOrdered / sumPageViews : 0,
    ordered_sales_amount: sumOrderedSalesAmount,
  } as T
}

/**
 * 按月汇总 summary 行。
 * 输入日期格式必须为 'YYYY-MM-DD'，输出 date 为 'YYYY-MM-01'，按日期升序返回。
 * 泛型签名让返回类型保持调用方的原类型（如 DailyAnalysisRow），避免 union 上下文里
 * 的结构赋值噪音。
 */
export function bucketSummaryByMonth<T extends BucketInput>(rows: T[]): T[] {
  // monthKey → 累加器
  interface Acc {
    order_qty: number
    sales_amount: number
    impressions: number
    clicks: number
    ad_spend: number
    ad_orders: number
    lastAvailableQty: number
    page_views: number
    units_ordered: number
    sessions: number
    ordered_sales_amount: number
  }
  const acc = new Map<string, Acc>()

  for (const row of rows) {
    const monthKey = dateToMonthKey(row.date)
    if (!monthKey || monthKey.length < 7) continue
    const bucketDate = monthKeyToBucketDate(monthKey)
    const current: Acc =
      acc.get(bucketDate) ??
      ({
        order_qty: 0,
        sales_amount: 0,
        impressions: 0,
        clicks: 0,
        ad_spend: 0,
        ad_orders: 0,
        lastAvailableQty: 0,
        page_views: 0,
        units_ordered: 0,
        sessions: 0,
        ordered_sales_amount: 0,
      } as Acc)

    current.order_qty += Number(row.order_qty) || 0
    current.sales_amount += Number(row.sales_amount) || 0
    current.impressions += Number(row.impressions) || 0
    current.clicks += Number(row.clicks) || 0
    current.ad_spend += Number(row.ad_spend) || 0
    current.ad_orders += Number(row.ad_orders) || 0
    current.page_views += Number(row.page_views) || 0
    current.units_ordered += Number(row.units_ordered) || 0
    current.sessions += Number(row.sessions) || 0
    current.ordered_sales_amount +=
      Number(row.ordered_sales_amount) || 0
    // available_qty 是当日快照 —— 后写入的覆盖前值（即「月末」快照）。
    current.lastAvailableQty = Number(row.available_qty) || 0

    acc.set(bucketDate, current)
  }

  return Array.from(acc.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucketDate, b]) =>
      finalizeBucket<T>(
        bucketDate,
        b.order_qty,
        b.sales_amount,
        b.impressions,
        b.clicks,
        b.ad_spend,
        b.ad_orders,
        b.lastAvailableQty,
        b.page_views,
        b.units_ordered,
        b.sessions,
        b.ordered_sales_amount,
      ),
    )
}

/**
 * 按 (月, SKU) 汇总 detail 行。
 * in_transit_qty 在月内求和（每月在途量的累计更有业务意义）；
 * available_qty 取月内最后一条快照。
 * 泛型签名让返回类型保持调用方的原类型（如 DailyAnalysisDetailRow）。
 */
export function bucketDetailByMonth<T extends BucketDetailInput>(rows: T[]): T[] {
  // bucket key = `${YYYY-MM-01}|${sku}`
  interface Acc {
    sumOrderQty: number
    sumSalesAmount: number
    sumImpressions: number
    sumClicks: number
    sumAdSpend: number
    sumAdOrders: number
    lastAvailableQty: number
    sumPageViews: number
    sumUnitsOrdered: number
    sumSessions: number
    sumOrderedSalesAmount: number
    sumInTransitQty: number
    asin: string | null
  }

  const acc = new Map<string, Acc>()

  for (const row of rows) {
    const monthKey = dateToMonthKey(row.date)
    if (!monthKey || monthKey.length < 7) continue
    const bucketDate = monthKeyToBucketDate(monthKey)
    const compositeKey = `${bucketDate}|${row.sku}`
    const current: Acc =
      acc.get(compositeKey) ??
      ({
        sumOrderQty: 0,
        sumSalesAmount: 0,
        sumImpressions: 0,
        sumClicks: 0,
        sumAdSpend: 0,
        sumAdOrders: 0,
        lastAvailableQty: 0,
        sumPageViews: 0,
        sumUnitsOrdered: 0,
        sumSessions: 0,
        sumOrderedSalesAmount: 0,
        sumInTransitQty: 0,
        asin: row.asin,
      } as Acc)

    current.sumOrderQty += Number(row.order_qty) || 0
    current.sumSalesAmount += Number(row.sales_amount) || 0
    current.sumImpressions += Number(row.impressions) || 0
    current.sumClicks += Number(row.clicks) || 0
    current.sumAdSpend += Number(row.ad_spend) || 0
    current.sumAdOrders += Number(row.ad_orders) || 0
    current.sumPageViews += Number(row.page_views) || 0
    current.sumUnitsOrdered += Number(row.units_ordered) || 0
    current.sumSessions += Number(row.sessions) || 0
    current.sumOrderedSalesAmount +=
      Number(row.ordered_sales_amount) || 0
    current.sumInTransitQty += Number(row.in_transit_qty) || 0
    current.lastAvailableQty = Number(row.available_qty) || 0
    // 同月内同一 SKU 的 asin 应当一致；保留最后一次写入。
    current.asin = row.asin

    acc.set(compositeKey, current)
  }

  return Array.from(acc.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([compositeKey, b]) => {
      const [bucketDate, ...skuParts] = compositeKey.split('|')
      const sku = skuParts.join('|')
      const summary = finalizeBucket<T>(
        bucketDate!,
        b.sumOrderQty,
        b.sumSalesAmount,
        b.sumImpressions,
        b.sumClicks,
        b.sumAdSpend,
        b.sumAdOrders,
        b.lastAvailableQty,
        b.sumPageViews,
        b.sumUnitsOrdered,
        b.sumSessions,
        b.sumOrderedSalesAmount,
      )
      return {
        ...summary,
        sku,
        asin: b.asin,
        in_transit_qty: b.sumInTransitQty,
      } as T
    })
}

/**
 * 把 [from, to] 之间的月份生成 'YYYY-MM-01' 键数组，
 * 用于 chart 的 x 轴 / 上一周期对照的 lookup。
 */
export function generateMonthKeys(from: Date, to: Date): string[] {
  if (!(from instanceof Date) || !(to instanceof Date)) return []
  const startY = from.getFullYear()
  const startM = from.getMonth()
  const endY = to.getFullYear()
  const endM = to.getMonth()
  const months: string[] = []
  for (let y = startY, m = startM; y < endY || (y === endY && m <= endM); ) {
    months.push(
      `${y}-${String(m + 1).padStart(2, '0')}-01`,
    )
    m += 1
    if (m > 11) {
      m = 0
      y += 1
    }
  }
  return months
}

/** Date → 'YYYY-MM-01' 键（与 bucket 输出一致）。 */
export function dateToMonthKeyFromDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

/** Date → 加 N 月（溢出年份自动处理）。 */
export function addMonths(date: Date, amount: number): Date {
  const next = new Date(date)
  const day = next.getDate()
  next.setDate(1)
  next.setMonth(next.getMonth() + amount)
  // 防止「3月31日 + 1 月」溢出到 5 月：把 day 钳到目标月最后一天。
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
  next.setDate(Math.min(day, lastDay))
  return next
}