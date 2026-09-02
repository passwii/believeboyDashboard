'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { BookOpen, Check, Copy } from 'lucide-react'
import { AGENT_DOMAINS, liveAgentDomains } from '@/lib/agent-domains'

/** 取后端公共地址（未配置或失败时返回空串，调用方回退占位符）。 */
export async function fetchBackendBaseUrl(): Promise<string> {
  try {
    const res = await fetch('/api/backend-base', { cache: 'no-store' })
    if (!res.ok) return ''
    const payload = (await res.json()) as { base_url?: string }
    return payload.base_url || ''
  } catch {
    return ''
  }
}

/** 项目名 → ID 解析步骤（BLF-461）：派发文档只写项目名，Agent 先查 ID。 */
function buildResolveProjectStep(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【0. 解析项目 ID（派发时只给项目名，先查 ID）】

  项目名以系统为准（例如 <项目名>），调用后取 data[0].project_id：

  curl "${apiBase}/api/v1/agent/projects?name=<项目名>" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  # → {"ok":true,"data":[{"project_id":1,"project_name":"<项目名>"}]}
  # 把 project_id 记下来，下面所有示例里的 $PROJECT_ID 都替换成它`
}

/** 货件域调用说明（原默认，保持兼容）。 */
function buildShipmentsGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 读取货件列表】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/shipments?page_size=20" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【3. 写操作（两步确认，第一次调用不会落库）】

  第一步（预览，返回 confirm_token）：
  curl -X POST "${apiBase}/api/v1/agent/projects/$PROJECT_ID/shipments" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>" \\
    -H "Content-Type: application/json" \\
    -d '{"shipment_no":"SH-XXX","country":"US","shipping_method":"sea","shipment_status":"draft","items":[{"sku":"X-001","quantity":100}]}'

  第二步（向用户确认后重放，请求体必须与第一步完全一致）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"

【4. 删除货件（两步确认，不可逆）】

  第一步（预览，返回 confirm_token）：
  curl -X DELETE "${apiBase}/api/v1/agent/projects/$PROJECT_ID/shipments/{shipment_no}" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>"

  第二步（向用户确认后重放；DELETE 无请求体，重放保持同样不带 body）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"`
}

/** 店铺测算域调用说明。 */
function buildShopCalculationsGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 读取测算列表】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/shop-calculations?page_size=20" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【3. 查询单个 SKU 测算详情（多国站点需带 ?country=）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/shop-calculations/skus/{sku}" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【4. 查看 SKU 测算历史与审计】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/shop-calculations/skus/{sku}/history" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/shop-calculations/skus/{sku}/audit" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【5. 试算（不落库，纯计算）】

  curl -X POST "${apiBase}/api/v1/agent/projects/$PROJECT_ID/shop-calculations/compute" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Content-Type: application/json" \\
    -d '{"sku":"X-001","country":"US","accounting_type":"profit_calc","sale_price_usd":19.99}'

【6. 追加写（两步确认，第一次调用不会落库）】

  第一步（预览，返回 confirm_token）：
  curl -X POST "${apiBase}/api/v1/agent/projects/$PROJECT_ID/shop-calculations" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>" \\
    -H "Content-Type: application/json" \\
    -d '{"sku":"X-001","country":"US","source":"agent_listing_pull","sale_price_usd":19.99,"profit_usd":4.8}'

  第二步（向用户确认后重放，请求体必须与第一步完全一致）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"`
}

/** 退货分析域调用说明（BLF-474）：纯读 5 条路由，无确认流。 */
function buildReturnAnalysisGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 全量退货分析（R1，summary_text 可直接复述给用户）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/return-analysis/overview?start_date=2026-06-01&end_date=2026-06-30&country=US" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  start_date/end_date 必填（YYYY-MM-DD）；country 默认 US；可加 &sku=<SKU> 钻取单 SKU；
  &include_comments=true 才返回顾客评论（默认剥离 PII）。

【3. per-SKU 风险清单（R2，哪些 SKU 该处理）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/return-analysis?period=30d&country=US" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  period 支持 7d/14d/30d/60d/90d/this_month/last_month/ytd/custom（custom 需带
  start_date/end_date）；country 必填；可按 &sku= &min_return_rate= &risk_level=
  （critical/warning/normal/no_data）过滤，&limit=50（≤500）&offset=0 分页，
  &order_by=&order_dir= 排序。每行含 product_name / reason_top1_display /
  disposition_top1_display。

【4. raw 退货事件明细（R3，PII 永不返回）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/return-analysis-raw?period=30d&country=US" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  参数同 R2 的 period/country/分页/排序；limit 可到 50000。
  customer_comments / raw_row / fnsku / license_plate_number 永不返回。

