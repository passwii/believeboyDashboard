# Agent API · New Product Calculation（新品测算）API 实施规格（设计草案）

> **状态**：**必要元素已定稿**（用户拍板 2026-08-06：4 种模式确认、`eu_accounting` 暂不纳入新品）；**API 讨论进行中**（① 路由骨架已确认，D3/D1/D2b/D4 待讨论；收敛后转定稿 → 开执行子 issue）。
> **配套文档**：[`docs/agent-api-design.md`](../../agent-api-design.md)（设计稿 v0.4）、[`docs/superpowers/specs/2026-08-05-agent-shop-calculation-api.md`](./2026-08-05-agent-shop-calculation-api.md)（店铺测算 spec 定稿，本 spec 的模板）、[`docs/superpowers/specs/2026-08-04-agent-readwrite-api-spec.md`](./2026-08-04-agent-readwrite-api-spec.md)（P0 基建 + P2 货件规格）、[`docs/external-api-ops-agent-roadmap.md`](../../external-api-ops-agent-roadmap.md)（全景图）。
> **范围**：在 `/api/v1/agent/projects/{id}/new-product-calculations/*` 开放**新品测算（New Product Calculation）域**的读 + 写路由。**本 spec 只设计，不实施**（对齐 BLF-451 执行顺序：先定必要元素与 API 文档，再实施）。
> **前提**：店铺测算域 6 路由（commit `90e2ee8f`）与 `project_scope` 准入（commit `d5241993`）**已合入 main**——新品域路由可直接复用 `require_project_scope` / confirm / 限流 / 响应壳 / `query_operation_audit_log_for_targets`，**无 Task 0 前置**。

---

## 0. 结论摘要

### 0.1 两个前置 issue 的 review 结论

- **BLF-449（第一期经验总结，已交付）**：shipment + shop calculation 两个域的成功经验已沉淀——方法论（设计先行、P0/P2 分阶段、模板化复制、复用既有基建、服务端最窄契约）+ 调用逻辑（Bearer+X-Agent-Id 鉴权、读写分离、confirm 两步、幂等与限流、统一响应壳、前端凭据闭环）+ 9 条可提炼经验（slowapi 去重坑、命名空间兜底路由、fail-closed、审计归因简洁、错误码注册表纪律等）。
- **BLF-439（店铺测算 spec，已定稿 + 已实施）**：6 路由（读 4 + 写 1 + 试算 1）拍板为方案 A（compute 试算 + 快照 confirm 追加）、SKU 校验按 `(project_id, country, sku)` 严格粒度、/compute 双字段返回。**执行子 issue BLF-441（project_scope）/ BLF-442（店铺域路由）均已合入 main**，agent 基建全就绪。
- **新品测算 = 第 3 个域**，与店铺测算**同引擎、不同存储语义**（见 §1.3），不能照抄路由面，需按本 spec 重新设计。

### 0.2 新品测算的多种测算模式（代码核实，2026-08-06）

**前端「新品测算」页暴露 4 种模式**（`new-product-client.tsx` `CALCULATION_MODE_ORDER`）：

| 模式 | calculation_type | 中文名 | 引擎端点（纯计算，不落库） | 输入要素核心 | 输出 |
|---|---|---|---|---|---|
| 正测算 | `profit_calc` | 利润核算 | `quote`（`_compute_pricing`，`computation.py:37`） | 售价 | 利润拆分 |
| 倒测算 | `profit_reverse` | 利润倒算 | `reverse-quote`（`reverse.py:_solve_sale_price_for_profit_rate`） | 目标利润率 | **建议售价** |
| 成本倒算 | `cost_reverse` | 成本倒推 | `reverse-cost`（`cost_reverse.py:_solve_fob_cost_for_profit_rate`） | 售价 + 目标利润率 | **最大可接受 FOB 成本** |
| 自发货 | `fbm_calc` | FBM测算 | `fbm-quote`（`fbm.py:_compute_fbm_pricing`） | 售价 + 整柜成本 + 派送费 | FBM 利润拆分 |

**引擎另有第 5 种**：`eu_accounting`（欧洲核算）——`eu-quote`（`computation.py:_compute_eu_pricing`），带 VAT / 手动三费，**店铺测算页的 EU 区块在用**（`shop-calculation-eu-section.tsx`），新品页未暴露。

> **用户拍板（2026-08-06）**：4 种模式确认无误；**`eu_accounting`（欧洲测算）暂不纳入新品域**——本 spec 范围 = 4 种模式，EU 留在店铺测算域，后续如需再单独评估。

