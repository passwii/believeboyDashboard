# Agent API · Shop Calculation API 实施规格（设计定稿）

> **状态**：设计定稿（BLF-439 产出；D1/D2/D3 已由用户拍板 2026-08-05），可进入 writing-plans → 开执行子 issue。
> **配套文档**：[`docs/agent-api-design.md`](../../agent-api-design.md)（设计稿 v0.4）、[`docs/superpowers/specs/2026-08-04-agent-readwrite-api-spec.md`](./2026-08-04-agent-readwrite-api-spec.md)（P0 基建 + P2 货件规格）、[`docs/superpowers/plans/2026-08-05-agent-api-p2-shipments.md`](../plans/2026-08-05-agent-api-p2-shipments.md)（P2 落地模板）。
> **范围**：在 `/api/v1/agent/projects/{id}/shop-calculations/*` 开放**店铺测算（Shop Calculation）域**的读 + 写路由。**本 spec 只设计，不实施**（对齐 BLF-439 边界）。

---

## 0. 拍板结论摘要（BLF-439 讨论清单 7 项逐一收口）

| # | 议题 | 结论 | 说明 |
|---|---|---|---|
| 1 | 写契约 A vs B | **方案 A（已拍板）** | 零后端改造；/compute 试算 + 快照 confirm 追加。方案 B 暂缓（见 §1.2） |
| 2 | 路由面定稿 | 6 条（读 4 + 写 1 + 试算 1） | 见 §2 路由表 |
| 3 | confirm 白名单 | `shop_calculation.append`（唯一写动作） | validate/preview 见 §4 |
| 4 | 权限 L2 准入 | **硬前置**：`agent_api_keys.project_scope` 启用校验 | 新增 `require_project_scope` 依赖 + 凭据页项目下拉（§6） |
| 5 | 小契约项 | source 强制枚举 / SKU 存在性校验 / `SHOP_CALCULATION_*` 错误码 | 见 §5 / §3.4 |
| 6 | 软删除策略 | **不开放给 agent**，admin only（沿用内部 `soft_delete_group`） | 不在路由表出现 |
| 7 | BEL-415/416 协同 | 读路径并入 agent 命名空间；BEL-416 `/external/*` 端点**暂缓不落**；BEL-415 写路径保持双轨（append-only 天然无冲突） | 见 §8 |

> **D1-D3 拍板记录（2026-08-05 用户确认）**：D1=**方案 A**；D2=SKU 校验按 **`(project_id, country, sku)`** 严格粒度（与货件域一致）；D3=/compute 返回 **双字段** `{calculation, snapshot}`。

---

## 1. 写契约 A/B 拍板

### 1.1 方案 A（已拍板）：compute 试算 + 快照 confirm 追加

```
Agent 流程：
  ① POST /shop-calculations/compute   （mode=profit_calc|eu_accounting，输入尺寸/成本/售价）
     → 返回 { calculation: <引擎试算结果>, snapshot: <可直接 append 的完整快照> }   [不落库]
  ② POST /shop-calculations           （body=snapshot + source + observed_at?）
     → confirm 两步 → append_calculation 落一行            [写桶限流 + 审计归因]
```

- **镜像人类 UI 两步流**：前端 `requestPricingCalculation`（quote/reverse-quote/eu-quote）→ `requestSaveShopCalculation`（快照落库）。Agent 走同一条路径，语义对齐、口径一致。
- **后端零改造**：`/compute` 直接包装现成纯计算函数 `_compute_pricing`（quote，`app/services/pricing/computation.py:37`）与 `_compute_eu_pricing`（eu-quote，`:205`）——两者均只算不写库；快照整形是路由层薄壳（镜像前端 `frontend/lib/pricing-calculation-api.ts` 的 `ShopCalculationPayload` 映射）。**service 层不动**。
- **append 复用 `shop_calculation_service.append_calculation`**（BEL-378 Phase A 已上 prod 的 append-only 语义），无迁移、无缓存失效（该域 0 个 Redis 缓存耦合，已 grep 验证）。
- **不开放 reverse-quote / fbm-quote / cost-reverse**：这些是"反推目标价/成本"的选品模式，产出的不是"当前价快照"，与 shop_calculation 的 append-only 时间序列语义不匹配。未来如需，可加 `mode=reverse_quote` 让 agent 拿到建议价后**再走一次 quote** 生成快照。

