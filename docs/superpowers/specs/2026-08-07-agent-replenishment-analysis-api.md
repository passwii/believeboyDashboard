# Agent API · Replenishment Analysis（补货分析）API 设计规范（v0.1 草案）

> **状态**：**设计草案（待拍板）**——BLF-502 产出。D1–D7 待用户拍板（§9）；拍板后按 BLF-479「四件套」流程开执行子 issue 落地（设计 spec → 实施 → 端点接入 → 前端调用说明）。
> **配套文档**：[`docs/agent-api-design.md`](../../agent-api-design.md)（Agent API 全局设计稿 v0.7，本 spec 的全局规范依据）、[`docs/superpowers/specs/2026-08-07-agent-return-analysis-api.md`](./2026-08-07-agent-return-analysis-api.md)（退货分析域 spec 定稿，**本 spec 的模板**）、[`docs/superpowers/specs/2026-08-06-agent-new-product-calculation-api.md`](./2026-08-06-agent-new-product-calculation-api.md)（新品测算域 spec 定稿）、[`docs/superpowers/specs/2026-08-05-agent-shop-calculation-api.md`](./2026-08-05-agent-shop-calculation-api.md)（店铺测算域 spec 定稿）、[`backend/docs/external-api.md`](../../backend/docs/external-api.md)（external 读契约 §6 Replenishment Analysis）、[`docs/superpowers/specs/2026-08-01-replenish-2d-assessment-design.md`](./2026-08-01-replenish-2d-assessment-design.md)（三段式体系设计稿 v1.2，BEL-369）。
> **范围**：在 `/api/v1/agent/projects/{id}/replenishment-analysis*` 开放**补货分析（Replenishment Analysis）域**的读路由（+ 可选设置写，D2 待拍板）。**本 spec 只设计，不实施**（对齐 BLF-470/451 执行顺序：先 review + 设计，拍板后开执行子 issue）。
> **前提**：`require_project_scope`（BLF-441）与 `require_business_scope`（BLF-448）已合入 main；Agent 基建（鉴权/限流/响应壳/错误码/审计）全就绪，可直接复用。BLF-491 调研已核实：补货分析三段式体系（BEL-369）已上线为现行行为，Agent 侧目前仅有镜像读端点。

---

## 0. 结论摘要

### 0.1 后端 Review 结论（BLF-502 第 1 步）

补货分析域的后端资产**已完整**（BEL-369 三段式已上线并接到页面/API），Agent 侧**只有 1 条镜像读路由**（无独立域标签、无三段式过滤、无排序、无钻取、无覆盖度、无设置写）：

| 资产 | 内部端点 | Agent 侧现状（BLF-459 镜像） | 缺口 |
|---|---|---|---|
| 全量逐 SKU 补货分析（三段式：5 state + 6 action + signals + 季节性） | ✅ `GET /api/v1/inventory-replenishment-analysis`（Redis 5min 缓存 + 读日志） | ✅ `/agent/projects/{id}/replenishment-analysis`（镜像，**无缓存**——external handler 直调 service） | **R1 原生化**：补三段式过滤 + 排序 + 复用内部缓存 |
| 三段式服务端过滤（`inventory_state` / `replenishment_action`） | ❌ 无（内部端点只有旧 4 类 `risk_status` 过滤；前端 cockpit 是 client 侧过滤） | ❌ | **R1 增强（本域 Agent 化核心）** |
| 排序（order_by） | ❌ 无（rows 按基表 `sort_order` 顺序） | ❌ | **R1 增强** |
| 单 SKU 钻取 | ⚠️ 仅 `?keyword=` 子串过滤（非精确语义） | ❌ | **R2 独立路由** |
| 数据覆盖度 / 快照新鲜度 | ⚠️ `GET /api/v1/inventory-snapshot-options`（report_date 列表） | ❌ | **R3 coverage（新增，Agent-only）** |
| `signals.data_freshness_days` | ⚠️ **恒 0**（`replenishment.py:1107` TODO「未来从 source.report_date 计算」） | ⚠️ 同 | **R3 提供真实新鲜度** |
| 补货设置读 | ⚠️ 无独立 GET（设置已内嵌在分析行：`production_lead_days/shipping_days/safety_factor/asin`） | ⚠️ R1 行已含 | 无需独立路由 |
| 补货设置写 | ✅ `PUT /api/v1/inventory-replenishment-settings/{project_id}/{sku}`（upsert + 审计 `inventory_replenishment_settings.upsert`） | ❌ | **R4 设置写（D2 待拍板，confirm 流）** |

### 0.2 设计结论（BLF-502 第 2 步，待拍板）

补货分析是**读为主的实时分析域**（无物化表，全部现场计算），附带 1 个真实内部写操作（补货设置 upsert）：