### 0.3 与店铺测算的关键差异（决定路由面形态）

| 维度 | 店铺测算 shop_calculation | 新品测算 new_product_calculations |
|---|---|---|
| 存储语义 | **append-only**（每次快照新增一行，历史保留） | **upsert**（`(project_id, sku, calculation_type)` 唯一键，只留最新一行，**无历史**） |
| 溯源列 | 有 `source` / `observed_at` / `deleted_at` | **无** `source` / `observed_at` / `deleted_at`（溯源仅靠审计表） |
| 快照可存类型 | `{profit_calc, eu_accounting}` | schema Literal 含 `{profit_calc, profit_reverse}`（EU 不纳入新品）；`cost_reverse`/`fbm_calc` 目前仅试算、是否可存快照 → API 讨论阶段定 |
| 缓存耦合 | 0 个 Redis | 0 个 Redis（无写后失效） |
| external 端点 | BEL-416 规划中，**暂缓未落** | `GET /external/projects/{pid}/new-product-calculations` **已上线**（BEL-378/416，无鉴权 P0 契约） |

---

## 1. 新品测算现状（代码核实，2026-08-06）

### 1.1 前端

- 页面：`frontend/app/dashboard/reports/pricing-calculation/new-product/new-product-client.tsx`（`PricingCalculationPage`）
- 4 模式 Tab（`CALCULATION_MODE_ORDER`），模式路由：`profit-reverse → /reverse-quote`、`cost-reverse → /reverse-cost`、`fbm-calc → /fbm-quote`、其余 → `/quote`（`requestPricingCalculation` :3153）
- 保存快照：`requestSaveStoreSkuSnapshot` :575（POST `/api/v1/new-product-calculations`，全字段 ~50 项）；`buildSnapshotPayload` :473 只支持 `profit-calc | profit-reverse` 两种落库
- 模式徽标（`getCalculationTypeMeta` :706）：利润核算 / 利润倒算 / 成本倒推 / FBM测算

### 1.2 后端引擎（纯计算、不写库，均可直接包装）

| 函数 | 位置 | 输入 schema | 输出 |
|---|---|---|---|
| `_compute_pricing` | `app/services/pricing/computation.py:37` | `PricingCalculationCreateRequest` | run 同构（size_tier/fees/profit/dimensions/weights/warnings） |
| `_solve_sale_price_for_profit_rate` | `app/services/pricing/reverse.py:12` | `PricingCalculationReverseRequest`（`target_profit_rate` 默认 0.25，无 `sale_price_usd`） | 同构 + **sale_price_usd 由目标利润率反解** |
| `_solve_fob_cost_for_profit_rate` | `app/services/pricing/cost_reverse.py:12` | `PricingCalculationCostReverseRequest`（**无 `fob_product_cost_rmb`**，有售价 + 目标利润率） | 同构 + **fob_product_cost_rmb 为最大可接受成本** |
| `_compute_fbm_pricing` | `app/services/pricing/fbm.py:33` | `PricingCalculationFbmRequest`（整柜数量/价格 + 派送费） | 同构（FBM 头程 = 整柜价/数量，前端算好传入） |
| `_compute_eu_pricing` | `app/services/pricing/computation.py:205` | `PricingCalculationEURequest`（DE/UK，手动三费） | 同构（含 VAT / profit_after_vat）；**店铺测算域在用，新品不纳入**（用户拍板） |

内部端点：`POST /api/v1/pricing-calculation/{quote,reverse-quote,reverse-cost,fbm-quote,eu-quote}`（`pricing_calculation.py`），试算同时落一条 `pricing_calculation_runs`。

### 1.3 数据层

- 表 `new_product_calculations`（迁移 230，由 `store_sku_pricing_snapshots` 改名）：**upsert 策略**，`(project_id, sku, calculation_type)` 唯一键（`new_product_calculation_service.upsert_snapshot` :108），`country` 是**元数据**（不在唯一键内，每次 upsert 会覆盖 `existing.country`）
- 服务：`upsert_snapshot` / `list_snapshots`（project_id / calculation_type / country 过滤 + 分页）/ `get_snapshot(project_id, sku, calculation_type)` / `delete_snapshot`
- 内部 API（`app/api/v1/endpoints/new_product_calculations.py`）：GET 列表 / GET `/{project_id}/{sku}?calculation_type=` / POST upsert（审计 `pricing_calculation.new_product_calculation.upsert`）/ DELETE `/{snapshot_id}`
- external 端点（`app/api/v1/endpoints/external/new_product_calculations.py`）：`GET /external/projects/{pid}/new-product-calculations` **已上线**，无鉴权（P0 契约），14 平铺列（ROW_WHITELIST 过滤 `created_by`/`warnings_json`/费用规则标签），`?calculation_type=&country=&order_by=&page=` 过滤排序分页

