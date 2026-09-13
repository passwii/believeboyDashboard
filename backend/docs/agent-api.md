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
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/audit
    POST   /api/v1/agent/projects/{project_id}/shipments                      （confirm）
    PATCH  /api/v1/agent/projects/{project_id}/shipments/{shipment_no}        （confirm）
    PUT    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/items  （confirm）
    POST   /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/status （confirm）
    POST   /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/recalculate-costs （confirm）

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
    POST   /api/v1/agent/projects/{project_id}/shop-calculations                 （confirm）
    POST   /api/v1/agent/projects/{project_id}/shop-calculations/compute
    GET    /api/v1/agent/projects/{project_id}/shop-calculation-history          （BI 扁平）
    GET    /api/v1/agent/projects/{project_id}/shop-calculation/snapshots        （BI 扁平）
    GET    /api/v1/agent/projects/{project_id}/pricing-snapshots                 （BI 扁平）
    GET/POST /api/v1/agent/projects/{project_id}/new-product-calculations*       （同款派生）

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

富契约（`shop-calculations*`、`new-product-calculations*`、`/compute` 的
`calculation` 与 `snapshot`）挂嵌套块 `anchor`；BI 扁平契约
（`shop-calculation-history`、`shop-calculation/snapshots`、`pricing-snapshots`）
没有费用拆项，改为**显式补三列**（服务端推）：`breakeven_advertising_rate` /
`max_ad_spend_per_unit_usd` / `target_advertising_rate`。

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
| `include_anchor` | Query（富契约读路由） | `true` | `false` 时响应与旧版**逐字节一致**（键消失，不是置 null） |
| `target_net_margin` | Query（读数、BI 扁平、`pricing-snapshots`）/ body（`/compute`） | 不传 | 目标净利率，校验 `ge=-1, le=1`（**清库存档允许亏**，不要收紧成 `ge=0`）；不传则两个 target 字段为 `null` |

`target_advertising_rate = breakeven_advertising_rate - target_net_margin`。
新品域没有独立参数：目标净利率即行上的 `target_profit_rate`。

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