【5. 单 SKU 钻取（R4）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/return-analysis/skus/{sku}?start_date=2026-06-01&end_date=2026-06-30&country=US" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  参数同 R1；该 SKU 无退货数据返回 200 + 空分布行（不是 404）。

【6. 数据覆盖度/快照新鲜度（R5，分析前可先自查可信度）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/return-analysis/coverage?country=US" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  country 默认 US；返回 report_uploads（上传历史）+ snapshot.fresh（新鲜度）+
  data_span（数据跨度）。`
}

/** 库存信息域调用说明（BLF-478）：纯读 1 条路由，无确认流，独立于补货分析。 */
function buildInventoryGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 查询当前库存信息（总量/库龄/缺货，含全部 SKU）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory?country=US" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  country 默认 US；返回 report_date（数据是几号的）+ summary（SKU 总数/
  缺货数/库龄分布/可售总量）+ items 明细（每 SKU 的 available_qty、各库龄
  段数量、库存/库龄状态、在途数量）。Agent 可据此复述给用户。

【3. 查看单个 SKU 的库存数量（简短临时性查看用这个）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory?country=US&sku=X-001" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  sku 为大小写不敏感子串匹配；summary/action_options/shipment 列会重算为
  过滤集（返回的就是该 SKU 的贡献）。查不到返回空 items（不是 404）。

【4. 查看历史业务日期的库存快照（可选）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory?country=US&report_date=2026-07-01" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  report_date=YYYY-MM-DD，取该日或之前最近的快照；缺省返回最新业务日期。
  注意：这是纯库存信息端口，与补货分析（replenishment-analysis）/库存台账
  （inventory-ledger）互相独立——不含 DMS、售罄日期、补货周期等。`
}

/** 库存台账域调用说明（BLF-485）：纯读 10 条路由，无确认流。 */
function buildInventoryLedgerGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 查询有台账数据的月份（先拿月份，再按月份查）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory-ledger/months" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  返回 YYYY-MM-DD 月份串列表（如 "2026-06-01"），可直接当作 ?period= 值。

【3. 月度快照（SKU 期末余额 + 处置分布 + 完整性，月度对账主入口）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory-ledger/snapshot?period=last_month" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  period 支持别名（7d/14d/28d/30d/60d/90d/this_month/last_month/ytd）与月份串
  （YYYY-MM 或 YYYY-MM-DD）；period=custom 时须带 start_date/end_date。
  解析到整月时自动附带 integrity 跨月连续性检查（上月期末 == 本月期初）。

【4. 期间 SKU 事件汇总（收货/发货/退货/损坏/丢失/处置）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory-ledger/events?period=2026-06" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【5. 收货簇（按日期×仓库聚类，识别同时到货的货件）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory-ledger/receipt-clusters?period=30d" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【6. 跨月完整性检查（只接受整月 period，部分窗口返回 400）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory-ledger/integrity?period=last_month" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  状态：OK / MISMATCH / PENDING（上月无数据）。

【7. 多月趋势（?months=N 驱动，默认 6、最大 24，不用 period）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory-ledger/trend?months=6" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【8. Detailed 视图事件级明细（可按 &msku= &fulfillment_center= &event_type= 过滤）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory-ledger/detail?period=2026-06&msku=X-001" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【9. Summary 视图日水位明细（可按 &msku= &location= &disposition= 过滤）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory-ledger/summary?period=2026-06&disposition=SELLABLE" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【10. CSV 上传批次追溯（文件指纹/行数/状态/对账结果，不用 period）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory-ledger/batches?limit=20" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【11. Detail vs Summary 交叉对账（只接受整月 period）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/inventory-ledger/consistency?period=last_month" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  状态：OK / MISMATCH / PENDING。`
}

