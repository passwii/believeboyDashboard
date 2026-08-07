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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="h-4 w-4" />
          如何告诉 Agent 调用
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            创建凭据后，把下面的说明复制给 Agent 作为调用配置。Agent
            每次请求都必须同时携带{' '}
            <code className="rounded bg-muted px-1 font-mono text-xs">Authorization</code>{' '}
            与 <code className="rounded bg-muted px-1 font-mono text-xs">X-Agent-Id</code>{' '}
            两个鉴权头。
            {baseUrl ? (
              <span className="mt-1 block">
                后端地址已自动填入：
                <code className="rounded bg-muted px-1 font-mono text-xs">{baseUrl}</code>
              </span>
            ) : (
              <span className="mt-1 block">
                （<code className="rounded bg-muted px-1 font-mono text-xs">&lt;后端地址&gt;</code>{' '}
                请替换为实际后端域名）
              </span>
            )}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Select value={domain} onValueChange={setDomain}>
              <SelectTrigger className="w-[160px]">
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
        <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs leading-relaxed">
          {buildUsageText({ baseUrl, domain })}
        </pre>
      </CardContent>
    </Card>
  )
}