### 1.4 Agent 基建（已就绪，直接复用）

- `require_project_scope(project_id)`（`app/api/agent/scope.py:46`）——已合入 main，`*` 放行 / 白名单校验 / 越权 403 `AGENT_PROJECT_OUT_OF_SCOPE`
- confirm 两步（`app/api/agent/confirm.py`，原子 pop + body-hash 绑定 + TTL）、写/读限流桶（300/30 每分）、响应壳 `{ok,data|error}`、`query_operation_audit_log_for_targets`（`audit_log_service.py:188`）、错误码注册表（`app/api/agent/errors.py`，已含 `SHOP_CALCULATION_*`）

---

## 2. 测算的必要元素（**定稿**：用户拍板 2026-08-06，4 模式，EU 不纳入）

所有 4 种模式共享同一套元素骨架，按**所有权**分 6 层：

| 层 | 元素 | 必填性 | 说明 |
|---|---|---|---|
| ① 定位层 | `project_id`（路径）、`sku`、`country`、`product_name`、`asin?` | 前 4 必填（引擎要求 `product_name`，可传 sku 本身） | 主数据寻址 + SKU 校验依据 |
| ② 物理规格层 | `package_length_cm` / `package_width_cm` / `package_height_cm` / `weight_kg` | **全模式必填** | 决定 `size_tier`（尺寸等级）与 `chargeable_weight`（计费重量）——所有模式的公共硬前置 |
| ③ 成本层 | `fob_product_cost_rmb`、`first_leg_cost_rmb` | 见模式矩阵 | `cost_reverse` 模式 **FOB 成本是输出**（最大可接受成本）而非输入；头程可换 `first_leg_unit_price_rmb` 或 `use_historical_shipping_cost`（历史加权） |
| ④ 销售参数层 | `sale_price_usd`、`target_profit_rate` | 见模式矩阵 | `profit_reverse` 模式 **售价是输出**（建议售价）；`target_profit_rate` 仅倒算/成本倒算用 |
| ⑤ 费率默认组 | `commission_rate`(0.15)、`advertising_rate`(0.12)、`return_loss_rate`(0.04)、`storage_months`(1)、`inbound_placement_mode`(single_destination)、`usd_to_rmb_rate`(缺省实时汇率) | 全部可选（缺省用默认） | Agent 不传即用引擎默认，**不是沿用上一期**（当前引擎为无状态，无基线继承——若需要"只改价格重算"，属店铺域 B 选项的增强点，不在本 spec 范围） |
| ⑥ 模式专属 | FBM：`full_container_quantity` / `full_container_price_rmb` / `delivery_fee_usd` | FBM 模式必填/可填 | FBM 头程 = 整柜价 ÷ 整柜数量（前端算好传入）；EU 三费属店铺测算域，不纳入新品 |

### 模式 × 必要元素矩阵

| 元素 | profit_calc | profit_reverse | cost_reverse | fbm_calc |
|---|---|---|---|---|
| ① 定位层 | ✅ | ✅ | ✅ | ✅ |
| ② 物理规格层 | ✅ | ✅ | ✅ | ✅ |
| ③ `fob_product_cost_rmb` | ✅ 输入 | ✅ 输入 | 🔄 **输出** | ✅ 输入 |
| ③ `first_leg_cost_rmb` | ✅ | ✅ | ✅ | 🔄 整柜分摊 |
| ④ `sale_price_usd` | ✅ 输入 | 🔄 **输出** | ✅ 输入 | ✅ 输入 |
| ④ `target_profit_rate` | — | ✅ | ✅ | — |
| ⑤ 费率默认组 | 可选 | 可选 | 可选 | 可选 |
| ⑥ 模式专属 | — | — | — | 整柜 + 派送费 |

> **派生层**（`size_tier` / `price_band` / `dimensions` / `weights` / `fees` / `profit` / `warnings`，约 45 字段）一律为**引擎产物，Agent 不可提供**——这就是"试算"与"快照"的分界线。

---

## 3. Agent API 分类（基于必要元素）

按**元素所有权 + 写语义**把新品测算域拆成 3 个 API 家族：