/** 广告分析域调用说明（BLF-490）：纯读 10 条聚合路由（镜像自 external，BLF-459）。 */
function buildAdAnalysisGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  const auth = `-H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"`
  const base = `${apiBase}/api/v1/agent/projects/$PROJECT_ID`
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 广告聚合端点（全部 10 条，同一套参数）】

  公共参数：period（必填，7d/14d/28d/30d/60d/90d/this_month/last_month/ytd/custom，
  period=custom 时须另带 start_date/end_date，均为 YYYY-MM-DD）+ country（必填，如 US）。
  返回 {ok, data:{project_id, period, country, data[], summary}}，
  summary 含总花费/点击/订单等聚合指标，可直接复述给用户。

  ① 广告活动（campaign 粒度）：
  curl "${base}/ad-campaigns?period=30d&country=US" \\
    ${auth}

  ② 搜索词（search term 粒度，可看关键词表现）：
  curl "${base}/ad-search-terms?period=30d&country=US" \\
    ${auth}

  ③ 预算（budget 粒度）：
  curl "${base}/ad-budgets?period=30d&country=US" \\
    ${auth}

  ④ 投放目标（target 粒度）：
  curl "${base}/ad-targets?period=30d&country=US" \\
    ${auth}

  ⑤ 展示位置（placement 粒度）：
  curl "${base}/ad-placements?period=30d&country=US" \\
    ${auth}

  ⑥ 推广商品（promoted product 粒度）：
  curl "${base}/ad-promoted-products?period=30d&country=US" \\
    ${auth}

  ⑦ 时间趋势（按报告日期的日粒度，适合看走势）：
  curl "${base}/ad-time-trends?period=30d&country=US" \\
    ${auth}

  ⑧ 搜索词份额（search term share 粒度）：
  curl "${base}/ad-search-term-shares?period=30d&country=US" \\
    ${auth}

  ⑨ 无效流量（invalid traffic 粒度）：
  curl "${base}/ad-invalid-traffic?period=30d&country=US" \\
    ${auth}

  ⑩ 购买商品（purchased product 粒度）：
  curl "${base}/ad-purchased-products?period=30d&country=US" \\
    ${auth}

【3. 深挖明细（可选）】

  每个聚合端点都有同名 -raw 变体（如 ad-campaigns-raw），返回原始行明细，
  支持 &limit=（≤50000）&offset= 分页与 &order_by=&order_dir= 排序，适合深度诊断。`
}

/** 报表上传状态域调用说明（BLF-484）：纯读 1 条路由，无确认流。 */
function buildReportUploadStatusGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 查询报表上传状态矩阵（RPA 各报表是否已上传，15 类活跃口径）】

  curl "${apiBase}/api/v1/agent/report-upload-status?report_date=2026-06-15&country=US" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  report_date 必填（YYYY-MM-DD，非法 → 400）；country 默认 US；
  &project_id=<ID> 可选（只看指定项目；不在凭据可见范围 → 404）。
  返回 items（每项目 uploaded_report_count / missing_report_types / statuses
  明细）+ 顶层 project_count / missing_project_count——缺报清单可直接复述。`
}

/** 补货分析域调用说明（BLF-502）：6 条路由（R1 清单 / R2 深挖 / R3 总览 /
 * R4 覆盖度 / R5 设置读 / R6 设置写 confirm）。 */
function buildReplenishmentAnalysisGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 补货决策清单（R1，三段式：状态/行动/信号）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/replenishment-analysis?country=US&inventory_state=critical,deteriorating&detail=full" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  country 默认 US。三段式过滤（本域 Agent 化核心）：
  &inventory_state= 逗号分隔多值 ∈ critical/deteriorating/watch/healthy/unknown；
  &replenishment_action= 逗号分隔多值 ∈ REPLENISH_NOW/REPLENISH_NORMAL/HOLD/
  REDUCE_PRICE/REMOVE/NO_ACTION（例："哪些 SKU 该补货/该降价"用
  &replenishment_action=REPLENISH_NOW,REPLENISH_NORMAL,REDUCE_PRICE,REMOVE）。
  &detail=summary（默认，轻量决策字段）| full（完整行 + signals + decision_path
  解释"为什么这么判"）；&order_by= 白名单（sellable_days/weighted_dms/…）&
  order_dir=asc|desc；&report_date= 历史快照；&page=&page_size= 分页。
  risk_status 为兼容旧字段（老 4 类风险）。

【3. 单 SKU 深挖（R2，含决策路径解释）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/replenishment-analysis/skus/X-001?country=US" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  返回该 SKU 完整行 + signals + decision_path（state_rule P0-P13 / critical_subtype /
  action_rule / seasonal_override）；无该 SKU 返回 200 + data:null（不是 404）。

【4. 项目总览（R3，state×action 分布矩阵）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/replenishment-analysis/summary?country=US" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  返回 summary（5 state 计数）+ state_distribution / action_distribution /
  state_action_matrix（交叉矩阵）——项目级概括一次调用。

【5. 数据覆盖度/新鲜度（R4，先自查可信度）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/replenishment-analysis/coverage?country=US" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  返回 inventory_snapshot（report_date/freshness_days）+ sales_data（销售跨度）+
  base_skus（基表数/有设置数）+ unknown_rate（缺数据无法判定的占比）。