### 1.2 方案 B（暂缓，1–2 周量级）：瘦写入 + 后端补算

`POST /shop-calculations` 只收 `(sku, country, sale_price_usd, observed_at, source)`，后端补算其余 ~40 字段。**不建议现在做**，理由：

1. 补算逻辑 = 在路由层重跑 `_compute_pricing` 并把结果回填成快照——和方案 A 的 `/compute` 是**同一套代码**，只是位置不同（方案 A 把"算"暴露给 agent 自己掌控输入，方案 B 把"算"藏进写入端）；
2. 方案 B 引入"部分行"语义：`list_by_project` 的 `latest_ids_subquery` 只按 id 取最新，若存在"未补全的行"会直接污染当前态列表——需要额外定义部分行过滤规则（`snapshot_source_id` 等），复杂度不可小觑；
3. agent 需要**价格溯源**（报价来源、竞品链接、汇率时点），瘦写入会丢掉这些可审计输入，confirm 预览也无从谈起。

> 触发方案 B 的真实需求场景：若未来出现"只关心价格、不关心利润拆分"的纯价格观察类 agent（例如只做比价），可再评估。当前 BEL-415/416 与选品 agent 都需要完整快照。

---

## 2. 完整路由表（6 条）

> 统一挂 `/api/v1/agent/projects/{project_id}/shop-calculations`（router prefix），命名空间级鉴权（Bearer + X-Agent-Id + 读限流）由 `agent_router` 承担；每写路由额外挂 `require_agent_write_rate_limit`。
> **新增依赖**：每条路由（读+写）挂 `Depends(require_project_scope)` —— 见 §6（P0 遗留，硬前置）。

| # | Method | Path | 复用 service（真实函数） | confirm | 限流桶 | 审计 |
|---|---|---|---|---|---|---|
| R1 | GET | `/projects/{pid}/shop-calculations` | `shop_calculation_service.list_by_project` | ❌ | 读 | 不落 |
| R2 | GET | `/projects/{pid}/shop-calculations/skus/{sku}` | `latest_stmt()` 派生（见 §3.2） | ❌ | 读 | 不落 |
| R3 | GET | `/projects/{pid}/shop-calculations/skus/{sku}/history` | `list_history`（`?from=&to=` 过滤追加） | ❌ | 读 | 不落 |
| R4 | GET | `/projects/{pid}/shop-calculations/skus/{sku}/audit` | **新增** `query_operation_audit_log_for_targets` | ❌ | 读 | 不落 |
| W1 | POST | `/projects/{pid}/shop-calculations` | `append_calculation` | ✅ `shop_calculation.append` | 写 | 落（agent 归因） |
| C1 | POST | `/projects/{pid}/shop-calculations/compute` | `_compute_pricing` / `_compute_eu_pricing`（纯计算，不落库） | ❌ | 读 | 不落 |

**关键事实（代码已核实，2026-08-05）**：

- 自然业务键 `(project_id, sku, country)`；`accounting_type ∈ {profit_calc, eu_accounting}`；`country ∈ {US, DE, UK}`（`app/schemas/shop_calculation.py`）。
- `list_by_project` 的「当前态」= 每 `(project, sku, country)` 组最新有效行（`MAX(id)` 子查询，`deleted_at IS NULL` 过滤软删）；`list_history` 按 `observed_at DESC, id DESC` 返回全部历史。
- 审计映射：所有 agent 写操作审计行统一 `target_type="shop_calculation"`、`target_id=<row.id>`（数字 id）；`created_by` 保持 NULL（agent 归因走 `operation_audit_logs.agent_id`，与货件域一致）。
- 该域 **0 个 Redis 缓存**（写后无需失效；与货件域 7 个缓存形成对照）。
- `/compute` 的引擎纯计算函数已在仓库存在且不写库（`_compute_pricing` 被 recalculate 端点复用）；EU 侧 `_compute_eu_pricing` 同。

---

## 3. 请求 / 响应 schema 草案

### 3.1 追加写请求 `AgentShopCalculationAppendRequest`

字段 = 内部 `ShopCalculationCreateRequest`（`app/schemas/shop_calculation.py`）的**全部快照字段**，减去 3 个服务端派生项：