| 家族 | 端点 | 元素角色 | 语义 | confirm | 限流 | 审计 |
|---|---|---|---|---|---|---|
| **F1 试算**（算） | `POST /compute` | 输入 = 必要元素（按 mode 矩阵）；输出 = 完整派生快照 | 无状态纯计算，**不落库**（引擎函数现成，零改造） | ❌ | 读 | 不落 |
| **F2 快照读**（存） | `GET` 列表 / `GET .../skus/{sku}` / `GET .../skus/{sku}/audit` | 读取已保存快照 + 审计痕迹 | 当前态（upsert 表无历史） | ❌ | 读 | 不落 |
| **F3 快照写**（记） | `POST`（upsert） | 输入 = F1 产出的 snapshot + 溯源（D1 待拍板） | **upsert**：`(project, sku, calculation_type)` 覆盖当前行 | ✅ | 写 | 落（agent 归因） |

**分类理由**：

1. **算 / 存 / 记三分**与店铺域（compute / read / append）同构，但 F3 写语义是 **upsert 而非 append**——新品测算定位是"规划/选品决策"，每次核算只关心最新结果，覆盖旧值（`(project, sku, calculation_type)` 唯一键）；店铺域是"价格时间序列"，必须保留历史。
2. **模式差异只体现在 F1**：4 种模式共享同一元素骨架，差异仅是 ③④⑥ 层的必填/输出互换 → 用一个 `mode` 判别参数的 `/compute` 覆盖全部模式，**不按模式拆端点**（Agent 提示词只需记一个端点 + mode 枚举）。
3. **F2 不做 history**：upsert 表无历史，`pricing_calculation_runs`（试算记录）属内部表，不向 agent 暴露（对齐店铺域"读路径只查快照表"的边界）；如未来要"SKU 全历史聚合"，单独评估（店铺域 spec §8.1 已预留该议题）。
4. **软删除不开放**：`DELETE` 沿用内部端点（admin only），不进路由表。

---

## 4. 完整路由表（5 条）

> 统一挂 `/api/v1/agent/projects/{project_id}/new-product-calculations`（router prefix），命名空间级鉴权（Bearer + X-Agent-Id + 读限流）由 `agent_router` 承担；写路由额外挂 `require_agent_write_rate_limit`。
> **全部路由（读+写）挂 `Depends(require_project_scope)`**（已合入，直接复用）。

| # | Method | Path | 复用 service | confirm | 限流桶 | 审计 |
|---|---|---|---|---|---|---|
| R1 | GET | `/projects/{pid}/new-product-calculations` | `new_product_calculation_service.list_snapshots`（calculation_type / country 过滤 + 分页） | ❌ | 读 | 不落 |
| R2 | GET | `/projects/{pid}/new-product-calculations/skus/{sku}` | `get_snapshot`（`?calculation_type=`，默认 profit_calc） | ❌ | 读 | 不落 |
| R3 | GET | `/projects/{pid}/new-product-calculations/skus/{sku}/audit` | **复用** `query_operation_audit_log_for_targets` | ❌ | 读 | 不落 |
| W1 | POST | `/projects/{pid}/new-product-calculations` | `upsert_snapshot` | ✅ `new_product_calculation.upsert` | 写 | 落（agent 归因） |
| C1 | POST | `/projects/{pid}/new-product-calculations/compute` | 4 个引擎纯计算函数（EU 不纳入；不落库） | ❌ | 读 | 不落 |

**关键事实（代码已核实，2026-08-06）**：

- 自然业务键 `(project_id, sku, calculation_type)`；`country` 为元数据（不在唯一键）；`calculation_type` 可存 `{profit_calc, profit_reverse}`（EU 不纳入新品；`cost_reverse`/`fbm_calc` 是否可存快照 → API 讨论阶段定）。
- `list_snapshots` 现为 `updated_at DESC, id DESC` + 分页（page_size ≤ 500）；R1 薄壳透传过滤参数，返回 `{items, total, page, page_size}`。
- 审计映射：写操作审计行 `target_type="new_product_calculation"`、`target_id=<row.id>`（数字 id）、`agent_id`/`idempotency_key` 归因、`operator=NULL`；`created_by` 保持 NULL。R3 按 SKU 聚合：先查该 `(project, sku, calculation_type)` 当前行 id 再查审计——**`_update_snapshot` 是原地更新（行 id 稳定），该 id 的审计行即该键的全部 upsert 痕迹（含每次覆盖），R3 可完整追溯**（2026-08-06 代码核实，修正 v0.1 的悲观假设）。
- 该域 **0 个 Redis 缓存**（写后无需失效，与店铺域一致）。
- `/compute` 引擎纯计算函数已在仓库且不写库（`_compute_pricing` / `_solve_sale_price_for_profit_rate` / `_solve_fob_cost_for_profit_rate` / `_compute_fbm_pricing` 4 个均只算不写；内部试算端点额外落 run，agent 通道**不落 run**，与店铺域 C1 一致）。

