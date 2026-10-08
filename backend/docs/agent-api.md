# Agent API (`/api/v1/agent/*`)

面向 LLM Agent 的读写 API，替代原 `/api/v1/external/*`（后者过渡期保留，
见 `backend/docs/external-api.md` 顶部弃用说明）。设计文档：
[`docs/agent-api-design.md`](../../docs/agent-api-design.md)。

## 1. 鉴权（强制）

| Header | 必填 | 说明 |
|---|---|---|
| `Authorization` | ✅ | `Bearer <key_secret>`（管理页创建时的明文 Key，仅展示一次） |
| `X-Agent-Id` | ✅ | 与凭据绑定的 Agent ID 完全一致 |
| `Idempotency-Key` | 写时推荐 | ≤64 字符；缺失会在审计行打 `no_idempotency` 风险标记 |
| `X-Confirm-Token` | 危险写回放时 ✅ | 预览响应返回的 `confirm_token` |

不接受：`X-API-Key` 头、`?api_key=` 查询参数、`?skip_auth=true`、master key。
存量 external key（未绑定 agent_id）调本命名空间一律 401 `agent_id_mismatch`。

凭据管理：前端"系统 → Agent 凭据"页（`/dashboard/system/agent-management`），
或 admin 调 `POST/GET /api/v1/internal/api-keys`。

## 2. 端点

    GET /api/v1/agent/health    存活探针

### 库存信息域（BLF-478）

纯读 1 条路由，**独立于**补货分析（`replenishment-analysis`）与库存台账
（`inventory-ledger`）——只读当前库存快照（总量/库龄/缺货/单 SKU 数量），
服务于简短的临时性数量查看。

    GET /api/v1/agent/projects/{project_id}/inventory

Query 参数：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `country` | str | `US` | 国家站点 |
| `sku` | str | 无 | 单 SKU 数量查看：大小写不敏感子串匹配；summary/action_options/shipment 列重算为过滤集，查不到返回空 items（200） |
| `report_date` | date | 最新业务日期 | `YYYY-MM-DD`，取该日或之前最近的快照 |

响应 `data`（与内部 `/api/v1/inventory-analysis` 同构，共享 Redis 缓存）：

```json
{
  "project_id": 1,
  "project_name": "...",
  "country": "US",
  "report_date": "2026-08-06",
  "summary": {
    "sku_count": 12,
    "out_of_stock_count": 1,
    "aging_sku_count": 2,
    "over_aged_sku_count": 1,
    "total_available_qty": 580,
    "total_age_0_90_qty": 300,
    "total_age_91_180_qty": 150,
    "total_age_181_270_qty": 80,
    "total_age_271_365_qty": 30,
    "total_age_365_plus_qty": 20,
    "action_type_count": 3
  },
  "action_options": ["Liquidate", "Replenish"],
  "items": [
    {
      "sku": "X-001",
      "asin": "B0000001",
      "product_name": "产品A",
      "available_qty": 10,
      "age_0_90_qty": 10,
      "recommended_action": "Replenish",
      "stock_status": "in_stock",
      "aging_status": "fresh",
      "shipment_quantities": {}
    }
  ],
  "shipment_columns": [],
  "shipment_column_totals": {}
}
```

### 货件域（P2）

    GET    /api/v1/agent/projects/{project_id}/shipments
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/sku-summary
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/fba-box-detail
    GET    /api/v1/agent/projects/{project_id}/shipments/fba-box-details.xlsx?shipment_no={shipment_no}
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/audit
    POST   /api/v1/agent/projects/{project_id}/shipments                      （confirm）
    PATCH  /api/v1/agent/projects/{project_id}/shipments/{shipment_no}        （confirm）
    PUT    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/items  （confirm）
    POST   /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/status （confirm）
    POST   /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/recalculate-costs （confirm）

**FBA 箱单明细 XLSX 导出**：

```bash
curl -fLsS --get "$BASE/projects/$PROJECT_ID/shipments/fba-box-details.xlsx" \
  "${AUTH[@]}" \
  --data-urlencode "shipment_no=$SHIPMENT_NO" \
  -o "${SHIPMENT_NO}-fba-box-details.xlsx"
```