- **路由面（推荐 3 读 + 1 可选写，全部挂 `require_business_scope("replenishment_analysis")`）**：R1 全量逐 SKU 分析（原生替换镜像：external §6 契约全保留 + **新增三段式过滤 + 排序**）/ R2 单 SKU 钻取 / R3 覆盖度与新鲜度（**新增**，Agent-only，顺带解决 `data_freshness_days=0` 的 TODO）/ R4 补货设置写（D2 拍板；走 confirm 流 + 审计归因）。
- **v1 读路由无 confirm、无写桶、不落审计**（对齐全仓决策：Agent 读不落审计）；R4 若开放，confirm 预览→重放（对齐 shipments PATCH 先例），审计 `operator=NULL` + `agent_id` 归因。
- **无新迁移**（唯一"新字段"是 `business_scope` 值字符串 `replenishment_analysis`）；**无新错误码**（全部复用既有注册表）。
- **域 code 命名**：`replenishment_analysis`（与路径后缀一致；区别于 inventory 域——BLF-478 白纸黑字「与补货（replenishment-analysis）/库存台账分析独立」，本域是它的补货分析侧）。
- **已知边界**：`REPLENISH_NOW` 枚举存在但当前实现不实际产出（BLF-491 记录：`compute_replenishment_action` 对 critical+shortage 返回 REPLENISH_NORMAL 或 HOLD）——R1 的 `replenishment_action` 过滤按 6 值枚举白名单校验，命中不产出的值返回空结果**不报错**，并在调用说明 guide 中标注。

---

## 1. 后端 Review：补货分析域资产盘点（代码核实 2026-08-07，main @ cf99d794）

### 1.1 数据源（5 类输入，**无物化表**——全部实时计算）

补货分析与退货分析的本质差异：退货分析有 `analysis_return_aggregates` 物化快照，补货分析**每请求现场计算**（SKU 基表 × 多窗口销量 × 库存快照 × 在途 × 设置），无 DB 物化层。

| 数据源 | 位置 / 表 | 粒度 | 关键字段 | 说明 |
|---|---|---|---|---|
| SKU 基表 | `product_costs`（SkuRecord 启用项）∪ `inventory_replenishment_settings` | 每 SKU | `sort_order` / `sku` / `asin` | `_load_base_skus`（`replenishment.py:162`）：ProductCost 启用项 ∪ 设置表并集 |
| 库存快照 | `analysis_source_files`（`report_type='inventory_report'`） | 每次上传一版 | `report_date` / `is_current` | `_load_inventory_map`（`:222`）：每 SKU `available_qty` + 库龄 5 档；**`?report_date=` 可回溯**（取该日或之前最近一版） |
| 销量 DMS | `analysis_sales_order_rows`（`AnalysisSalesOrderRow`） | 每销售订单行 | `purchase_date_pt` / `quantity` / `sku` | `_load_sales_dms_map`（`:389`）30/14/7/3 窗口 + `_load_seasonal_dms_map`（`:603`）YoY 窗口；`lag_days=RECENT_SALES_LAG_DAYS` |
| 在途 | `shipment_schedules` + `shipment_schedule_items` | 每货件行 | `sku` / `quantity` / 状态 | `_load_in_transit_map`（`:278`）按 SKU 汇总 |
| 补货设置 | `inventory_replenishment_settings` | 每 (project, sku, country) | `asin` / `production_lead_days` / `shipping_days` / `safety_factor` | `_load_settings_map`（`:206`）；缺省走 DEFAULT 常量兜底 |

### 1.2 服务层

| 服务 / 函数 | 位置 | 能力 | Agent 复用方式 |
|---|---|---|---|
| `list_inventory_replenishment_analysis(db, *, project_id, country, keyword, risk_status, in_transit_only, page, page_size, report_date)` | `services/inventory/replenishment.py:919` | 全量逐 SKU 计算（三段式 state/action/signals + 老 4 类 risk + 补货时间轴 + 库龄）+ 过滤（keyword/risk_status/in_transit_only）+ summary + 分页 | **R1/R2 核心**（R2 = `keyword=sku` 精确钻取薄封装或复用同函数） |
| `compute_inventory_state` / `compute_replenishment_action` / `compute_signals` / `compute_trend_label` / `compute_trend_momentum` / `compute_seasonal_adjusted_sellable_days` | `services/inventory/state_action.py` | 三段式判定（5 state + 6 action + signals）；`ReplenishmentAction` 枚举 6 值 | 已封装在 service 内，Agent 侧**无需重算** |
| `compute_seasonal_factor` | `services/inventory/seasonal_factor.py` | YoY 季节性因子/相位 | 同上 |
| `upsert_inventory_replenishment_setting(...)` | `replenishment.py:1243` | 设置 upsert（`asin/production_lead_days/shipping_days/safety_factor`） | **R4 核心**（D2） |
| `list_snapshot_options(db, *, project_id, country)` | `replenishment.py:863` | 库存快照 `report_date` 列表 + `is_current`（`analysis_source_files`） | **R3 核心**（快照新鲜度） |
| `get/set_inventory_replenishment_cache` | `services/infra/inventory_cache.py:106/128` | Redis 5min 缓存，key=`(project_id, country, keyword, risk_status, in_transit_only, page, page_size)` | R1 复用（**key 不含 report_date / 三段式过滤 / 排序**——见 D7） |
| `get/set_inventory_snapshot_options_cache` | `inventory_cache.py` | 快照选项 10min 缓存 | R3 复用 |