---

## 5. 请求 / 响应 schema 草案

### 5.1 W1 写请求 `AgentNewProductCalculationUpsertRequest`

字段 = 内部 `NewProductCalculationCreateRequest` 的**全部快照字段**（~50 项：定位/规格/成本/销售参数/费率/尺寸等级/尺寸重量详情/费用规则标签/费用明细/利润明细/warnings），减去 3 个服务端派生项 + 溯源（D1 待拍板）：

| 移除字段 | 服务端派生规则 |
|---|---|
| `project_id` | 从路径 `{project_id}` 解析（路由层填充） |
| `project_name` | 从 Project 行读取（路由层填充；不存在 → 404 `RESOURCE_NOT_FOUND`） |
| `created_by` | 不传（保持 NULL；agent 归因走审计） |

```python
class AgentNewProductCalculationUpsertRequest(BaseModel):
    # ...全部快照字段（镜像 NewProductCalculationCreateRequest）...
    # D1 待拍板：若加列，则追加以下溯源字段（对齐店铺域）：
    # source: Literal["agent_listing_pull", "agent_review_scrape",
    #                 "agent_market_research", "external_api"]   # 必填，无默认（validate 卡死）
    # observed_at: datetime | None = None                         # 缺省后端取 now()
```

> 无 `project_name` 时由路由层从 Project 行读取——`new_product_calculations.project_name` 列是冗余快照，写请求不要求 agent 提供。

### 5.2 R2 SKU 详情规则

`GET .../skus/{sku}?calculation_type=profit_calc`：

- 响应 = `NewProductCalculationItem` 同构（扁平 + 嵌套 dimensions/weights/fees/profit）。
- 不存在 → 404 `RESOURCE_NOT_FOUND`。
- 无 country 消歧问题（country 不在唯一键内，天然无歧义——与店铺域 R2 的 `SHOP_CALCULATION_AMBIGUOUS_COUNTRY` 不同）。

### 5.3 试算 C1 请求 / 响应

```python
class AgentNewProductCalculationComputeRequest(BaseModel):
    mode: Literal["profit_calc", "profit_reverse", "cost_reverse", "fbm_calc"]  # 4 模式（用户拍板，EU 不纳入）
    # 定位层（所有模式）
    sku: str | None = None          # 选填；有则参与 SKU 主数据校验（见 §6.2）
    country: str = "US"             # 4 模式均 US（EU 不纳入）
    product_name: str = Field(min_length=1, max_length=255)   # 引擎必填（可传 sku 本身）
    asin: str | None = None
    # 物理规格层（所有模式必填）
    package_length_cm: float; package_width_cm: float; package_height_cm: float; weight_kg: float
    # 成本层（profit_reverse 除外的模式必填 fob_product_cost_rmb；cost_reverse 不得传）
    fob_product_cost_rmb: float | None = None
    first_leg_cost_rmb: float | None = None
    first_leg_unit_price_rmb: float | None = None
    use_historical_shipping_cost: bool = False
    # 销售参数层（profit_reverse 不得传 sale_price_usd；reverse/cost_reverse 必填 target_profit_rate）
    sale_price_usd: float | None = None
    target_profit_rate: float | None = None
    # 费率默认组（可选）
    commission_rate: float = 0.15; advertising_rate: float = 0.12; return_loss_rate: float = 0.04
    storage_months: float = 1; inbound_placement_mode: InboundPlacementMode = "single_destination"
    usd_to_rmb_rate: float | None = None
    # 模式专属
    full_container_quantity: float | None = None    # fbm_calc
    full_container_price_rmb: float | None = None   # fbm_calc
    delivery_fee_usd: float = 0.0                   # fbm_calc
```

响应（D3 待拍板，默认双字段）：

```json
{
  "ok": true,
  "data": {
    "mode": "profit_calc",
    "calculation": { /* PricingCalculationRunItem 同构：size_tier/fees/profit/dimensions/weights/warnings */ },
    "snapshot": { /* AgentNewProductCalculationUpsertRequest 同构（含溯源占位），可直接 POST W1 */ },
    "usd_to_rmb_rate": 7.18,
    "usd_to_rmb_rate_source": "x-rates"
  }
}
```