`shipment_no` 可重复传入多个值（同项目最多 100 个），至少一个；每个货件必须属于路径中的项目。成功返回与 Dashboard「FBA 箱单明细」同字段、排序和汇总口径的 XLSX 二进制流；图片缺失或不可下载时仍返回工作簿。不存在、跨项目或空明细货件返回 Agent `RESOURCE_NOT_FOUND` 错误壳；不写审计，不持久化导出文件。该端点与 JSON 箱单明细和 FBA 发货模板是不同资源。

写接口（confirm）两步：第一次调用返回 HTTP 200 + `requires_confirmation:true` +
`confirm_token`（300s 有效，与请求体 SHA-256 绑定）；向用户复述 preview 摘要，
确认后**用同一 Idempotency-Key + X-Confirm-Token + 完全相同的请求体**重放。

货件字段约定：`shipment_status` ∈ {draft, in_transit, completed}；
`shipping_method` ∈ {sea, air, express, truck, rail, other}（英文 token）。

### 店铺测算域（含定价派生块 `anchor`，BLF-1043）

    GET    /api/v1/agent/projects/{project_id}/shop-calculations
    GET    /api/v1/agent/projects/{project_id}/shop-calculations/skus/{sku}
    GET    /api/v1/agent/projects/{project_id}/shop-calculations/skus/{sku}/history
    GET    /api/v1/agent/projects/{project_id}/shop-calculations/skus/{sku}/audit
    GET    /api/v1/agent/projects/{project_id}/shop-calculations/export.xlsx
    POST   /api/v1/agent/projects/{project_id}/shop-calculations                 （confirm）
    POST   /api/v1/agent/projects/{project_id}/shop-calculations/compute
    GET    /api/v1/agent/projects/{project_id}/shop-calculation-history          （BI 扁平）
    GET    /api/v1/agent/projects/{project_id}/shop-calculation/snapshots        （BI 扁平）
    GET    /api/v1/agent/projects/{project_id}/pricing-snapshots                 （BI 扁平）
    GET    /api/v1/agent/projects/{project_id}/new-product-calculations
    GET    /api/v1/agent/projects/{project_id}/new-product-calculations/export.xlsx
    GET    /api/v1/agent/projects/{project_id}/new-product-calculations/skus/{sku}
    GET    /api/v1/agent/projects/{project_id}/new-product-calculations/skus/{sku}/audit
    POST   /api/v1/agent/projects/{project_id}/new-product-calculations                 （confirm）
    POST   /api/v1/agent/projects/{project_id}/new-product-calculations/compute

#### New-product-calculations Excel 导出

`GET /api/v1/agent/projects/{project_id}/new-product-calculations/export.xlsx`
按已保存快照记录导出前端同构的「测算对比矩阵」。端点继承 `project_scope` 与
`business_scope=new_product_calculations`，不重新试算、不读取 pricing run。

| 参数 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `project_id` | path | 必填 | 当前项目 |
| `snapshot_ids` | query，可重复 | 必填 | 1 到 12 个正整数；每个 ID 对应 Excel 中一列，顺序按请求顺序 |

示例：

```text
GET /api/v1/agent/projects/1/new-product-calculations/export.xlsx
  ?snapshot_ids=101&snapshot_ids=102
```

成功时直接返回 XLSX 二进制流，不包裹 `agent_ok`，不使用 Base64：

```http
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="..."; filename*=UTF-8''...
```

规则：

- `snapshot_ids` 缺失、重复、非正整数或超过 12 条 → `400 VALIDATION_FAILED`。
- 任一快照不存在或不属于路径项目 → 整批失败，`details.missing_snapshot_ids`
  返回缺失 ID，不生成部分文件。
- Excel 五个分区依次为：货品数据 / DDP 成本 / 费用支出 / 售价与利润 / 核算规则。
- 当前快照未持久化的竞品链接、头程单价(RMB/kg)、头程数量显示 `-`；
  平台佣金率由 `referral_fee_usd / sale_price_usd` 反推。
- 成功导出写 `operation_audit_logs`，action 为
  `new_product_calculation.export`，记录 `snapshot_ids`、`row_count` 和
  `column_count`，不记录文件内容。

#### Shop-calculations Excel 导出