| 移除字段 | 服务端派生规则 |
|---|---|
| `project_id` | 从路径 `{project_id}` 解析（路由层填充） |
| `project_name` | 从 Project 行读取（路由层填充；不存在 → 404 `RESOURCE_NOT_FOUND`） |
| `created_by` | 不传（保持 NULL；agent 归因走审计） |

新增/收紧：

```python
class AgentShopCalculationAppendRequest(BaseModel):
    # ...全部快照字段（镜像 ShopCalculationCreateRequest 的 45 字段）...

    source: Literal["agent_listing_pull", "agent_review_scrape",
                    "agent_market_research", "external_api"]  # 必填，无默认（validate 回调卡死）
    observed_at: datetime | None = None   # 补录历史价用；缺省后端取 now()
    notes: str | None = None              # 可选备注
```

> `source` 枚举说明：`manual` 是人手入口（内部端点默认），**agent 通道不允许填 manual**——审计溯源要求 agent 写入必须声明采集渠道。BEL-415（Mac Paseo listing 拉取）用 `agent_listing_pull`，与本枚举兼容。

### 3.2 SKU 详情 R2 的 country 消歧规则

`GET .../skus/{sku}`：

- `?country=` 提供 → 返回该 `(project, sku, country)` 最新有效行；无 → 404 `RESOURCE_NOT_FOUND`。
- `?country=` 缺省 → 查询该 `(project, sku)` 全部国家的当前行：
  - 恰好 1 个国家存在 → 直接返回（agent 最顺滑路径）；
  - 多个国家存在 → **400 `SHOP_CALCULATION_AMBIGUOUS_COUNTRY`**，`details: [{country: "US"}, {country: "DE"}]`，agent_hint 提示带 `?country=` 重试。

响应体 = `ShopCalculationItem` 同构（扁平 + 嵌套 dimensions/weights/fees/profit）。

### 3.3 历史 R3 查询参数

`GET .../skus/{sku}/history?country=&from=&to=&limit=&offset=`

| 参数 | 说明 |
|---|---|
| `country` | 可选；缺省同 R2 消歧规则 |
| `from` / `to` | 可选 ISO 日期/时间，过滤 `observed_at` 区间（含边界） |
| `limit` | 默认 50，`1..200` |
| `offset` | 默认 0 |

> 内部 `list_history` 目前返回全量 list——路由层需按参数追加过滤/分页（薄壳）。返回 `{items: [...], total}`（total=未分页前条数，一次 count 查询）。

### 3.4 试算 C1 请求 / 响应

```python
class AgentShopCalculationComputeRequest(BaseModel):
    mode: Literal["profit_calc", "eu_accounting"]
    # profit_calc → 镜像 PricingCalculationCreateRequest（country=US）
    # eu_accounting → 镜像 PricingCalculationEURequest（country=DE|UK，含 delivery/inbound_config/storage 手动费）
    product_name: str = Field(min_length=1, max_length=255)   # 引擎必填（可传 sku 本身）
    sku: str | None = None
    package_length_cm: float; package_width_cm: float; package_height_cm: float; weight_kg: float
    fob_product_cost_rmb: float; first_leg_cost_rmb: float
    sale_price_usd: float
    advertising_rate: float = 0.12; return_loss_rate: float = 0.04; storage_months: float = 1
    inbound_placement_mode: InboundPlacementMode = "single_destination"
    usd_to_rmb_rate: float | None = None
    commission_rate: float = 0.15
    # EU 专属（mode=eu_accounting 时必填/可空按引擎）
    delivery_fee_usd: float = 0; inbound_config_fee_usd: float = 0; storage_fee_usd: float = 0
```

响应：

```json
{
  "ok": true,
  "data": {
    "mode": "profit_calc",
    "calculation": { /* PricingCalculationRunItem 同构：size_tier/fees/profit/dimensions/weights/warnings */ },
    "snapshot": { /* AgentShopCalculationAppendRequest 同构（含 source 占位 None + observed_at None），可直接 POST W1 */ },
    "usd_to_rmb_rate": 7.18,
    "usd_to_rmb_rate_source": "x-rates"
  }
}
```

- `snapshot` 由路由层薄壳整形（镜像前端映射：`profit.ddp_cost_rmb → ddp_cost_rmb`、`fees.platform_fee_usd → platform_fee_usd`、EU 三费映射等——实施时以 `frontend/lib/pricing-calculation-api.ts` `ShopCalculationPayload` 为准逐字段对照）。
- 引擎 `ValueError` → 400 `VALIDATION_FAILED`（details 带引擎消息；内部端点现为 422，agent 通道统一 400 壳，对齐 `errors.py` 映射表）。
- 不落审计、不落库、无 confirm（纯计算，读桶）。