- `snapshot` 由路由层薄壳整形（镜像前端 `new-product-client.tsx` 的 `buildSnapshotPayload` :473 映射——`profit.ddp_cost_rmb → ddp_cost_rmb`、`dimensions/weights/fees/profit` 展开；实施时逐字段对照）。`cost_reverse` 模式的 snapshot 中 `fob_product_cost_rmb` = 引擎解出的**最大可接受成本**。
- 引擎 `ValueError` → 400 `VALIDATION_FAILED`（details 带引擎消息；agent 通道统一 400 壳）。
- 不落审计、不落库（**不写 `pricing_calculation_runs`**）、无 confirm（纯计算，读桶）。

---

## 6. confirm 流与白名单（W1）

### 6.1 动作注册

| action | 路由 | validate 回调 | preview 回调 |
|---|---|---|---|
| `new_product_calculation.upsert` | POST `/new-product-calculations` | `_validate_upsert` | `_preview_upsert` |

### 6.2 `_validate_upsert`（业务校验，先于 confirm，短路不生成 token）

1. `source`（若 D1 加列）∈ `{agent_listing_pull, agent_review_scrape, agent_market_research, external_api}` → 否则 400 `NEW_PRODUCT_CALCULATION_INVALID_SOURCE`；
2. **SKU 存在性校验**（对齐店铺域 D2）：`select SkuRecord.sku where project_id == {pid} and country == body.country and sku == body.sku`，不存在 → 400 `NEW_PRODUCT_CALCULATION_INVALID_SKU`，`details: [{sku, reason: "not_found"}]`，agent_hint 提示先建 SKU 主数据；
3. `calculation_type` 白名单（API 讨论阶段定：`{profit_calc, profit_reverse}` 为基线，`cost_reverse`/`fbm_calc` 是否可存快照待定）；
4. `observed_at`（若 D1 加列）不晚于 now()+24h；金额字段（sale_price_usd / profit_usd / total_fee_usd）为正数、`profit_rate ∈ (-1, 1)` → 防脏数据入库。

### 6.3 `_preview_upsert`（confirm 预览摘要）

```json
{
  "action": "new_product_calculation.upsert",
  "sku": "MJQ-TR250C",
  "country": "US",
  "calculation_type": "profit_calc",
  "sale_price_usd": 899.99,
  "profit_usd": 303.08,
  "profit_rate": 0.3368,
  "is_new": false,
  "previous": { "sale_price_usd": 899.99, "profit_usd": 262.51, "profit_rate": 0.2917, "updated_at": "2026-05-18T00:00:00Z" },
  "warnings_count": 0,
  "note": "upsert 语义：将覆盖该 (项目, SKU, 核算类型) 的当前行，历史不保留"
}
```

- `is_new` / `previous`：预览时查 `(project, sku, calculation_type)` 当前行——**upsert 语义下 agent 最需要知道的"影响面"**（会覆盖什么）。与店铺域 append 的 `overwrites_current` 语义相反：这里**默认就是覆盖**，`is_new=true` 表示首次写入。
- confirm 协议细节（token 存储/过期/body-hash 绑定/幂等冲突）沿用 `app/api/agent/confirm.py`，**零改动复用**。

---

## 7. 错误码注册（`app/api/agent/errors.py` 追加）

```python
# 新品测算域（BLF-451）
NEW_PRODUCT_CALCULATION_INVALID_SOURCE = "NEW_PRODUCT_CALCULATION_INVALID_SOURCE"    # 400
NEW_PRODUCT_CALCULATION_INVALID_SKU = "NEW_PRODUCT_CALCULATION_INVALID_SKU"          # 400
NEW_PRODUCT_CALCULATION_INVALID_TYPE = "NEW_PRODUCT_CALCULATION_INVALID_TYPE"        # 400（API 讨论阶段按需）
```

| code | HTTP | 默认 human_message | 默认 agent_hint |
|---|---|---|---|
| `NEW_PRODUCT_CALCULATION_INVALID_SOURCE` | 400 | 写入来源不合法 | 合法来源：agent_listing_pull、agent_review_scrape、agent_market_research、external_api |
| `NEW_PRODUCT_CALCULATION_INVALID_SKU` | 400 | 该 SKU 在本项目不存在 | 先核对 SKU 主数据（sku-info 相关端点），确认后再写入 |
| `NEW_PRODUCT_CALCULATION_INVALID_TYPE` | 400 | 该核算类型不可保存为快照 | 当前可存类型见文档；其余模式仅试算（/compute），不落快照 |