### 1.3 内部端点现状（`app/api/v1/endpoints/inventory_replenishment.py`）

| 端点 | 参数 | 说明 |
|---|---|---|
| `GET /api/v1/inventory-replenishment-analysis` | `country/keyword/risk_status/in_transit_only/page/page_size` | Redis 5min 缓存 + 读日志；**无 `report_date` 参数**（历史快照仅 external 通道有） |
| `GET /api/v1/inventory-snapshot-options` | `project_id/country` | `report_date` 列表 + `is_current`，10min 缓存 |
| `PUT /api/v1/inventory-replenishment-settings/{project_id}/{sku}` | body `InventoryReplenishmentSettingUpdate` + `country` | upsert + 审计 `inventory_replenishment_settings.upsert`；响应 `InventoryReplenishmentSettingItem` |
| `GET /api/v1/inventory-replenishment-shipments` | `project_id/sku` | 在途货件清单（跨域素材：属 shipments 域，本 spec **不开放**为独立 Agent 路由） |

### 1.4 Agent 侧现状（BLF-459 镜像）与契约偏差

`external_mirror.py` 程序化镜像了 external_router 的全部 GET 路由，补货分析在列（**不在 `_EXCLUDED_EXTERNAL_PATHS` 排除集**）：

- `GET /agent/projects/{id}/replenishment-analysis` —— external handler `get_external_replenishment_analysis`（`endpoints/external/replenishment_analysis.py:46`）：`country/keyword/risk_status/in_transit_only/report_date/page/page_size`（external-api.md §6 契约），响应经 agent 壳翻译为 `{ok, data}`，`data` = `InventoryReplenishmentListResponse` 同构（items/summary/page/page_size/total/has_next）。
- **无缓存**：external handler 直调 service，内部 5min Redis 缓存未复用（内部端点有、镜像没有——Agent 高频读会重复全量计算）。
- **无业务域鉴权**：镜像路由只挂 `require_project_scope`（BLF-441），**没有** `require_business_scope("replenishment_analysis")`——即凭据无法按「补货分析」域单独授权/吊销。

**契约偏差 / 缺口（review 发现）**：

1. **三段式过滤缺失**：external 的 `risk_status` 是**老 4 类风险**（断货风险/短期断货/长期断货/健康库存/滞销/严重滞销/待补数据）；新体系 5 state（critical/deteriorating/watch/healthy/unknown）+ 6 action（REPLENISH_NOW/REPLENISH_NORMAL/HOLD/REDUCE_PRICE/REMOVE/NO_ACTION）**没有服务端过滤**——前端 cockpit 是 client 侧过滤（`inventory-replenishment-client.tsx:499`）。Agent 问「哪些 SKU 该紧急补货 / 该降价 / 该移除」必须自己拉全量再筛。
2. **排序缺失**：rows 按基表 `sort_order` 顺序，无 `order_by`——Agent 无法按 sellable_days / weighted_dms / state 排序取 Top-N。
3. **无单 SKU 钻取**：`?keyword=` 是子串过滤（语义不精确、返回列表），无「精确 SKU 完整行」语义。
4. **新鲜度失真**：`signals.data_freshness_days` 恒 0（`replenishment.py:1107` TODO 未实现）——Agent 无法判断「这份分析基于几号的库存数据」。
5. **无设置写**：Agent 发现「SKU 快断货但补货周期未配置」后无法闭环（改设置 → 重算建议）。

### 1.5 Agent 基建（已就绪，直接复用）

- `require_project_scope(project_id)`（`app/api/agent/scope.py:46`）——`*` 放行 / 白名单校验 / 越权 403 `AGENT_PROJECT_OUT_OF_SCOPE`。
- `require_business_scope("replenishment_analysis")`（`scope.py:85`，工厂）——域 code 白名单，越权 403 `AGENT_BUSINESS_OUT_OF_SCOPE`；**域 code 为新值**，无需 DB 迁移（`business_scope` 是逗号分隔字符串列）。
- 读限流 `require_agent_read_rate_limit`（300 req/min/agent）；响应壳 `agent_ok`（`{ok, data}`）；错误码注册表 `app/api/agent/errors.py`；`_service_errors()` 壳翻译（HTTPException → AgentApiError，mirror 与各域通用模板）。

### 1.6 相邻资产（已开放 / 可协同，不在本域核心）