---

## 4. confirm 流与白名单（W1）

### 4.1 动作注册

| action | 路由 | validate 回调 | preview 回调 |
|---|---|---|---|
| `shop_calculation.append` | POST `/shop-calculations` | `_validate_append` | `_preview_append` |

### 4.2 `_validate_append`（业务校验，先于 confirm，短路不生成 token）

1. `source ∈ {agent_listing_pull, agent_review_scrape, agent_market_research, external_api}` → 否则 400 `SHOP_CALCULATION_INVALID_SOURCE`；
2. **SKU 存在性校验**（D2 拍板：按 `(project_id, country, sku)` 严格粒度，与货件域 `_find_missing_skus` 完全一致）：`select SkuRecord.sku where project_id == {pid} and country == body.country and sku == body.sku`，不存在 → 400 `SHOP_CALCULATION_INVALID_SKU`，`details: [{sku, reason: "not_found"}]`，agent_hint 提示先建 SKU 主数据（sku-info 相关端点）；
3. `observed_at` 若提供：不晚于 now()+24h（容忍时区偏差），否则 400 `VALIDATION_FAILED`；
4. `sale_price_usd` 与 `total_fee_usd` 必须为正；`profit_usd` 和 `profit_rate` 不要求为正（允许零值和负值），`profit_rate` 仍须小于 1 → 保留真实亏损经营结果，同时防止售价和费用结构无效。

> SKU 校验粒度决策点（见 §9 D2）：默认按 `(project_id, sku)` 国别无关校验（SKU 主数据可能只登记 US 而 agent 补 DE 价格）；若实施时希望严格按 `(project_id, country, sku)`（与货件域完全一致），改动只有一处查询条件。

### 4.3 `_preview_append`（confirm 预览摘要）

```json
{
  "action": "shop_calculation.append",
  "sku": "X-001",
  "country": "US",
  "accounting_type": "profit_calc",
  "source": "agent_listing_pull",
  "sale_price_usd": 19.99,
  "profit_usd": 4.32,
  "profit_rate": 0.216,
  "observed_at": "2026-08-05T09:00:00Z",
  "overwrites_current": true,
  "previous_sale_price_usd": 18.5,
  "warnings_count": 1,
  "note": "将新增一条当前快照（append-only 保留历史）；该 SKU 已有当前价 18.5，追加后当前态变为 19.99"
}
```

- `overwrites_current` / `previous_sale_price_usd`：预览时查 `latest_stmt()` 是否存在 `(project, sku, country)` 当前行——这是 append 语义下 agent 最需要知道的"影响面"信息。
- confirm 协议细节（token 存储/过期/body-hash 绑定/幂等冲突）沿用 `app/api/agent/confirm.py`（P2 已原子化 + `(body, request)` 签名），**零改动复用**。

---

## 5. 错误码注册（`app/api/agent/errors.py` 追加）

```python
# 店铺测算域（BLF-439）
SHOP_CALCULATION_INVALID_SOURCE = "SHOP_CALCULATION_INVALID_SOURCE"      # 400
SHOP_CALCULATION_INVALID_SKU = "SHOP_CALCULATION_INVALID_SKU"            # 400
SHOP_CALCULATION_AMBIGUOUS_COUNTRY = "SHOP_CALCULATION_AMBIGUOUS_COUNTRY"  # 400
```

| code | HTTP | 默认 human_message | 默认 agent_hint |
|---|---|---|---|
| `SHOP_CALCULATION_INVALID_SOURCE` | 400 | 写入来源不合法 | 合法来源：agent_listing_pull、agent_review_scrape、agent_market_research、external_api |
| `SHOP_CALCULATION_INVALID_SKU` | 400 | 该 SKU 在本项目不存在 | 先核对 SKU 主数据（sku-info 相关端点），确认后再追加 |
| `SHOP_CALCULATION_AMBIGUOUS_COUNTRY` | 400 | 该 SKU 存在多个国家站点，需指定 country | 用 details 里的国家列表带 ?country= 重试 |