复用既有：`RESOURCE_NOT_FOUND`（404）、`VALIDATION_FAILED`（400）、`CONFIRM_TOKEN_*` / `IDEMPOTENCY_KEY_CONFLICT`（confirm 流）、`AGENT_PROJECT_OUT_OF_SCOPE`（403）。`_HTTP_STATUS` / `_DEFAULTS` 两表同步注册。

---

## 8. 权限矩阵

**无 Task 0 前置**——`require_project_scope` 已合入（commit `d5241993`），新品域所有路由（读 R1-R3 + 写 W1 + 试算 C1）直接挂 `Depends(require_project_scope)`。

| 能力 | 人类用户（内部端点） | Agent（`/agent/*`） | 备注 |
|---|---|---|---|
| 读当前态 | ✅ GET /new-product-calculations | ✅ R1/R2（受 project_scope 限制） | |
| 试算（不落库） | ✅ quote 等 | ✅ C1（4 模式，读桶） | |
| 保存/覆盖快照 | ✅ POST（operator 归因） | ✅ W1（source 枚举 + confirm + 审计归因，D1 后） | upsert 覆盖语义 |
| 删除快照 | ✅ DELETE /{snapshot_id} | ❌ 不开放 | admin only（沿用内部端点） |
| 审计查询 | 内部 audit 中间件 | ✅ R3（只读自己的写入痕迹 + 人类操作痕迹；upsert 表仅能追溯最近一次） | |

---

## 9. 与 BEL-415 / BEL-416 的协同

### 9.1 BEL-416（External API 读暴露）——**端点已上线，D4 拍板去留**

- `GET /external/projects/{pid}/new-product-calculations` **已上线**（BEL-378/416，P0 无鉴权契约，网关层网络隔离）。
- 与本 spec R1 **功能重叠**。店铺域的处理是"读路径并入 agent 命名空间，不另开无鉴权的 `/external/*` 双挂"——新品域 **external 端点已经存在**，处置选项：
  - **D4-A（推荐）**：R1 落地后，external 端点**标记 deprecated**（响应头 `Deprecation` + 文档标注），保留兼容期后停用；
  - **D4-B**：立即停用 external 端点（移除挂载），读路径只走 agent 命名空间。
- 注意：BEL 前缀 issue 不在当前工作区（CLI 解析不到），无法直接置 blocked/备注——协调请用户在 BEL 侧处理或补一条备注指向本 spec。

### 9.2 BEL-415（Mac Paseo agent 写入）

- BEL-415 走内部端点写 `shop_calculation`（`source=agent_listing_pull`），不涉及新品表；若未来要写新品快照，走本 spec W1 即可（双轨兼容）。

---

## 10. 测试清单（供执行子 issue）

| 文件 | 覆盖 |
|---|---|
| `backend/tests/api/agent/test_new_product_read.py` | R1 列表/过滤（calculation_type/country/分页）+ 读不落审计；R2 详情（calculation_type 缺省/显式）+ 404；跨项目 404 壳 |
| `backend/tests/api/agent/test_new_product_confirm.py` | W1 预览（is_new 两分支 + previous）→ confirm → upsert 落行 + 审计归因；SKU 不存在 400；calculation_type 白名单 400；confirm 过期/body 变更；**覆盖语义断言**（同键二次写入行数不变、字段更新） |
| `backend/tests/api/agent/test_new_product_compute.py` | C1 四模式各一例（profit_calc / profit_reverse / cost_reverse / fbm_calc）；不落库断言（new_product_calculations 与 pricing_calculation_runs 行数均不变）；引擎 ValueError → 400 VALIDATION_FAILED；snapshot 与 upsert 请求兼容 |
| `backend/tests/api/agent/test_new_product_audit.py` | R3 按 SKU 聚合（复用 `query_operation_audit_log_for_targets`） |
| `backend/tests/api/agent/test_project_scope.py`（已有） | 新品域路由挂载后回归（`*` 放行 / 白名单命中 / 未命中 403） |
| 前端 | 无新增（新品域仅后端；凭据页 project_scope 已在 BLF-441 覆盖） |

运行顺序（AGENTS.md 约定）：`cd backend && pytest -q tests/api/agent` → 全量无新增失败。

---

## 11. 决策记录（已拍板 + 待讨论）