【6. 补货设置（R5 读 / R6 写，写走确认流）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/replenishment-analysis/settings?country=US" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  写（调整补货周期/安全系数）分两步：先 PUT
  "${apiBase}/api/v1/agent/projects/$PROJECT_ID/replenishment-analysis/settings/X-001?country=US"
  （body: {"asin":"...","production_lead_days":35,"shipping_days":40,"safety_factor":0.2}，
  带 Idempotency-Key）→ 返回 preview + confirm_token（不落库）→ 用同一
  Idempotency-Key + X-Confirm-Token 重放才真正生效。`
}

/** 新品测算域调用说明（BLF-526）：读3+写1+试算1，写走确认流。 */
function buildNewProductCalculationsGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 快照列表（R1，calculation_type/country 过滤 + 分页）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/new-product-calculations?calculation_type=profit_calc&page_size=20" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【3. 单 SKU 详情（R2，calculation_type 缺省 profit_calc）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/new-product-calculations/skus/{sku}?calculation_type=profit_calc" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【4. SKU 审计轨迹（R3，upsert 覆盖历史）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/new-product-calculations/skus/{sku}/audit" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【5. 试算（C1，不落库；mode 支持 profit_calc / profit_reverse / cost_reverse / fbm_calc）】

  curl -X POST "${apiBase}/api/v1/agent/projects/$PROJECT_ID/new-product-calculations/compute" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Content-Type: application/json" \\
    -d '{"mode":"profit_calc","sku":"X-001","country":"US","package_length_cm":10,"package_width_cm":8,"package_height_cm":5,"weight_kg":0.5,"fob_product_cost_rmb":20,"first_leg_cost_rmb":5,"sale_price_usd":19.99,"advertising_rate":0.12,"return_loss_rate":0.04,"storage_months":1}'

  返回 {mode, calculation, snapshot}；不写库、不落审计，可放心反复试算。

【6. 快照落库（W1，两步确认，第一次调用不会落库）】

  第一步（预览，返回 confirm_token）：
  curl -X POST "${apiBase}/api/v1/agent/projects/$PROJECT_ID/new-product-calculations" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>" \\
    -H "Content-Type: application/json" \\
    -d '{"sku":"X-001","asin":"ASIN-X-001","country":"US","calculation_type":"profit_calc","source":"agent_listing_pull","sale_price_usd":19.99,"profit_usd":4.8,"profit_rate":0.24}'

  第二步（向用户确认后重放，请求体必须与第一步完全一致）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"`
}

/** 店铺合规健康域调用说明（BLF-551）：纯读 5 条路由，无确认流。 */
function buildAccountHealthGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 巡检周期列表（R1，先拿周期 id 再查明细）】

  curl "${apiBase}/api/v1/agent/account-health/periods?limit=20&offset=0" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  limit 默认 20（≤100）、offset 默认 0；返回 items（period_id/week_start/week_end/
  deadline/submitted_count）+ total——submitted_count 可快速判断周完成度。

【3. 当前周期（R2）】

  curl "${apiBase}/api/v1/agent/account-health/periods/current" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  纯读（不新建周期）；无周期 → 404。

【4. 周期概览（R3，项目级聚合）】

  curl "${apiBase}/api/v1/agent/account-health/periods/{period_id}/overview" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  返回 period + items（每店拍平行：health 8 字段 + compliance 10 字段 +
  compliance_total + screenshot_count）+ total_projects / submitted_count /
  overdue_count。items 已按凭据 project_scope 过滤；周期不存在 → 404。

【5. 单店明细（R4，深挖某店）】

  curl "${apiBase}/api/v1/agent/account-health/periods/{period_id}/projects/{project_id}?include_summary=true" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  include_summary 可选（默认不返回 status_summary，覆盖率低）；项目不在凭据范围
  或无报告 → 404。空值 = null 非 0（未录入 vs 录入为 0 要区分）。