| 资产 | 位置 | Agent 侧 | 与补货分析的关系 |
|---|---|---|---|
| 库存信息（快照） | `services/inventory_analysis_service.py`（`inventory.py` 域） | ✅ `/agent/projects/{id}/inventory`（BLF-478） | 互补不重叠：它只读「当前数量/库龄」快照，本域是「DMS + 补货周期 + 三段式判定」 |
| 库存台账 | `services/external/inventory_ledger.py` | ✅ `/agent/projects/{id}/inventory-ledger/*`（镜像） | 月度盘点/事件，与补货分析独立（口径声明同源） |
| 在途货件 | `ShipmentSchedule` / `list_inventory_replenishment_shipments` | ✅ `/agent/projects/{id}/shipments`（shipments 域） | 跨域：在途量已内嵌 R1 行（`in_transit_quantity`）；货件明细归 shipments 域，本域**不开口**（BLF-476 单域约束） |
| SKU 主数据 | `SkuRecord`（`product_costs`） | ✅ `/agent/projects/{id}/sku-info`（镜像） | R1 行已含 `product_name`，无需额外调用 |

---

## 2. Agent 可调用资产 → API 家族分类

按**元素所有权 + 读语义**把补货分析域拆成 3 个读家族 + 1 个可选写家族：

| 家族 | 端点 | 数据源 | 语义 | confirm | 限流 | 审计 |
|---|---|---|---|---|---|---|
| **F1 逐 SKU 清单**（决策清单） | `GET /replenishment-analysis` | `list_inventory_replenishment_analysis` + 内部 5min Redis 缓存 | 三段式全量清单 + **state/action 服务端过滤 + 排序**——Agent 的「哪些 SKU 该补 / 该降 / 该清」 | ❌ | 读 | 不落 |
| **F2 单 SKU 钻取**（精确行） | `GET /replenishment-analysis/skus/{sku}` | 同 service（精确 SKU） | 单 SKU 完整三段式行（含 signals 解释性事实） | ❌ | 读 | 不落 |
| **F3 覆盖度**（数据可信度） | `GET /replenishment-analysis/coverage` | `list_snapshot_options` + 设置/基表计数 + 销售跨度 | 库存快照日期与新鲜度 / 销售数据跨度 / 设置覆盖——Agent 判断「这份分析是否可信」 | ❌ | 读 | 不落 |
| **F4 设置写**（闭环，D2） | `PUT /replenishment-analysis/settings/{sku}` | `upsert_inventory_replenishment_setting` | 修改补货参数（asin/lead/shipping/safety_factor）→ 影响后续建议 | ⚠️ confirm | 写 | 落（回放成功那次） |

**分类理由**：

1. **F1 是 Agent 化的核心增值**：当前镜像只能按老 4 类 `risk_status` 过滤，而新体系的状态/行动才是运营语言。`inventory_state`（5 值）与 `replenishment_action`（6 值）服务端过滤 + `order_by` 排序是「Agent 直接可执行的决策清单」的基础——这同时惠及前端（cockpit 的 client 侧过滤可逐步下沉，但**本 spec 不要求前端改造**，只要求后端能力就绪）。
2. **F3 补上新鲜度空白**：`signals.data_freshness_days` 恒 0 是已知 TODO（`replenishment.py:1107`）。补货分析强烈依赖库存快照日期（`?report_date=` 可回溯）与销量跨度——Agent 拿到清单前应能自查「这份分析基于几号的数据、配置覆盖了多少 SKU」。F3 直接解决该 TODO 的 Agent 侧需求（服务层顺带把 `data_freshness_days` 补真实值，见 D6）。
3. **F4 是唯一真实写目标**：与退货分析（无内部写操作）不同，补货域有 `upsert_inventory_replenishment_setting` 现成写服务 + 审计动作。开放它让 Agent 能闭环「发现断货风险 → 校正补货周期参数 → 重算建议」。是否开放由 D2 拍板。

---

## 3. 完整路由表（3 读 + 1 可选写）

> 统一挂 `/api/v1/agent/projects/{project_id}`（router prefix），命名空间级鉴权（Bearer + X-Agent-Id + 读限流）由 `agent_router` 承担。
> **全部路由挂 `Depends(require_project_scope)`**；**域级再挂 `require_business_scope("replenishment_analysis")`**（D3 待拍板，推荐挂——与 shipments/shop_calculations/return_analysis/inventory 对齐）。