`GET /api/v1/agent/projects/{project_id}/shop-calculations/export.xlsx` 复用
`shop_calculation` 当前态/历史快照查询，不在 Agent 或客户端重新分类、重算。
端点继承 `project_scope` 与 `business_scope=shop_calculations`，每次导出写一条
`operation_audit_logs`（`action=shop_calculation.export`）。

| 参数 | 默认 | 说明 |
|---|---|---|
| `country` | 无 | `US` / `DE` / `UK`；不传时导出项目内全部站点 |
| `sku` | 无 | 精确筛选 SKU；不传时导出全部 SKU |
| `mode` | `current` | `current` 按 `(project_id, sku, country)` 取最新有效快照；`history` 返回有效历史快照 |
| `as_of` | 无 | ISO 时间；按 `observed_at <= as_of` 截止，支持 `Z` 时区写法 |
| `include_uncomputed` | `true` | 是否保留没有测算快照的 SKU；保留时行内 `warnings` 为 `未核算/缺数据`，不静默漏行 |

返回 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` 文件流，
文件名包含项目、站点和 UTC 导出时间。Excel 列与前端店铺 SKU 测算导出一致，末尾
追加 `ASIN`、`source`、`observed_at`、`warnings` 四列。

**为什么有这个块**：判定「广告效率好不好」需要「盈亏平衡广告费率」（运营口径的
盈亏平衡 ACOS）。`advertising_rate` 在定价引擎里只以线性项
`sale_price_usd × advertising_rate` 出现，所以它是一元一次方程、有闭式解 —— 由 API
算一次，所有消费方（广告周报 / OPS 审批 / 报表）共用同一口径，避免各写一遍漂移：

```text
non_ad_fee_usd            = total_fee_usd - advertising_fee_usd   # EU 三笔手动费已在 total_fee 内
breakeven_advertising_rate = 1 - (non_ad_fee_usd + ddp_cost_usd + vat_usd) / sale_price_usd
```

自检恒等式：`breakeven_advertising_rate ≡ advertising_rate + profit_rate`
（两侧均含引擎的 2 位金额 / 4 位比率舍入，残差 ≤ 约 `0.01 / sale_price_usd`）。

富契约挂嵌套块 `anchor`：R1/R2/R3（`shop-calculations*`）、W1 追加写的**预览响应**、
新品域 R1/R2 与 C1（`new-product-calculations*`，读行 + 试算 `calculation` / `snapshot`）、
以及店铺域 C1（`calculation` 与 `snapshot` 两块）。
BI 扁平契约（`shop-calculation-history`、`shop-calculation/snapshots`、`pricing-snapshots`）
没有费用拆项，改为**显式补四列**（服务端推）：`breakeven_advertising_rate` /
`non_ad_fee_usd` / `max_ad_spend_per_unit_usd` / `target_advertising_rate`。
不带 `anchor` 的同类路由：`/skus/{sku}/audit`（审计轨迹，两域均是）——
审计接口只回操作轨迹，无费用拆项，不派生锚。

```json
{
  "anchor": {
    "breakeven_advertising_rate": 0.2980,
    "non_ad_fee_usd": 15.60,
    "max_ad_spend_per_unit_usd": 12.81,
    "breakeven_advertising_rate_after_vat": null,
    "target_net_margin": 0.10,
    "target_advertising_rate": 0.1980,
    "basis": {
      "observed_at": "2026-09-13T08:00:00+00:00",
      "usd_to_rmb_rate": 6.7894,
      "usd_to_rmb_rate_source": "manual"
    }
  }
}
```

Query / body 参数：

| 参数 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `include_anchor` | Query（店铺域 R1/R2/R3 + R5/R6/R7） | `true` | R1/R2/R3 关闭时移除嵌套 `anchor`；R5/R6/R7 关闭时移除四个扁平锚列。字段必须缺席，不是置 null |
| `target_net_margin` | Query（店铺域 R1/R2/R3 + R5/R6/R7）/ body（店铺域 C1） | 不传 | 目标净利率，校验 `ge=-1, le=1`（**清库存档允许亏**，不要收紧成 `ge=0`）；不传则两个 target 字段为 `null` |

`target_advertising_rate = breakeven_advertising_rate - target_net_margin`。
**新品域没有这两个参数**（没有 `include_anchor`、也没有 `target_net_margin`）：目标净利率
即行上已有的 `target_profit_rate`。

各路由字段差异一览：

| 路由 | 形态 |
|---|---|
| R1 / R2 / R3（店铺） | 行嵌套 `anchor`，受 `include_anchor` 与 `target_net_margin` 控制 |
| W1 店铺追加写 | **预览响应**带 `anchor`（`target_*` 为 `null` —— 不是快照字段）；确认落库后回的行同样带锚（target 仍为 `null`） |
| C1 店铺 `/compute` | `calculation` 与 `snapshot` 两块都带 `anchor`（body 收 `target_net_margin`） |
| R5 / R6 / R7（BI 扁平） | 四个平铺列（无嵌套块）；`include_anchor=false` 时四列全部省略 |
| 新品域 R1 / R2 | 行嵌套 `anchor`，target 取行上的 `target_profit_rate` |
| 新品域 C1 | `calculation` 与 `snapshot` 两块都带 `anchor` |
| 新品域 W1 | 预览不带 `anchor`（预览摘要只回 `is_new` / `previous` 影响面）；确认落库后回的行带锚（target 取行上 `target_profit_rate`） |

消费注意：

* **派生量，不落库**：读时计算，零迁移，不影响 append-only 语义。
* **不 clamp**：闭式解 ≤ 0（成本已高于售价，不花广告费也亏）原样返回负值 —— 负值本身是诊断信号。
* **`sale_price_usd == 0` → `null`**（返回 0 会被读成「广告一分不能花」）。
* **US 的 `breakeven_advertising_rate_after_vat` 是 `null`**，不是 0（避免被误读为「美国有 VAT」）。
* **锚依赖汇率而漂移**（实测同 SKU：fx 6.7894 → 29.80%，fx 6.7078 → 29.38%），
  所以必须把 `anchor`（含 `basis`）当**自包含对象**缓存与版本化。
* `return_loss_usd` 是**期望值**（`sale_price_usd × return_loss_rate`），因此锚是
  「按当前退货率假设的期望锚」，不是「零退货锚」。
* 读数派生自**该行自己的费用字段**（agent 可写）：恒等式就是行内自洽性的免费自检，
  残差超 `0.01 / price` 说明这一行的费用拆项本身不自洽。

## 3. 响应壳

成功：`{ "ok": true, "data": ..., "idempotency_key": "..." }`

失败：`{ "ok": false, "error": { "code", "reason"?, "human_message", "agent_hint", "details"? } }`

错误码（稳定，Agent 可依赖）：`AGENT_AUTH_FAILED`(401) /
`AGENT_RATE_LIMIT_EXCEEDED`(429, 附 Retry-After) / `VALIDATION_FAILED`(400) /
`RESOURCE_NOT_FOUND`(404) / `CONFIRM_TOKEN_INVALID`(400) /
`CONFIRM_TOKEN_EXPIRED`(409) / `IDEMPOTENCY_KEY_CONFLICT`(409) /
`SHIPMENT_DUPLICATE_NO`(409) / `SHIPMENT_ITEMS_INVALID_SKU`(400) /
`SHIPMENT_STATUS_INVALID`(400) / `INTERNAL_ERROR`(500)。

客诉中心身份核验（BLF-1022，均为 422，整批拒绝不落库）：
`IDENTITY_CHECK_REQUIRED`（ok 缺 verified / 非 ok 店铺带 complaints）、
`IDENTITY_CHECK_CONTRADICTION`（identity_mismatch 配 verified=true）、
`IDENTITY_CHECK_INVALID`（verified=true 但服务端重算不匹配 / 期望过期 / source 非法）、
`IDENTITY_EXPECTED_ALIAS_MISSING`（required 店铺缺 expected_alias）。
偏差说明：契约规则 8（`shops_failed` 非 `list[str]`）按全域请求体类型错误壳统一返回
400 `VALIDATION_FAILED`，身份语义错误才走 422 身份码。

## 4. curl 示例

    curl -i http://<host>/api/v1/agent/health \
      -H "Authorization: Bearer bbx_xxx" \
      -H "X-Agent-Id: shipment-assistant-prod"

## 5. 限流

读 300 req/min、写 30 req/min（按 agent_id 计，内存计数、按 worker 独立）。
超限返回 429 壳 + `Retry-After`。