【6. 历史趋势（R5，跨周期对比）】

  curl "${apiBase}/api/v1/agent/account-health/history?period_id=1&order_by=week_start&order_dir=desc&limit=50" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  period_id / project_id 可选筛选；order_by 白名单（week_start/project_name/
  account_health_rating/compliance_total/submitted_at + 各数值列，非法 → 400）；
  order_dir=asc|desc；limit 默认 50（≤200）。空结果 → 200 + 空 items。`
}

/** 销售数据域调用说明（BLF-569）：纯读 1 条路由，无确认流。 */
function buildSalesGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 销售订单汇总（原始行模式，不传 group_by）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/sales/summary?period=30d&country=US" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  period 支持 7d/14d/30d/60d/90d/this_month/last_month/ytd/custom（custom 需带
  start_date/end_date）；country 默认 US；include_cancelled=false、
  include_pending=true；limit 默认 50000。返回 data（订单行明细：ASIN×SKU×日×
  数量×金额）+ summary。此模式只支持单站点（多站点聚合请看下面 group_by 模式）。

【3. 聚合统计（group_by=asin|asin_day|day，SQL 侧聚合）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/sales/summary?period=30d&country=US&group_by=asin&include_share=true&limit=50" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  group_by 白名单：asin（TOP ASIN 排名）/ asin_day（ASIN×日明细）/ day（日趋势）；
  非法值 → 400。order_by 白名单（sales_amount/quantity/order_count，默认
  sales_amount）+ order_dir=desc|asc；limit 默认 500（≤50000）&offset 分页。
  返回 rows + total_rows + summary（SQL 全量汇总，不受 limit 影响）；
  share 仅在 group_by=asin&include_share=true 时返回（同国家内占比）。
  sales_amount 口径与定时报表一致（DE/UK 含税，其余净额），可直接复述给用户。

【4. 多站点聚合（country=US,DE，仅 group_by 模式支持）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/sales/summary?period=30d&country=US,DE&group_by=day" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  行按（聚合维度 × 国家）分组、带 country+currency；金额按国家独立结算、
  不做跨币种求和（summary.by_country 逐站平行列出）；订单数/数量可跨站求和。`
}

/** SKU 主数据域调用说明（BLF-579 S3 / BLF-628 W4）：读 3 + 写 4，写全部走确认流（W4 为 multipart 两步确认）。 */
function buildSkuInfoGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. SKU 列表（R1，分页/筛选/搜索）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/sku-info?country=US&page_size=20" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  country（2 字母）可选；is_active 默认 true（只返回上架 SKU），查下架需显式
  &is_active=false；sku/asin 可选 ilike 模糊搜索；page 默认 1、page_size 默认
  200（≤500）、include_total 可选。响应 { items, page, page_size, total, has_next }。
  读路由不落审计。

【3. 单 SKU 详情（R2，含工厂信息/图片/市场链接）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/sku-info/{sku_record_id}" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  返回该 SKU 全字段（sku_factory_info / fnsku_label_r2_url / product_image_r2_url /
  product_image_thumbnail_r2_url / marketplace_url / created_at / updated_at）；
  不暴露内部 *_r2_key 与 source_file。记录不存在或跨项目 → 404。

【4. 审计轨迹（R3，按 SKU 聚合写操作）】

  curl "${apiBase}/api/v1/agent/projects/$PROJECT_ID/sku-info/{sku_record_id}/audit?limit=50" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  limit 默认 50（≤200）；返回 items（action/agent_id/operator/idempotency_key/
  result/before/after/error_message/created_at）——含人工前端操作轨迹（operator 列），
  可完整追溯。

【5. 新建 / 更新 SKU（W1 upsert，两步确认）】

  第一步（预览，返回 confirm_token，不落库）：
  curl -X POST "${apiBase}/api/v1/agent/projects/$PROJECT_ID/sku-info" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>" \\
    -H "Content-Type: application/json" \\
    -d '{"sku":"X-001","asin":"ASIN-X-001","country":"US","source":"agent_user_supplied","product_name":"示例产品","fob_unit_cost":5.2,"first_leg_cost_rmb":3.5}'

  第二步（向用户确认后重放，请求体必须与第一步完全一致）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"

  sku / asin / country 必填（唯一键 (project_id, sku, asin, country) 命中则更新、
  否则插入；action=inserted/updated）；source 必填溯源枚举 ∈ agent_listing_pull /
  agent_user_supplied / external_api（**禁 manual**，非法 → SKU_INFO_INVALID_SOURCE
  400）；source_file 由服务端派生 agent:<agent_id>，不接受传值；currency 恒 CNY。
  可选：fnsku / product_name / fob_unit_cost / first_leg_cost_rmb / 包装尺寸 /
  重量 / 箱规 / units_per_carton / is_active / sort_order / sku_factory_info
  （数值均 ≥0）。

【6. 更新规格 / 成本（W2 PATCH，两步确认）】

  第一步（预览）：
  curl -X PATCH "${apiBase}/api/v1/agent/projects/$PROJECT_ID/sku-info/{sku_record_id}" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>" \\
    -H "Content-Type: application/json" \\
    -d '{"source":"agent_user_supplied","fob_unit_cost":6.1}'

  第二步：同一 URL + 同一 Idempotency-Key，另加 X-Confirm-Token 重放。
  只更新显式提供的字段（缺省字段不被重置）；身份字段 sku / asin / country
  禁改（传值 → VALIDATION_FAILED）；更新后与现有记录唯一键冲突 →
  SKU_INFO_DUPLICATE（409）。改成本/规格影响财务汇总/货件计费（预览 note 明示）。