| # | Method | Path | 复用 service | confirm | 限流桶 | 审计 |
|---|---|---|---|---|---|---|
| R1 | GET | `/projects/{pid}/replenishment-analysis` | `list_inventory_replenishment_analysis` + `get/set_inventory_replenishment_cache` | ❌ | 读 | 不落 |
| R2 | GET | `/projects/{pid}/replenishment-analysis/skus/{sku}` | 同 service（精确 SKU 过滤） | ❌ | 读 | 不落 |
| R3 | GET | `/projects/{pid}/replenishment-analysis/coverage` | `list_snapshot_options` + 基表/设置计数 + 销售跨度小查询 | ❌ | 读 | 不落 |
| R4 | PUT | `/projects/{pid}/replenishment-analysis/settings/{sku}`（D2 拍板后） | `upsert_inventory_replenishment_setting` | ⚠️ 是（action `replenishment_settings.upsert`） | 写 | 落 |

**关键实现事实（代码已核实）**：

- **与镜像的关系（D1）**：R1 与当前镜像路径 `/replenishment-analysis` **同路径冲突**——实施时把 `/external/projects/{project_id}/replenishment-analysis` 加入 `external_mirror.py` 的 `_EXCLUDED_EXTERNAL_PATHS`（对齐 new-product-calculations / return-analysis 两条 precedent），原生实现**保持 external §6 的查询契约**（country/keyword/risk_status/in_transit_only/report_date/page/page_size），既有 agent 消费者无感；R2/R3/R4 是全新路径，无冲突。
- **R1 契约 = external §6 + 三段式增强**（D4）：
  - 保留：`country`（默认 US）/ `keyword`（SKU/ASIN 子串）/ `risk_status`（老 4 类，白名单：断货风险/短期断货/长期断货/健康库存/滞销/严重滞销/待补数据，`"all"` 放行）/ `in_transit_only` / `report_date`（历史快照）/ `page` / `page_size`（≤200）。
  - 新增：`inventory_state`（逗号分隔多值，白名单 `critical,deteriorating,watch,healthy,unknown`）、`replenishment_action`（逗号分隔多值，白名单 6 枚举）、`order_by` / `order_dir`（白名单见下）。非法值 → 400 `VALIDATION_FAILED`（`_service_errors` 翻译）。
  - `order_by` 白名单（服务层 Python 侧排序；**默认维持现状**——基表 `sort_order` 顺序）：`sku / available_inventory / in_transit_quantity / weighted_dms / sellable_days / estimated_replenishment_quantity / risk_status / inventory_state / replenishment_action`。`order_dir` ∈ `asc|desc`。
  - **已知边界**：`replenishment_action=REPLENISH_NOW` 过滤命中当前实现不产出的值 → 返回空 items（200），不报错；guide 中标注（§8.4）。
- **R1 缓存（D7）**：默认路径（`report_date=None` + 未用新过滤/排序）直接复用内部 `get/set_inventory_replenishment_cache`（key 与内部端点一致 → 与 UI 共享缓存、成本为 0）；一旦使用 `report_date` / 三段式过滤 / 排序，**缓存 key 需扩展**（现有 key 不含这些参数）——推荐方案 A：扩展 service 过滤参数 + 内部缓存函数签名（加 5 个参数），内部端点同步透传（前端未来可直接用服务端过滤）；备选方案 B：agent 侧独立缓存 key。**推荐 A**（一处实现、双侧受益），实施时评估内部端点透传的兼容性。
- **R2 单 SKU 钻取**：`list_inventory_replenishment_analysis(keyword=sku)` 的精确化薄封装——实施时新增精确匹配参数（或复用 `keyword` + 过滤后取唯一行）。响应 = 单个 `InventoryReplenishmentListItem` 同构行（含 `signals`）。无该 SKU → **200 + `data: null`**（D5：查询结果为空 ≠ 资源不存在，对齐 return-analysis D6）。
- **R3 覆盖度**：数据源 = `list_snapshot_options`（库存快照 report_date 列表 + is_current）+ 基表/设置计数（复用 `_load_base_skus` / `_load_settings_map` 的薄封装）+ 销售跨度小查询（`analysis_sales_order_rows` 的 MAX(purchase_date_pt)）。**服务层新增**一个小薄查询 + 计数函数（放 `services/inventory/replenishment.py` 或端点模块内）；无新表、无迁移。
- **R4 设置写（D2 拍板后）**：confirm 预览（含旧值 → 新值摘要，action `replenishment_settings.upsert`）→ 重放落库（`upsert_inventory_replenishment_setting`，`operator=NULL` + `agent_id` 归因，审计 `inventory_replenishment_settings.upsert`）。body = `InventoryReplenishmentSettingUpdate`（`asin/production_lead_days(≥0)/shipping_days(≥0)/safety_factor(≥0)`）+ `country` query。对齐 shipments PATCH「修改字段也要 confirm」先例（`agent-api-design.md` §3.2）。
- **该域 1 个 Redis 缓存**（R1 复用 5min 缓存）；读不落审计；无新迁移；无新错误码。

---

## 4. 请求 / 响应 schema 草案

### 4.1 R1 全量逐 SKU 分析（原生替换镜像）