| # | 决策点 | 默认建议 | 实施影响 |
|---|---|---|---|
| **D1** | **溯源列**：`new_product_calculations` 无 `source`/`observed_at` 列。A=加列（迁移，对齐店铺域，agent 写入声明采集渠道，快照行可溯源）；B=零迁移（溯源仅靠审计表，快照行无渠道标记） | **A（加列）**，与第一期"审计溯源"经验一致；若用户倾向零迁移则 B | A：一个迁移（加 2-3 列，含 `competitor_url` 可选）；B：W1 请求体不含 source 字段 |
| **D2** | **测算模式范围**：4 种模式（profit_calc / profit_reverse / cost_reverse / fbm_calc）确认无误；`eu_accounting`（欧洲测算）**暂不纳入新品域** | **已拍板（用户 2026-08-06）**：范围 = 4 模式，EU 留店铺测算域 | spec 全篇按 4 模式定稿；C1 mode 枚举 4 种 |
| **D2b** | **快照可存类型**：`cost_reverse`/`fbm_calc` 目前仅试算（UI 不存快照）；schema Literal 含 `eu_accounting`（EU 不纳入后可忽略）。是否允许 agent 把这 2 种模式也存为快照 | 待 API 讨论阶段定 | W1 `calculation_type` 白名单据此定；若可存则改 schema Literal（无迁移） |
| **D3** | **/compute 返回形态**：A=双字段 `{calculation, snapshot}`（snapshot 直接可 confirm，agent 零字段映射）；B=单字段 `{calculation}`（agent 自行映射） | **A（双字段）**，对齐店铺域 D3 | §5.3 响应定格 |
| **D4** | **external 端点去留**：`/external/projects/{pid}/new-product-calculations` 已上线（无鉴权）。A=标记 deprecated 保留兼容期；B=随 R1 上线即停用 | **A（标记 deprecated）**，给存量消费者迁移缓冲 | 响应头 + 文档标注；停用走 BEL 侧协调 |
| **D5** | **路由骨架（5 条）**：R1 列表 / R2 SKU 详情 / R3 审计 / W1 upsert（confirm）/ C1 试算（mode 覆盖 4 模式）；**无 history 路由**（upsert 表无历史）；C1 **4 模式全开**（新品是选品/规划语义，倒算与成本倒推是核心，对比店铺域只开 2 模式） | **已拍板（用户 2026-08-06）**：5 条 OK、无 history 合理、C1 4 模式全开 | spec §4 路由表定格；R3 审计可追溯全量 upsert（行 id 稳定） |

---

## 12. 执行前置（writing-plans 前确认）

- [x] 测算模式范围拍板（用户 2026-08-06：4 模式，EU 不纳入新品）；必要元素已定稿（spec §2 + BLF-451 下 4 个按模式子 issue 承载）
- [ ] API/路由/service 复用方案讨论（进行中：① 路由骨架已拍板，②③④ 待过）→ 收敛后本 spec 转定稿、开执行子 issue（路由 5 条 + 错误码 + 测试；如 D1=A 则含 1 个迁移）
- [ ] BEL-416 协调（external 端点 deprecated/停用）在 BEL 侧处理或备注指向本 spec
- [ ] 仓库当前 main 已含：P2 货件域、店铺测算域 6 路由（`90e2ee8f`）、project_scope（`d5241993`）——本 spec 引用的复用函数均为真实存在的符号

---

## 修订记录

- **v0.3（2026-08-06）**：用户拍板路由骨架（D5）——5 条 OK、无 history 合理、C1 4 模式全开；修正 R3 审计可追溯性（`_update_snapshot` 原地更新、行 id 稳定 → 审计可查全部 upsert 痕迹）；§4/§11/§12 同步。
- **v0.2（2026-08-06）**：用户拍板——4 种模式确认、`eu_accounting` 暂不纳入新品域（D2 范围收敛）；必要元素 §2 转定稿；快照可存类型拆为 D2b 待 API 讨论；C1 mode 枚举改 4 种并移除 EU 专属字段；§0.2/§1.2/§3/§4/§6.2/§8/§10/§11/§12 同步。
- **v0.1（2026-08-06）**：BLF-451 产出。review 两个前置 issue + 新品测算现状核实（4 模式 + 引擎第 5 种 EU；upsert 存储语义；external 端点已上线）；定稿必要元素 6 层 + 模式矩阵；按元素所有权/写语义分类 3 个 API 家族；路由表 5 条 + schema + confirm + 错误码 + 权限 + 测试清单；D1-D4 待拍板。