【7. 上 / 下架（W3，两步确认）】

  第一步（预览）：
  curl -X POST "${apiBase}/api/v1/agent/projects/$PROJECT_ID/sku-info/{sku_record_id}/status" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>" \\
    -H "Content-Type: application/json" \\
    -d '{"source":"agent_user_supplied","is_active":false}'

  第二步：同一 URL + 同一 Idempotency-Key，另加 X-Confirm-Token 重放。
  is_active=true 上架 / false 下架（软切换非删除）；目标值与当前一致时幂等直接
  返回当前态（不重复审计）。**下架后该 SKU 退出补货分析/定时报表/店铺测算默认
  消费（按 is_active=True 过滤），历史数据保留、可随时重新上架**。

【8. 上传 FNSKU 标签 PDF（W4，multipart 两步确认）】

  第一步（预览，返回 confirm_token，不落库）：
  curl -X POST "${apiBase}/api/v1/agent/projects/$PROJECT_ID/sku-info/{sku_record_id}/fnsku-label" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>" \\
    -F "file=@./fnsku-label.pdf" \\
    -F "source=agent_user_supplied"

  第二步（向用户确认后重放，文件字节/文件名/source 必须与第一步一致）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"

  multipart/form-data 字段：file（PDF）+ source（溯源枚举 ∈ agent_listing_pull /
  agent_user_supplied / external_api，禁 manual，非法 → SKU_INFO_INVALID_SOURCE
  400）；仅 .pdf（后缀不区分大小写）、非空、≤20MB、缺 file → VALIDATION_FAILED；
  record 不存在或跨项目 → 404 RESOURCE_NOT_FOUND。**不做 FNSKU 内容验证**（D10
  用户拍板；标签仅展示用途）。预览返回 filename / file_size / replace_old（该 SKU
  已有标签时为 true，确认后将删除旧标签）与 note；confirm_token 绑定内容指纹
  （sha256(source+文件名+文件字节)，不含 multipart boundary）——重放可换 boundary，
  但 source/文件名/文件字节任一变化 → CONFIRM_TOKEN_INVALID（token 有效期 300 秒）。
  落库：删旧 R2 key（失败不阻塞）→ 上传 R2（fnsku-labels）→ 更新
  fnsku_label_r2_key/url → 审计 sku_info.upload_fnsku_label（agent_id /
  idempotency_key 归因）。响应 { ok, data: { sku_record_id, fnsku_label_r2_url,
  file_size, filename } }；上传后可经 R2 详情读回 URL。

  场景选择：建新 SKU 用 W1、改成本/规格用 W2、上/下架用 W3、传标签用 W4；
  删除/批量/CSV 导入不对 Agent 开放（删除→用 W3 下架替代）。写操作均带
  Idempotency-Key（可缺失；出现则非空且 ≤64 字符）做幂等，重放内容必须与
  第一步一致（multipart 重放可换 boundary）。`
}

/** 平台巡检域调用说明（BLF-948）：写侧 R0+W1–W4 共 5 条路由，读侧走 account-health。 */
function buildPlatformInspectionGuide(opts: {
  key?: string
  agentId?: string
  apiBase: string
}): string {
  const { key, agentId, apiBase } = opts
  return `【1. 存活探针】

  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

【2. 巡检表单模板（R0，写输入 schema 的唯一事实源）】

  curl "${apiBase}/api/v1/agent/platform-inspection/template" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  返回写侧字段全集（类型/枚举/阈值），W1 请求体以此为 schema：
  health_fields（账户健康评级 select，1）+ service_performance_fields（客服绩效，3）+
  shipping_performance_fields（配送绩效，4）+ compliance_fields（合规计数，10）。
  注意 W1 的 health_data 块是合并的 8 key（rating + 客服 3 + 配送 4），与模板分组
  同字段、不同源形态。

【3. 填写 / 更新草稿（W1 PUT，upsert 幂等，不 confirm，可反复覆盖）】

  curl -X PUT "${apiBase}/api/v1/agent/platform-inspection/periods/{period_id}/projects/$PROJECT_ID" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Content-Type: application/json" \\
    -d '{"health_data":{"account_health_rating":"Good","negative_feedback":2,"late_shipment_rate":1.5},"compliance_data":{"ip_infringement":0,"listing_policy_violations":1},"status_summary":"本周账户状况良好，无异常"}'

  upsert：(period_id, project_id) 无草稿 → 新建；有 → 覆盖更新（重复 PUT 不新建）。
  显式字段合并：只透传显式提供的 key——health_data / compliance_data 未提供的子键
  保持当前值（不置 null 覆盖）；status_summary 显式提供才更新；缺失整块 → 保持现状。
  account_health_rating 枚举 ∈ Healthy / Good / At Risk / Critical（非法 → 400
  VALIDATION_FAILED）；阈值 warn 1 / crit 3（负反馈、A2Z、chargeback、合规计数）、
  late_shipment_rate warn 2.0 / crit 4.0、valid_tracking_rate / on_time_delivery_rate
  warn 97.0 / crit 95.0 below。**不提供 screenshot_ids**（截图一律经 W3 上传挂靠 report）。