```
GET /api/v1/agent/projects/{pid}/replenishment-analysis
    ?country=US[&keyword=SKU-][&risk_status=断货风险][&in_transit_only=false]
    [&report_date=2026-08-01][&inventory_state=critical,deteriorating]
    [&replenishment_action=REPLENISH_NOW,REPLENISH_NORMAL]
    [&order_by=sellable_days][&order_dir=asc][&page=1][&page_size=50]
```

- 响应 `data` = `InventoryReplenishmentListResponse` 同构（`schemas/inventory_replenishment.py:94`）：`items[]` / `summary` / `page` / `page_size` / `total` / `has_next`。
- `items[]` 每行 = `InventoryReplenishmentListItem` 同构（`:49`）——**三段式字段全量随行返回**：
  - 判断维度 `inventory_state`（5 值）
  - 动作维度 `replenishment_action`（6 枚举）
  - 透明度 `signals`（`InventorySignals`：sellable_days / dms_3/7/14/30 / trend_ratio / trend_label / trend_momentum / aging_share / transit_ratio / data_freshness_days / confidence / seasonal_factor / seasonal_phase / seasonal_source）
  - 补货时间轴 `replenishment_order_date / warehouse_entry_date / shipment_order_date / sellout_date / sellout_date_with_transit`
  - 老 4 类 `risk_status`（兼容保留）+ 库龄 5 档 + `recommended_action`
- `summary` = `InventoryReplenishmentSummary`（`:33`）：skus 数 + 老 4 类计数 + **三段式 state 5 计数**（critical/deteriorating/watch/healthy_v2/unknown）+ 可售/在途总量。

### 4.2 R2 单 SKU 钻取

```
GET /api/v1/agent/projects/{pid}/replenishment-analysis/skus/{sku}?country=US[&report_date=2026-08-01]
```

- 响应 `data` = 单个 `InventoryReplenishmentListItem` 同构行（含 `signals`）。
- 无该 SKU → **200 + `data: null`**（D5 推荐；不新增错误码）。

### 4.3 R3 数据覆盖度 / 新鲜度（新增）

```
GET /api/v1/agent/projects/{pid}/replenishment-analysis/coverage?country=US
```

响应 `data`（草案）：

```json
{
  "project_id": 1,
  "country": "US",
  "as_of_date": "2026-08-07",
  "inventory_snapshot": {
    "report_date": "2026-08-01",
    "freshness_days": 6,
    "is_current": true,
    "available_options_count": 12
  },
  "sales_data": {
    "max_sales_date": "2026-08-06",
    "window_days": 30
  },
  "base_skus": {
    "total_count": 120,
    "configured_count": 45
  }
}
```

- `inventory_snapshot`：`list_snapshot_options` 取最新 `report_date` + `is_current` + 可选历史快照数；`freshness_days = as_of_date - report_date`——**即 `signals.data_freshness_days` 的真实值来源**（服务层顺带补实现 TODO，见 D6）。
- `sales_data.max_sales_date`：`analysis_sales_order_rows` 按 project/country 的 MAX(`purchase_date_pt`)（新薄查询）。
- `base_skus`：基表 SKU 总数（`_load_base_skus` 计数）vs 有自定义设置数（`_load_settings_map` 计数）——「配置覆盖度」：设置缺失越多，默认周期兜底越多，建议越需人工复核。

### 4.4 R4 补货设置写（D2 拍板后；confirm 流）

```
# 第一次调用（预览，server 不落库）
PUT /api/v1/agent/projects/{pid}/replenishment-analysis/settings/{sku}?country=US
Authorization: Bearer <key_secret>
X-Agent-Id: <agent_id>
Idempotency-Key: <uuid>
Content-Type: application/json

{ "asin": "B0XXXX", "production_lead_days": 35, "shipping_days": 40, "safety_factor": 0.2 }
```

- 预览响应（HTTP 200）：`{ "ok": false, "requires_confirmation": true, "confirm_token": "cf_xxx", "preview": { "action": "replenishment_settings.upsert", "summary": { "sku": "...", "old": { "production_lead_days": 30, "shipping_days": 35, "safety_factor": 0.1 }, "new": { ... } } }, "expires_in_sec": 300, ... }`。
- 第二次调用：回传同一 `Idempotency-Key` + `X-Confirm-Token`，body 与预览完全一致 → 落库 + 审计（`operator=NULL` + `agent_id`）。
- 校验失败 → `CONFIRM_TOKEN_INVALID | CONFIRM_TOKEN_EXPIRED | IDEMPOTENCY_KEY_CONFLICT`（复用全局注册表）。

---

## 5. 错误码注册（`app/api/agent/errors.py`）

**v1 建议零新增错误码**——全部复用既有：