复用既有：`RESOURCE_NOT_FOUND`（404）、`VALIDATION_FAILED`（400，引擎/参数错误）、`CONFIRM_TOKEN_*` / `IDEMPOTENCY_KEY_CONFLICT`（confirm 流）、`AGENT_PROJECT_OUT_OF_SCOPE`（403，§6）。`_HTTP_STATUS` / `_DEFAULTS` 两表同步注册。

---

## 6. 权限矩阵（L2 准入 = 硬前置）

### 6.1 现状缺口

- `agent_api_keys.project_scope` 列已存在（迁移已上 prod，`server_default="*"`），但 **P0 明确不做 scope 校验**（spec 2026-08-04 §9："scope/权限细分：明确不做"）。
- `require_agent_credential` 只注入 `request.state.agent_id` / `agent_api_key_id`，未暴露 key 行。
- 凭据管理页（`/dashboard/system/agent-management`）创建表单无项目选择。

### 6.2 本 spec 引入（执行子 issue 的 Task 0，必须先于店铺域路由合入）

1. **新依赖** `require_project_scope(project_id: int)`（`app/api/agent/scope.py`）：
   - 从 `request.state.agent_api_key_id` 查 key 行取 `project_scope`；
   - `project_scope == "*"` → 放行（存量 key 兼容，行为不变）；
   - 否则按 `,` 分隔的 project_id 白名单校验，不在 → **403 `AGENT_PROJECT_OUT_OF_SCOPE`**（`errors.py` 已有 code + 映射）。
2. **路由级挂载**：店铺域所有路由（读 R1-R4 + 写 W1 + 试算 C1）都挂 `Depends(require_project_scope)`；货件域路由暂不挂（避免范围蔓延，P2 已上线不动）。
3. **前端**：`agent-management` 创建表单加"项目范围"多选（空 = 全项目 `*`）；`/api/v1/internal/api-keys` 创建/列表透传 `project_scope`（admin）。
4. **key_service**：`create_api_key` 支持 `project_scope` 参数（默认 `"*"`）；`list_agent_keys` 返回该字段。

> 为什么是硬前置：店铺测算写入直接改变经营数据（售价/利润快照），若无项目隔离，任何拿到凭据的 agent 可写任意项目。货件域先上线（P2）可接受无 scope（白名单 key + 人工发放），店铺域写入前必须补上。

### 6.3 完整权限矩阵

| 能力 | 人类用户（内部端点） | Agent（`/agent/*`） | 备注 |
|---|---|---|---|
| 读当前态/历史 | ✅ | ✅（受 project_scope 限制） | |
| 试算（不落库） | ✅ quote 等 | ✅ C1 | |
| 追加快照 | ✅（operator 归因，source=manual） | ✅ W1（source 枚举 + confirm + 审计归因） | BEL-415 走内部端点 source=agent_listing_pull 双轨兼容 |
| 软删除组 | ✅ `DELETE /shop-calculation/{id}` | ❌ 不开放 | admin only（沿用内部端点，`get_request_is_admin` 由既有守卫承担） |
| 审计查询 | 内部 audit 中间件 | ✅ R4（只读自己的写入痕迹 + 人类操作痕迹） | |

---

## 7. 测试清单（供执行子 issue）

| 文件 | 覆盖 |
|---|---|
| `backend/tests/api/agent/test_shop_calc_read.py` | R1 列表/过滤 + 读不落审计；R2 详情 + country 消歧（唯一→直接返回、多国→400 AMBIGUOUS）；R3 历史 + from/to/limit；跨项目 404 壳 |
| `backend/tests/api/agent/test_shop_calc_confirm.py` | W1 预览（overwrites_current 两种分支）→ confirm → append 落行 + 审计归因；S6 式 SKU 不存在 400；source 非法 400；confirm 过期/body 变更 |
| `backend/tests/api/agent/test_shop_calc_compute.py` | C1 profit_calc 与 eu_accounting 两模式；不落库断言（pricing_calculation_run 行数不变）；引擎 ValueError → 400 VALIDATION_FAILED；snapshot 字段与 append 请求兼容 |
| `backend/tests/api/agent/test_shop_calc_audit.py` | R4 按 SKU 聚合多行 target_id 审计 |
| `backend/tests/api/agent/test_project_scope.py` | `*` 放行 / 白名单命中 / 未命中 403 AGENT_PROJECT_OUT_OF_SCOPE（读+写都测） |
| `backend/tests/services/test_audit_log_for_targets.py` | `query_operation_audit_log_for_targets` 新函数（IN 子句 + limit + 倒序） |
| 前端 | `frontend/tests/crawl/agent-management.spec.ts` 追加项目范围多选 |