【4. 上传截图（W3 POST，multipart，不 confirm；需先有草稿）】

  curl -X POST "${apiBase}/api/v1/agent/platform-inspection/periods/{period_id}/projects/$PROJECT_ID/screenshots" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -F "file=@./screenshot.png"

  前置要求：该 (period, project) 必须先有草稿报告（先 W1 建档再传图，无草稿 → 404）。
  multipart 字段仅 file：image/jpeg|png|webp|gif、≤10MB（超限 → 400 VALIDATION_FAILED）。
  响应**不含 presigned URL**（R2 私桶临时凭证不外泄），只给 screenshot_id + filename /
  content_type / file_size / caption / sort_order / created_at。

【5. 提交报告（W2 POST，confirm 两步，不可逆）】

  提交前先 W1 建档（无草稿 → 404 RESOURCE_NOT_FOUND）。确认后
  status=submitted + submitted_by=<agent_id> + submitted_at，**无 unsubmit 回退路径**。

  第一步（预览，返回 confirm_token，不落库）：
  curl -X POST "${apiBase}/api/v1/agent/platform-inspection/periods/{period_id}/projects/$PROJECT_ID/submit" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>" \\
    -H "Content-Type: application/json" \\
    -d '{}'

  第二步（向用户确认后重放，请求体必须与第一步完全一致）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"

  响应透出 warnings（阈值告警列表），Agent 应向用户汇报异常指标。

【6. 删除截图（W4 DELETE，confirm 两步，不可逆）】

  第一步（预览，返回 confirm_token，不落库）：
  curl -X DELETE "${apiBase}/api/v1/agent/platform-inspection/screenshots/{screenshot_id}" \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}" \\
    -H "Idempotency-Key: <UUID>"

  第二步（向用户确认后重放；DELETE 无请求体，重放保持同样不带 body）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"

  不可逆：R2 原图 + 缩略图 + DB 行一并删除，无恢复路径。项目范围在服务端按截图
  归属校验（不在凭据范围 → 403）；截图不存在 → 404 RESOURCE_NOT_FOUND。