| 场景 | code | HTTP |
|---|---|---|
| 项目不存在 | `RESOURCE_NOT_FOUND` | 404 |
| 非法 country / report_date / inventory_state / replenishment_action / order_by / 分页参数 | `VALIDATION_FAILED`（external handler 已抛 HTTPException 400 → `_service_errors` 翻译；白名单校验失败同码） | 400 |
| 越权项目 / 越权域 | `AGENT_PROJECT_OUT_OF_SCOPE` / `AGENT_BUSINESS_OUT_OF_SCOPE` | 403 |
| 鉴权失败 / 限流 | `AGENT_AUTH_FAILED` / `AGENT_RATE_LIMIT_EXCEEDED` | 401 / 429 |
| R4 confirm 校验失败 | `CONFIRM_TOKEN_INVALID` / `CONFIRM_TOKEN_EXPIRED` / `IDEMPOTENCY_KEY_CONFLICT`（已注册） | 400 / 409 |

> R2 空 SKU 结果默认 **200 + `data: null`**，不新增 `REPLENISHMENT_ANALYSIS_NO_DATA`（D5）。

---

## 6. 权限矩阵

| 能力 | 人类用户（内部端点） | Agent（`/agent/*`） | 备注 |
|---|---|---|---|
| 全量逐 SKU 补货分析（三段式） | ✅ `GET /api/v1/inventory-replenishment-analysis` | ✅ R1（受 project_scope + business_scope 限制；含三段式过滤/排序增强） | 原生替换镜像；缓存与内部共享（默认路径） |
| 单 SKU 钻取 | ⚠️ 仅 `?keyword=` 子串 | ✅ R2（精确行 + signals） | 新增 |
| 数据覆盖度/新鲜度 | ⚠️ `GET /api/v1/inventory-snapshot-options`（仅日期列表） | ✅ R3（**新增**，快照+销售+配置三维） | 仅 Agent 通道的完整版 |
| 补货设置写 | ✅ `PUT /api/v1/inventory-replenishment-settings/{pid}/{sku}` | ✅ R4（D2 拍板；confirm 流 + agent 审计归因） | 预览→重放 |
| 修改分析结果本身 | ❌ 无内部操作（实时计算） | ❌ 不开放 | 无物化表，无可写目标 |
| 在途货件明细 | ✅ `GET /api/v1/inventory-replenishment-shipments` | ❌ 归 shipments 域 | BLF-476 单域约束；在途量已在 R1 行 |

---

## 7. 测试清单（供执行子 issue）

| 文件 | 覆盖 |
|---|---|
| `backend/tests/api/agent/test_replenishment_read.py` | R1（参数校验/项目 404/`?report_date=` 回溯/三段式过滤白名单与非法值 400/排序/分页/空结果 200）；R2 单 SKU（有数据行/无数据 `data:null`/非法 SKU） |
| `backend/tests/api/agent/test_replenishment_coverage.py` | R3 覆盖度（快照 report_date/freshness_days/无快照时 `report_date:null`/销售跨度/基表计数） |
| `backend/tests/api/agent/test_replenishment_settings_write.py` | R4（D2 拍板后）：confirm 预览→重放落库→body hash 不匹配拒绝→token 过期→审计 `operator=NULL` + agent_id |
| `backend/tests/api/agent/test_business_scope.py`（已有） | `business_scope` 含 `replenishment_analysis` 放行 / 不含 403 |
| `backend/tests/api/agent/test_project_scope.py`（已有） | 补货域路由挂载后回归（`*` 放行 / 白名单命中 / 未命中 403） |
| `backend/tests/api/agent/test_external_mirror.py`（已有） | 断言 replenishment-analysis 已从 mirror 排除（镜像路由数减 1） |
| `backend/tests/services/test_replenishment_filter_sort.py` | 服务层新增过滤/排序参数的单测（含 REPLENISH_NOW 空结果语义） |
| 前端 | 无新增（纯后端域；guide 标注三段式过滤用法） |

运行顺序（AGENTS.md 约定）：`cd backend && pytest -q tests/api/agent` → 全量无新增失败。

---

## 8. 与既有 contract / 文档 / 前端的协同

1. **镜像排除**：`external_mirror.py` `_EXCLUDED_EXTERNAL_PATHS` 增加 `/external/projects/{project_id}/replenishment-analysis`（对齐 new-product-calculations / return-analysis precedent）。external 模块保留为 handler 来源，不再挂载（现状已如此）。
2. **openapi 再生成**：落地后重跑 `scripts/openapi_export.py` 并同步 `frontend/types/api-generated/`（BLF-465 流程），清除镜像 operation、加入原生补货分析路由。
3. **external-api.md §6**：原生化后标记 deprecated 或按代码契约为准（对齐 return-analysis §8 处理）。
4. **前端 agent-domains 注册（BLF-474/490 模式，四件套第 4 件）**：
   - `frontend/lib/agent-domains.ts` 新增：`{ code: 'replenishment_analysis', label: '补货分析', description: '补货决策清单：三段式状态/行动/signals + 覆盖度（独立于库存信息）', status: 'live'（实施后从 planned 翻）, routeCount: 3（或 4，D2 后）, capabilities: { read: true, write: <D2 决定> } }`。
   - `frontend/app/dashboard/system/agent-management/agent-usage-guide.tsx` 新增 `buildReplenishmentAnalysisGuide()`：示例 curl（R1 带 `inventory_state=critical` / `replenishment_action=REDUCE_PRICE` 过滤、R2 钻取、R3 覆盖度）；标注「`REPLENISH_NOW` 为枚举预留值，当前实现不产出；`risk_status` 为兼容旧字段」。