运行顺序（AGENTS.md 约定）：`cd backend && pytest -q tests/api/agent tests/services/test_audit_log_for_targets.py` → 全量无新增失败 → `cd frontend && pnpm lint && pnpm build && pnpm test`。

---

## 8. 与 BEL-415 / BEL-416 的协同（避免双挂期）

### 8.1 BEL-416（External API 读暴露）—— **暂缓，读路径并入本 spec**

- BEL-416 规划的 4 个 `/external/*` 端点（`shop-calculation-history` / `shop-calculation/snapshots` / `pricing-snapshots?as_of=` / `new-product-calculations`）与本 spec R1-R3 **功能重叠**。
- 父 issue BEL-437 结论：**读路径合并进 agent 命名空间，不另开无鉴权的 `/external/*` 双挂**。理由：同一份数据两个口径（鉴权/无鉴权）会造成消费者混淆，且 `/external/*` 无鉴权是遗留风险。
- 处置：BEL-416 状态改为 blocked（等待本 spec 执行子 issue 落地 R1-R4 后，由其覆盖；`new-product-calculations` 单独评估是否需要并入 agent 命名空间，不在本 spec 范围）。

### 8.2 BEL-415（Mac Paseo agent 写入）—— 双轨兼容，无冲突

- BEL-415 走内部端点 `POST /api/v1/shop-calculation`（`source=agent_listing_pull` + `observed_at`），与本 spec W1 同写一张 append-only 表。
- **append-only 语义天然无冲突**：两者各落各的行，`source` 可区分；唯一注意点是 BEL-415 不校验 SKU 主数据——若其写入的 SKU 不在 `sku_info`，W1 路径下会被 `SHOP_CALCULATION_INVALID_SKU` 拦截，但 BEL-415 不受影响（互不干扰）。
- 中期迁移：BEL-415 的抓取 agent 可切到 `/agent/*` 命名空间（拿到凭据 + project_scope），利用 W1 的 confirm 与审计能力；切换时点由 BEL-415 自行安排，不在本 spec 强约束。

---

## 9. 决策记录（D1-D3 已拍板，2026-08-05）

| # | 决策点 | 拍板结论 | 实施影响 |
|---|---|---|---|
| D1 | 写契约 A vs B | **A**（compute 试算 + 快照 confirm 追加） | §1.2 / §3.1 / C1 按 A 定稿 |
| D2 | SKU 校验粒度 | **`(project_id, country, sku)` 严格粒度**（与货件域一致） | §4.2 validate 回调按此查询；SKU 主数据缺失对应国家行时 append 会 400，agent 需先补主数据 |
| D3 | `/compute` 返回形态 | **双字段** `{calculation, snapshot}` | §3.4 响应定格；snapshot 直接可 confirm，agent 零字段映射 |

---

## 10. 执行前置（writing-plans 前确认）

- [x] D1/D2/D3 用户拍板（2026-08-05 BLF-439 评论：A / (project,country,sku) / 双字段）
- [ ] Task 0：project_scope 校验依赖 + 前端项目下拉（§6.2，独立小任务可先开）
- [ ] BEL-416 状态处理（blocked + 备注指向本 spec）
- [ ] 仓库当前 main 已含 P2（`agent/shipments.py` 在 main，2026-08-05 merge 后）——本 spec 引用均为真实函数名

---

## 修订记录

- **v0.2（2026-08-05）**：D1-D3 用户拍板落定——D1=方案 A、D2=SKU 校验按 `(project_id, country, sku)` 严格粒度、D3=/compute 双字段返回；§0/§4.2/§9/§10 同步；spec 状态改为「设计定稿」。
- **v0.1（2026-08-05）**：BLF-439 讨论清单 7 项收口 + 完整 spec 草案初稿。关键代码事实核实：`_compute_pricing`/`_compute_eu_pricing` 纯计算不落库；`list_by_project`/`list_history`/`append_calculation` 签名；`agent_api_key.project_scope` 列已存在但未启用校验；P2 confirm/rate_limit/errors 基建可零改动复用。