【7. 读写分离与调用顺序】

  本域 = 巡检数据写侧；**读走 account-health 域**（周期列表/当前周期/概览/单店报告/
  历史），当前周期 ID 先经 account-health R2 /account-health/periods/current 拿。
  标准流程：**先 W1 建档 → W3 传图 → W2 提交**（W3 需草稿存在；W2 提交后不可逆，
  确认无误再交）。W4 可随时删除（无需先提交），但属删除性操作必须 confirm。
  草稿阶段可反复 W1 覆盖（不 confirm）；提交后无法修改，需新周期重填。两侧响应均
  不含 presigned URL（读侧只给 screenshot_count、写侧只给 id + 元数据），如需查看
  截图请引导用户去前端「平台巡检」页面。`
}

/** 规划中/未知域的通用占位说明。 */
function buildPlaceholderGuide(opts: { key?: string; agentId?: string; apiBase: string }): string {
  const { key, agentId, apiBase } = opts
  return `【该业务域尚未接入 Agent API】

  当前仅可调用存活探针：
  curl ${apiBase}/api/v1/agent/health \\
    -H "Authorization: Bearer ${key}" \\
    -H "X-Agent-Id: ${agentId}"

  业务域接入后，调用示例会自动生成。`
}

/**
 * 生成给 Agent 的调用说明文本（按业务域）。
 * ``domain`` 缺省为 shipments（保持旧签名兼容）。
 */
export function buildUsageText(opts?: {
  plaintextKey?: string
  agentId?: string
  baseUrl?: string
  domain?: string
}) {
  const key = opts?.plaintextKey ?? '<明文 Key>'
  const agentId = opts?.agentId ?? '<Agent ID>'
  const apiBase = (opts?.baseUrl || '').replace(/\/+$/, '') || '<后端地址>'
  const domain = opts?.domain ?? 'shipments'

  const authHeader = `【鉴权头】每次请求都必须携带（两个都缺一不可）：

  Authorization: Bearer ${key}
  X-Agent-Id: ${agentId}`

  let domainGuide: string
  if (domain === 'shipments') {
    domainGuide = buildShipmentsGuide({ key, agentId, apiBase })
  } else if (domain === 'shop_calculations') {
    domainGuide = buildShopCalculationsGuide({ key, agentId, apiBase })
  } else if (domain === 'return_analysis') {
    domainGuide = buildReturnAnalysisGuide({ key, agentId, apiBase })
  } else if (domain === 'inventory') {
    domainGuide = buildInventoryGuide({ key, agentId, apiBase })
  } else if (domain === 'inventory_ledger') {
    domainGuide = buildInventoryLedgerGuide({ key, agentId, apiBase })
  } else if (domain === 'report_upload_status') {
    domainGuide = buildReportUploadStatusGuide({ key, agentId, apiBase })
  } else if (domain === 'ad_analysis') {
    domainGuide = buildAdAnalysisGuide({ key, agentId, apiBase })
  } else if (domain === 'replenishment_analysis') {
    domainGuide = buildReplenishmentAnalysisGuide({ key, agentId, apiBase })
  } else if (domain === 'new_product_calculations') {
    domainGuide = buildNewProductCalculationsGuide({ key, agentId, apiBase })
  } else if (domain === 'account_health') {
    domainGuide = buildAccountHealthGuide({ key, agentId, apiBase })
  } else if (domain === 'sales') {
    domainGuide = buildSalesGuide({ key, agentId, apiBase })
  } else if (domain === 'sku_info') {
    domainGuide = buildSkuInfoGuide({ key, agentId, apiBase })
  } else if (domain === 'platform_inspection') {
    domainGuide = buildPlatformInspectionGuide({ key, agentId, apiBase })
  } else {
    domainGuide = buildPlaceholderGuide({ key, agentId, apiBase })
  }

  return `Agent API 调用说明（${AGENT_DOMAINS.find((d) => d.code === domain)?.label ?? domain}）
=====================

${authHeader}

${buildResolveProjectStep({ key, agentId, apiBase })}

${domainGuide}

【注意事项】
- 明文 Key 只在创建时展示一次，请妥善保存；库中只存 SHA-256
- 吊销后该凭据立即失效，Agent 需换新卡
- 写操作涉及费用/不可逆状态变更，确认流是强制安全门
- 限流：读 300 次/分钟，写 30 次/分钟（按 Agent ID 计）`
}

export function AgentUsageGuide() {
  const [copied, setCopied] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [domain, setDomain] = useState('shipments')

  useEffect(() => {
    let cancelled = false
    void fetchBackendBaseUrl().then((url) => {
      if (!cancelled) setBaseUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const domainLabel = useMemo(
    () => AGENT_DOMAINS.find((d) => d.code === domain)?.label ?? domain,
    [domain]
  )

  const copyAll = async () => {
    await navigator.clipboard.writeText(buildUsageText({ baseUrl, domain }))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card className="rounded-none border border-term-border bg-term-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="h-4 w-4" />
          如何告诉 Agent 调用
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-start sm:justify-between">
          <p className="text-sm text-muted-foreground">
            创建凭据后，把下面的说明复制给 Agent 作为调用配置。Agent
            每次请求都必须同时携带{' '}
            <code className="rounded-none bg-term-raised px-1 font-mono text-xs">Authorization</code>{' '}
            与 <code className="rounded-none bg-term-raised px-1 font-mono text-xs">X-Agent-Id</code>{' '}
            两个鉴权头。
            {baseUrl ? (
              <span className="mt-1 block">
                后端地址已自动填入：
                <code className="rounded-none bg-term-raised px-1 font-mono text-xs">{baseUrl}</code>
              </span>
            ) : (
              <span className="mt-1 block">
                （<code className="rounded-none bg-term-raised px-1 font-mono text-xs">&lt;后端地址&gt;</code>{' '}
                请替换为实际后端域名）
              </span>
            )}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Select value={domain} onValueChange={setDomain}>
              <SelectTrigger className="w-full sm:w-[160px]">
                <SelectValue placeholder="选择业务域" />
              </SelectTrigger>
              <SelectContent>
                {liveAgentDomains().map((d) => (
                  <SelectItem key={d.code} value={d.code}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={copyAll}>
              {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
              {copied ? '已复制' : '复制说明'}
            </Button>
          </div>
        </div>
        <pre className="overflow-x-auto rounded-none border border-term-border bg-term-bg p-3 font-mono text-xs leading-relaxed">
          {buildUsageText({ baseUrl, domain })}
        </pre>
      </CardContent>
    </Card>
  )
}