5. **服务层顺带修复**：R3 实施时把 `signals.data_freshness_days` 的 TODO（`replenishment.py:1107`）补上真实值（`today - inventory snapshot report_date`）——Agent 与前端同时受益。

---

## 9. 决策记录（待拍板）

| # | 决策点 | 选项 | 推荐 | 实施影响 |
|---|---|---|---|---|
| **D1** | **镜像去留**：R1 与镜像路径冲突。A=原生迁移（mirror 排除 1 路径，原生保持 external §6 契约 + 三段式增强）；B=保留镜像，仅新增 R2/R3/R4 | **A（原生迁移）** | mirror 排除 1 路径；原生模块 `endpoints/agent/replenishment_analysis.py`；openapi 再生成 |
| **D2** | **设置写路由**：补货域 v1 是否开放 `PUT settings/{sku}`（本域唯一真实写操作） | A=全读（对齐 return-analysis D2，设置暂由页面/人工维护）；**B=开放**（confirm 流 + 审计，对齐 shipments PATCH 先例，Agent 可闭环「发现断货风险→校正补货周期→重算建议」） | **B（开放）** | 路由 +1；confirm 装饰器 + 写限流桶；审计 action 复用 |
| **D3** | **business_scope**：是否挂 `require_business_scope("replenishment_analysis")` | 挂 / 不挂（仅 project_scope） | **挂** ✅ | 新域 code 字符串，无迁移；与 shipments/shop/return/inventory 对齐 |
| **D4** | **三段式过滤 + 排序**：R1 是否新增 `inventory_state` / `replenishment_action` 多值过滤 + `order_by` 白名单 | 加（Agent 决策清单核心能力）/ 不加（保持镜像契约） | **加** | 服务层加过滤/排序参数（Python 侧排序）；白名单校验；内部端点可同步透传（D7 方案 A） |
| **D5** | **R2 单 SKU 钻取 + 空结果语义**：独立路由 vs 并入 R1 `?keyword=`；无该 SKU 时 200 null vs 404 | **独立 R2 + 200 `data:null`** | 路由 +1；不新增错误码（对齐 return-analysis D5/D6） |
| **D6** | **R3 覆盖度 + data_freshness 修复**：是否新增 coverage 端点；是否顺带修 `signals.data_freshness_days=0` TODO | **新增 R3 + 顺带修复** | 薄查询 +1；`replenishment.py:1107` TODO 落地（服务层小改） |
| **D7** | **缓存策略**：R1 默认路径复用内部 5min 缓存；新参数（report_date/过滤/排序）的缓存 key 处理 | A=扩展内部缓存函数签名 + 内部端点透传（一处实现、双侧受益）；B=agent 侧独立 key | **A（推荐，评估兼容）** | 缓存 key 扩展 5 参数；内部端点签名变化需回归 |

---

## 10. 执行前置（拍板后）

- [ ] D1–D7 拍板（本 issue 置 in_review 待用户评审）
- [ ] 拍板后按 BLF-479 流程开执行子 issue（或随拍板直接实施，对齐 BLF-470 先例）：`endpoints/agent/replenishment_analysis.py` + mirror 排除 + `__init__.py` 挂载 + 服务层过滤/排序 + R3 薄查询 + R4 confirm + openapi/api.d.ts 再生成 + 测试
- [ ] 仓库 main 已含：`require_project_scope` / `require_business_scope` / `_EXCLUDED_EXTERNAL_PATHS` precedent——本 spec 引用的复用函数均为真实存在的符号

---

## 修订记录

- **v0.1（2026-08-07）**：BLF-502 产出。后端整体 review（补货分析域 5 类数据源 + 服务层 + 内部/镜像端点 + 契约缺口：三段式过滤缺失 / 排序缺失 / 无钻取 / `data_freshness_days=0` / 无设置写 / 无 business_scope）；Agent 可调用资产盘点（§1.1–1.6）；API 分类 4 家族 + 路由表 3 读 + 1 可选写（R1 原生替换镜像 / R2 单 SKU / R3 coverage / R4 设置写）；schema 草案（含 R3 覆盖度 JSON）；错误码零新增；权限矩阵；测试清单；前端 agent-domains/usage-guide 协同；D1–D7 待拍板。
