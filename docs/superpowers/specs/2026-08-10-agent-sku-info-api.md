# SKU Info（商品主数据）Agent API 设计（sku_info）

> 设计定稿 v0.1（2026-08-10，BLF-579 **S1 设计定稿**）。
> 域 code：`sku_info`；命名空间：`/api/v1/agent/projects/{project_id}/sku-info/*`。
> 前置设计：`docs/agent-api-design.md`（v0.7，confirm 流 §3 / 审计归因 §4.2 / 错误壳 §5）；模板：`docs/superpowers/specs/2026-08-08-agent-account-health-api.md`（S1 调研定稿结构）、`2026-08-06-agent-new-product-calculation-api.md`（写域实施结构）。
> 相关域：BLF-459（`/external/*` → `/agent/*` 读镜像迁移）、BLF-457（新品测算写域样板）、BLF-479（Agent API 汇总索引 §2.10）。

## 1. 文档目的与域定位

### 1.1 文档目的

承接 BLF-579「SKU Info（商品主数据）Agent API：读 + 写」的 **S1（设计定稿）**：
梳理现状底座、拍板读侧收口策略 / 端点清单 / 必要元素 / confirm-溯源-幂等契约，作为 S2（实施）与 S3（上线收尾）的锚点。
**本域是 agent 命名空间第一个「纯主数据 · 读+写」域**——写侧打开新建 SKU、改成本规格、上/下架三个真实数据变更动作，是 account_health（纯读）/ new_product_calculations（快照 upsert）之后的写域样板升级。

### 1.2 域定位（单域原则）

- **单域原则**（spec §1.2）：本域只服务「商品主数据（SKU Info）」一个业务域——单表 `product_costs`（`SkuRecord`），无跨域打包。
- 本域边界 = **SKU 主数据本身**：project/sku/asin/fnsku/product_name + 成本（fob/first_leg）+ 包装尺寸/箱规/重量 + currency/country + is_active + 工厂信息（JSON）+ 图片/FNSKU 标签资源。
- **不吸收**店铺测算 / 新品测算 / 补货 / 货件等其它域端点——那些域消费本域成本/规格字段（影响面见 §6），但各有独立域 code 与端点。
- 与 `shop_calculations` / `new_product_calculations` 的差异：这两个域是**快照/测算记录**（append 或 upsert 派生数据），本域是**事实主数据**（唯一键 `(project_id, sku, asin, country)` 覆盖，被多个下游模块读取）——写侧影响面更大，confirm 预览必须带下游提示。

### 1.3 与既有读镜像的关系（D2 前置说明）

- 现状：`GET /agent/projects/{project_id}/sku-info`（external 镜像，BLF-459 迁入）是**唯一**的 Agent 侧读路径，走 `external_mirror.py` 程序化镜像，只挂 `require_project_scope`（**无 business_scope 门禁**），字段为 `ExternalSkuInfoItem` 子集（无 sku_factory_info / fnsku_label / 审计）。
- 本域原生实现后该镜像**收口**（D2）：路径加入 `_EXCLUDED_EXTERNAL_PATHS`，读路由只走原生 `sku_info` 域——避免「双路径 + 无 scope 门禁」漂移。对齐 new-product-calculations（BLF-457）/ return-analysis（BLF-470）/ replenishment-analysis（BLF-502）三域先例。

## 2. 现状底座清单（代码核实 2026-08-10）

### 2.1 数据模型（单表 `product_costs`，`backend/app/models/sku_info.py`）

`SkuRecord`，唯一键 `(project_id, sku, asin, country)`；索引：project_id / (project_id, sort_order, id) / (project_id, sku, is_active)。

| 分组 | 字段 | 类型 / 约束 | 说明 |
|---|---|---|---|
| 身份 | `project_id` / `project_name` | int / str（非空，冗余列） | project_name 为只读冗余，写走 project_id |
| 身份 | `sku` / `asin` / `fnsku` | str / str（非空，空串允许）/ str? | asin 非空列，内部 upsert 空串归一化 |
| 展示 | `product_name` | str? | — |
| 成本 | `fob_unit_cost` | Numeric(12,2)，非空 | FOB 单价（USD 口径，前端展示） |
| 成本 | `first_leg_cost_rmb` | Numeric(12,2)，非空 | 头程单价 RMB；**可被货件同步回写**（§6 #3） |
| 包装 | `package_{length,width,height}_cm` / `weight_kg` | Numeric，非空 | 单品尺寸/重量 |
| 箱规 | `carton_{length,width,height}_cm` / `carton_weight_kg` / `units_per_carton` | Numeric/int，非空 | 装箱信息，货件核算消费（§6 #4） |
| 属性 | `currency` / `country` / `sort_order` / `is_active` | str / str(2) / int / bool | currency 恒 CNY（服务层强制）；is_active 上/下架语义（§3 D8） |
| 溯源 | `source_file` | str? | 来源文件；Agent 写由服务端派生 `agent:<agent_id>`（D4） |
| 工厂 | `sku_factory_info`(JSON) / `sku_factory_info_updated_{at,by}` | dict? / datetime? / str? | 工厂属性，updated_by 记操作者 |
| 资源 | `fnsku_label_r2_{key,url}` / `product_image_r2_{key,url}` / `product_image_thumbnail_r2_{key,url}` | str? | R2 存储；读侧只暴露 url（§4 公共约定） |
| 时间戳 | `created_at` / `updated_at` | datetime(tz) | server_default / onupdate |

### 2.2 内部端点（`backend/app/api/v1/endpoints/sku_info.py`，前缀 `/api/v1/sku-info`，18 条全 CRUD 已上线）

| # | 端点 | 方法 | 能力 |
|---|---|---|---|
| 1 | `/sku-info` | GET | 列表（project_name/sku/asin/country/is_active 筛选 + page/page_size/include_total 分页） |
| 2 | `/sku-info` | POST | upsert（唯一键覆盖，返回 action=inserted/updated） |
| 3 | `/sku-info/bulk` | POST | 批量 upsert |
| 4 | `/sku-info/{id}` | PATCH | 局部更新（**注意默认值陷阱**，见 §9 #2） |
| 5 | `/sku-info/{id}` | DELETE | 删除（204） |
| 6 | `/sku-info/{id}/move` | POST | **排序移动**（up/down）——**不是换项目**（见 D3 注） |
| 7 | `/sku-info/import-csv` | POST | CSV 导入（文件上传） |
| 8 | `/sku-info/export` | GET | CSV 导出 |
| 9 | `/sku-info/import-blf-basic-info` | POST | 默认 BLF 基础信息导入 |
| 10 | `/sku-info/recalculate-first-leg-costs` | POST | 头程成本重算（按单位 kg 单价） |
| 11 | `/sku-info/sync-first-leg-from-shipment` | GET | **货件头程同步（回写 first_leg_cost_rmb）** |
| 12 | `/sku-info/batch-parse-factory-info` | POST | AI 解析工厂信息 |
| 13 | `/sku-info/batch-update-factory-info` | POST | 批量更新工厂信息 |
| 14 | `/sku-info/{id}/fnsku-label` | POST | FNSKU 标签上传（含验证） |
| 15 | `/sku-info/{id}/product-image` | POST / DELETE | 产品图上传/删除 |
| 16 | `/sku-info/{id}/fnsku-label/download` | GET | 标签下载 |
| 17 | `/sku-info/fnsku-labels/batch-download` | POST | 批量标签下载 |
| 18 | `/sku-info/fnsku-labels/by-skus` | POST | 按 SKU 列表查标签 |

**Agent 侧现状**：`/agent/*` 命名空间 11 个 live 域无 `sku_info`；唯一读路径是 external 镜像 `/agent/projects/{project_id}/sku-info`（`ExternalSkuInfoItem` 子集字段、无 business_scope 门禁、无审计端点）。

### 2.3 服务层（`backend/app/services/data/sku_info/crud.py`，S2 直接复用）

- `list_sku_records(db, project_name, sku, asin, country, is_active, page, page_size, include_total, managed_project_ids)` —— 内部列表查询；Agent 侧传 `managed_project_ids=[project_id]` 复用（`crud.py:250-251`，项目白名单语义）；**0 存量调用方影响**（callers 仅内部端点 + bulk/import 内部复用）。
- `upsert_sku_record(db, item: SkuRecordCreate, source_file)` —— 唯一键 upsert；insert 时自动分配 sort_order（max+1）/ 可请求重排；**0 存量调用方影响**（callers 仅内部端点 + bulk/import 内部复用）。
- `update_sku_record_by_id(db, id, payload: SkuRecordUpdate, source_file, operator)` —— 按 id 更新 + 重复检测（409）+ sort_order 重排；`operator` 同时落 `sku_factory_info_updated_by`（Agent 传 agent_id 即可，D4）。
- `delete_sku_record` / `move_sku_record_sort_order` —— 本域**不开放**给 Agent（D3）。
- 校验：金额/尺寸 ≥0 且 ≤上限（`_normalize_cost` / `_normalize_decimal_value`）、`units_per_carton` int ≥0、`sort_order` ≥1、country 走 `normalize_country`（2 字母归一）、`sku` 非空；`currency` 强制 CNY。

### 2.4 写后副作用（Agent 写路由必须对齐）

内部写端点（POST/PATCH/DELETE）都调 `_invalidate_financial_cache(db, project_name)`（→ `invalidate_financial_series_cache(project_id)`，`sku_info.py:159-163`），失效 PT4 财务汇总月度序列缓存。**Agent W1/W2 必须做同样的失效**（§3 D7）。该 helper 目前是端点文件私有函数——S2 下沉到服务层或 agent 路由内直接调 `app.services.infra.invalidate_financial_series_cache`。

## 3. 决策拍板（D1–D8）

| # | 决策点 | 结论 |
|---|---|---|
| **D1 域 code / 命名空间** | — | 域 code **`sku_info`**（与既有 11 域无冲突；`agent_api_keys.business_scope` 字符串列加值无迁移）。命名空间 **`/api/v1/agent/projects/{project_id}/sku-info/*`**（project-scoped，对齐货件/店铺/新品域；与既有镜像路径同形，便于 D2 收口） |
| **D2 读侧收口** | 镜像保留 vs 原生收口 | **收口进原生 `sku_info` 域**：读路由原生实现 + `business_scope("sku_info")` 门禁；镜像路径 `/external/projects/{project_id}/sku-info` 加入 `external_mirror.py._EXCLUDED_EXTERNAL_PATHS`（对齐 BLF-457/470/502 三域先例）。理由：①镜像无 business_scope 门禁（任何有项目权限的 agent 都能读，scope 无法细分）；②镜像字段子集（无工厂信息/图片/审计）；③双路径长期维护漂移 |
| **D3 端点清单** | 读/写 | **读 3 条 + 写 3 条**（§4 R1–R3 / W1–W3）。**删除、换项目、批量(bulk)、import-csv 不开放**：删除→下架（is_active=false）替代（D8）；「换项目」内部**无此端点**（`/move` 实为排序移动，代码核实 `sku_info.py:372-403`）——需新后端能力，超本域范围；bulk/import-csv→批量写风险高 + CSV 面向文件上传，Agent 逐条 W1（每条独立 confirm），后续如需批量再评 |
| **D4 source 溯源枚举 + source_file 派生** | — | 写路由**必填** `source`（溯源枚举，**禁 manual**——审计溯源要求声明渠道）；schema 定义新 `AgentSkuSource = Literal["agent_listing_pull", "agent_user_supplied", "external_api"]`（对齐 `AgentCalculationSource` 模式，裁剪不适用的 review_scrape/market_research，新增 agent_user_supplied 覆盖「用户对话提供」渠道）。`source_file` **不接受 Agent 传值**，服务端派生 `agent:<agent_id>`（主数据溯源列与审计双轨可追溯）。`sku_factory_info_updated_by` 传 `agent_id`（复用 update 函数 operator 参数语义） |
| **D5 confirm / 幂等 / 审计** | — | W1/W2/W3 **全部 confirm 两步流**（`@require_confirmation`，TTL 300s）+ 写桶限流（`require_agent_write_rate_limit`）+ Idempotency-Key 幂等。审计：`operator=NULL`、`agent_id` / `idempotency_key` 归因（spec §4.2）；action 命名 `sku_info.upsert` / `sku_info.update` / `sku_info.status.transition`，`target_type="sku_info"`、`target_id=<record id>`；confirm 预览带下游影响提示（下架/改成本影响面见 §6） |
| **D6 错误码** | — | 新增 **`SKU_INFO_INVALID_SOURCE`**（400，对齐 `NEW_PRODUCT_CALCULATION_INVALID_SOURCE`）与 **`SKU_INFO_DUPLICATE`**（409，W2 更新后与现有记录重复，对齐 `SHIPMENT_DUPLICATE_NO` 409 语义）。复用：`VALIDATION_FAILED` / `RESOURCE_NOT_FOUND` / `AGENT_PROJECT_OUT_OF_SCOPE`（403）/ `AGENT_BUSINESS_OUT_OF_SCOPE`（403）/ confirm 三码。**无其它新码** |
| **D7 缓存失效** | — | W1/W2 写后调用 `invalidate_financial_series_cache(project_id)`（fob/first_leg 成本字段喂 PT4 财务汇总，`report/pt4.py:295`）；W3 上/下架同样失效（is_active 参与补货/报表过滤）。S2 把 `_invalidate_financial_cache` 从端点文件下沉到服务层供 agent 路由复用 |
| **D8 is_active 语义** | — | 上/下架 = `is_active` **软切换**（非删除）：`true` 上架 / `false` 下架。下架 SKU **自动退出**下游消费（product_analysis / 货件成本汇总 / 定时报表均按 `is_active=True` 过滤，§6），历史数据保留、可重新上架。W3 预览必须明示「下架后该 SKU 将退出补货/报表/店铺测算默认消费」 |

## 4. 端点清单（R1–R3 读，W1–W3 写）

挂载：`agent/__init__.py` 兜底路由之前 `include_router(sku_info_router, dependencies=[Depends(require_business_scope("sku_info"))])`；每条路由内 `_scope=Depends(require_project_scope)`（项目白名单，不在范围 → 403 `AGENT_PROJECT_OUT_OF_SCOPE`）。

### 公共约定（对齐 agent-api-design v0.7）

- 鉴权：Bearer + `X-Agent-Id`（命名空间默认）+ 读限流；写路由加 `require_agent_write_rate_limit`。
- 响应壳：`agent_ok` → `{ ok: true, data: ... }`；confirm 预览 → HTTP 200 + `ok:false, requires_confirmation:true`（协议正常一步）；错误走 `app/api/agent/errors.py`。
- 项目不存在（路径 project_id 无 Project 行）→ 404 `RESOURCE_NOT_FOUND`（`_get_project_or_shell_404` 模板）。
- **不暴露**：`*_r2_key` 内部存储键、`source_file`（Agent 写路径；读侧 `sku_factory_info_updated_by` 正常返回）。暴露 URL 类字段（`fnsku_label_r2_url` / `product_image_r2_url` / `product_image_thumbnail_r2_url`）。
- 空结果列表 → 200 + 空 `items`；资源本身不存在（record id 无行）→ 404。

### R1 列表 — `GET /api/v1/agent/projects/{project_id}/sku-info`

- 参数：`country`（可选，2 字母，`normalize_country` 归一）、`is_active`（**默认 true**，对齐镜像；显式 `=false` 查下架）、`sku` / `asin`（可选，ilike 模糊）、`page`（默认 1）、`page_size`（默认 200，≤500）、`include_total`（默认 false）。
- 复用：`list_sku_records(db, None, sku, asin, country, is_active, page, page_size, include_total, managed_project_ids=[project_id])`（服务层已支持 `managed_project_ids` 项目白名单过滤——`crud.py:250-251`，`SkuRecord.project_id` 有索引；0 改造）→ `_serialize_sku_record` 同构行。
- 响应：`{ ok, data: { items: [SkuRecordItem]， page, page_size, total, has_next } }`。
- 不落审计（读侧与内部 `append_operation_view_log` no-op 决策一致）。

### R2 单 SKU 详情 — `GET /api/v1/agent/projects/{project_id}/sku-info/{sku_record_id}`

- 参数：`sku_record_id`（路径，record 行 id——稳定、与审计 target_id 一致）。
- 复用：直接 `db.get(SkuRecord, id)` + 校验 `row.project_id == project_id`；不存在或跨项目 → 404 `RESOURCE_NOT_FOUND`（直取语义，对齐 account_health R4）。
- 响应：`SkuRecordItem` 全字段（含 `sku_factory_info` / 图片 url / `marketplace_url`）+ `created_at` / `updated_at`。**不返回 `*_r2_key` / `source_file`**。
- 不落审计。

### R3 审计 — `GET /api/v1/agent/projects/{project_id}/sku-info/{sku_record_id}/audit`

- 参数：`limit`（默认 50，≤200）。
- 复用：`query_operation_audit_log_for_targets(db, target_type="sku_info", target_ids=[id], limit)`（new_product_calculations R3 同构）。
- 响应：`{ ok, data: { sku_record_id, items: [审计行] } }`——行含 `action / agent_id / operator / idempotency_key / result / before / after / error_message / created_at`；对 Agent 而言**只显示 agent 渠道的写轨迹**（人工前端操作走 operator 列，可一并展示以完整追溯）。

### W1 新建 / 更新 SKU（upsert）— `POST /api/v1/agent/projects/{project_id}/sku-info`

- 语义：与内部 `POST /sku-info` 一致——**upsert**（唯一键 `(project_id, sku, asin, country)` 命中则更新、否则插入），`action=inserted/updated`。**新增与更新同路由**（命中与否由服务层判定，Agent 无需预查询；confirm 预览会给出 is_new + previous 摘要）。
- confirm 预览：`{ action: "sku_info.upsert", sku, asin, country, is_new, previous: {...}|null, source, note }`——note 提示「将写入主数据，成本字段影响财务/测算，请确认」。
- 业务校验（先于 confirm 签发，`validate` 回调）：`source` 枚举合法（否则 `SKU_INFO_INVALID_SOURCE`）；`sku` / `asin` 非空；`country` 2 字母；金额/尺寸 ≥0（schema `ge=0` 已兜，validate 二次兜底）；项目存在。
- 执行：`SkuRecordCreate(project_name=project.project_name, **body)` → `upsert_sku_record(db, payload, source_file=f"agent:{agent_id}")` → 审计 `sku_info.upsert`（before=原有行 / after=新行快照）→ `invalidate_financial_series_cache(project_id)`（D7）→ commit。
- 响应：`{ ok, data: SkuRecordItem, action, idempotency_key }`。

### W2 更新规格 / 成本 — `PATCH /api/v1/agent/projects/{project_id}/sku-info/{sku_record_id}`

- 语义：按 record id **局部更新**（与内部 `PATCH /sku-info/{id}` 对齐）。⚠️ **内部 `SkuRecordUpdate` 存在默认值陷阱**（`asin=""` / `country="US"` / `is_active=True` 缺失即回填，`crud.py:448-565` 对 asin/country/currency/is_active 是**无条件覆盖**）——S2 实现**必须**采用「读-改-写」合并：路由层先取当前行，只把 Agent 请求**显式提供**的字段（`model_fields_set`）合并进当前值，构造完整 `SkuRecordUpdate` 再调服务（对齐货件域 PATCH 先读后合并先例，`2026-08-04-agent-readwrite-api-spec.md §5.1`）；或在 agent schema 层全 Optional + 按字段集只更新提供字段。**两个方案二选一，S2 用测试锁契约**（只传 `fob_unit_cost` 不得重置 asin/country/is_active，§7 #5）。
- 允许更新字段：fnsku / product_name / fob_unit_cost / first_leg_cost_rmb / 包装尺寸 / 重量 / 箱规 / units_per_carton / is_active / sort_order / sku_factory_info。身份字段（sku / asin / country）**不允许在 W2 变更**（改身份 = 重建主数据，走 W1 或人工；避免唯一键意外迁移）。
- confirm 预览：`{ action: "sku_info.update", sku_record_id, sku, changed: {字段: {from, to}}, source, note }`——note 明示「修改成本/规格将影响下游计算（§6）」。
- 业务校验：`source` 合法；record 存在且属于该项目（否则 404）；更新后唯一键冲突 → `SKU_INFO_DUPLICATE`（409）。
- 执行：`update_sku_record_by_id(db, id, merged, source_file=f"agent:{agent_id}", operator=agent_id)` → 审计 `sku_info.update`（before/after）→ 缓存失效（D7）→ commit。
- 响应：`{ ok, data: SkuRecordItem, idempotency_key }`。

### W3 上 / 下架 — `POST /api/v1/agent/projects/{project_id}/sku-info/{sku_record_id}/status`

- 语义：`{"is_active": true|false}`（true 上架 / false 下架）；**幂等**——目标值与当前一致时直接返回当前态（不重复审计）。实现复用 W2 的合并路径（`is_active` 单字段）。
- confirm 预览：`{ action: "sku_info.status.transition", sku_record_id, sku, from_active, to_active, source, note }`——note 明示「**下架后该 SKU 将退出补货分析/定时报表/店铺测算默认消费（按 is_active=True 过滤），历史数据保留，可随时重新上架**」。
- 业务校验：`source` 合法；record 存在且属于该项目；`is_active` 为 bool。
- 执行：合并 `is_active` → `update_sku_record_by_id` → 审计 `sku_info.status.transition`（before/after 含 is_active 变化）→ 缓存失效（D7）→ commit。
- 响应：`{ ok, data: SkuRecordItem, idempotency_key }`。

### 明确不开放的端点（D3）

| 内部能力 | 结论 | 理由 |
|---|---|---|
| `DELETE /sku-info/{id}` | ❌ 不开 | 物理删除不可逆；下架（W3）已覆盖业务诉求；对齐 readwrite spec §9「删除对 Agent 开放 = admin only」先例 |
| `/sku-info/{id}/move`（排序） | ❌ 不开 | UI 微操作，无 Agent 场景 |
| 换项目（改 project_id） | ❌ 不开 | 内部无此能力（`/move` 是排序移动）——需新后端能力，超本域范围 |
| `/sku-info/bulk`、`import-csv`、`import-blf-basic-info` | ❌ 不开 | 批量写风险高；CSV 面向文件上传；Agent 逐条 W1（每条独立 confirm） |
| `recalculate-first-leg-costs`、`sync-first-leg-from-shipment` | ❌ 不开 | 服务端派生动作（重算/同步），Agent 只写事实值；头程同步会**回写覆盖** first_leg_cost_rmb（§6 #3 影响面注明） |
| 图片 / FNSKU 标签上传（含验证） | ❌ 不开 | 涉及文件上传 + 二进制验证 + R2 写入，Agent 无此场景（S2 后可评） |

## 5. 必要元素定稿（逐端点字段 + 校验）

### 5.1 W1 新建 / upsert 请求字段表（`AgentSkuRecordUpsertRequest`）

| 字段 | 必填 | 类型 / 约束 | 说明 |
|---|---|---|---|
| `sku` | ✅ | str，非空 | 唯一键组成 |
| `asin` | ✅ | str，非空 | 唯一键组成；主数据要求（内部允许空串，Agent 收紧） |
| `country` | ✅ | str，2 字母 | `normalize_country` 归一；唯一键组成 |
| `source` | ✅ | `AgentSkuSource` 枚举 | 溯源渠道（D4）；非法 → `SKU_INFO_INVALID_SOURCE` |
| `fnsku` | ❌ | str? | — |
| `product_name` | ❌ | str? | — |
| `fob_unit_cost` | ❌ | float，`ge=0`，≤1e8 | 缺省 0 |
| `first_leg_cost_rmb` | ❌ | float，`ge=0`，≤1e8 | 缺省 0；**注意可被货件同步回写**（§6 #3） |
| `package_{length,width,height}_cm` | ❌ | float，`ge=0`，≤1e5 | 缺省 0 |
| `weight_kg` | ❌ | float，`ge=0`，≤1e5 | 缺省 0 |
| `carton_{length,width,height}_cm` | ❌ | float，`ge=0`，≤1e5 | 缺省 0 |
| `carton_weight_kg` | ❌ | float，`ge=0`，≤1e5 | 缺省 0 |
| `units_per_carton` | ❌ | int，`ge=0` | 缺省 0 |
| `is_active` | ❌ | bool，默认 `true` | 上/下架（D8） |
| `sort_order` | ❌ | int，`ge=1` | 缺省自动分配（max+1） |
| `sku_factory_info` | ❌ | dict \| null | 工厂属性；null 清除 |

**服务端派生（不接受 Agent 传值）**：`project_id`（路径）、`project_name`（Project 行）、`currency`（恒 CNY，服务层强制）、`source_file`（`agent:<agent_id>`）。

### 5.2 W2 更新请求字段表（`AgentSkuRecordUpdateRequest`）

- 字段同上表**全部 Optional**（不含 sku/asin/country——W2 禁改身份，见 §4 W2）；`source` 必填。
- 语义：只更新显式提供字段（读-改-写合并，§4 W2 / §9 #2）。

### 5.3 W3 状态请求字段表

- `{"is_active": bool}`（必填）+ `source`（必填）。

### 5.4 校验规则汇总

1. **唯一性**：`(project_id, sku, asin, country)`——W1 upsert 命中即更新（无冲突）；W2 更新后冲突 → `SKU_INFO_DUPLICATE`（409）。
2. **金额 / 尺寸**：所有数值字段 `≥ 0`（负值 → `VALIDATION_FAILED`，schema `ge=0` 兜底 + validate 二次兜底）。
3. **country**：2 字母代码，`normalize_country` 归一（非法 → `VALIDATION_FAILED`）。
4. **is_active**：bool；语义 = 上/下架软切换（D8），非删除。
5. **source**：枚举白名单，禁 manual；缺失/非法 → `SKU_INFO_INVALID_SOURCE`（400）。
6. **Idempotency-Key**：可缺失；出现则非空且 ≤64 字符（对齐 spec §3）。

### 5.5 响应与空值语义

- 读：数值字段 DB 非空默认 0（模型 Numeric 非空 + default 0），Agent 侧恒为数值；`sku_factory_info` 未填 → `null`；空结果列表 → 200 + 空 `items`；资源不存在 → 404。
- 写：confirm 预览 HTTP 200 + `requires_confirmation:true`；执行成功 `{ ok: true, data, action?, idempotency_key }`。

## 6. 影响面结论（BEL-93，CodeGraph 核实 2026-08-10）

本域写操作变更 `product_costs` 行，**下游全部是读取方**（无跨域写引用）——影响面 = 读侧语义，无函数签名破坏。CodeGraph 核实 `SkuRecord` 在 `backend/app` 的消费点：

| # | 下游消费者 | 读取字段 | 影响 |
|---|---|---|---|
| 1 | `app/services/report/pt4.py:295`（PT4 财务汇总） | `fob_unit_cost` | **改成本 → 财务汇总口径变化**；内部写已做 `invalidate_financial_series_cache`，Agent W1/W2 必须同样失效（D7） |
| 2 | `app/services/product/analysis/costs.py:39`、`app/tasks/scripts/product_analysis.py:157-173` | `fob_unit_cost` / `is_active` / `country` | 产品成本分析；下架 SKU 退出 |
| 3 | `app/services/shipment/summary.py:154-181`（`sync_first_leg_cost_from_shipment_summary`） | `first_leg_cost_rmb`（**回写**） | ⚠️ 该同步任务按货件平均头程价**覆盖** `first_leg_cost_rmb`——Agent 手写值可能被后续同步覆盖（与内部行为一致，spec 注明非 bug） |
| 4 | `app/services/shipment/schedule.py:503-559`（货件费用核算）、`shipment/item.py:49`（units_per_carton）、FBA 箱规明细 | `carton_*` / `package_*` / `weight_kg` / `units_per_carton` | **改箱规/尺寸 → 货件计费重/体积变化 → 物流费用变化**（W2/W3 预览 note 明示） |
| 5 | `app/services/scheduled_report/report_builder_{daily,weekly,monthly}.py`、`context_helpers.py` | `product_name` / `sku_factory_info` / `is_active` | 定时报表名称/工厂属性展示；下架 SKU 退出（`is_active == True` 过滤） |
| 6 | `app/api/v1/endpoints/agent/shop_calculations.py:334-337` | `SkuRecord.sku` 存在性 | 店铺测算写前校验 SKU 存在；下架 SKU 仍存在（仅 is_active=false）→ 校验不受影响 |
| 7 | `app/services/project_service.py:433` | `project_name` 列表 | 只读，无影响 |
| 8 | 既有 external 镜像读路由（收口前） | 全字段子集 | D2 收口后由原生 R1/R2 替代，镜像排除 |

**服务层 0 存量调用方受影响**：`upsert_sku_record` / `update_sku_record_by_id` / `list_sku_records` 的 callers 全部在 `sku_info.py` 内部端点 + 服务内部（bulk/import 复用）——Agent 路由**直接复用现有服务函数**，不改签名、不新增 service 副本（R2 纯读 `get_or_create` 类副作用问题**不存在**——本域无建行副作用函数，全量复用）。

**新增面**：`agent/__init__.py` 追加一个 `include_router`（兜底路由之前）+ `agent_api_keys.business_scope` 加值 `sku_info`（字符串列，无迁移）+ `external_mirror.py` `_EXCLUDED_EXTERNAL_PATHS` 加一条 + `errors.py` 加 2 码 + `app/schemas/agent_sku_info.py` 新增 + `backend/app/api/v1/endpoints/agent/sku_info.py` 新增 + 前端 `lib/agent-domains.ts` 注册表加一条（S3）。

## 7. 测试清单（供 S2 实施）

1. **W1 upsert**：新建（inserted）→ 同键重放（updated，不产生新行）；confirm 预览 is_new/previous 正确；`source_file` 落 `agent:<agent_id>`；非法 source → `SKU_INFO_INVALID_SOURCE`（400，先于 confirm 签发）。
2. **W1 校验**：缺 sku/asin → `VALIDATION_FAILED`；负成本 → `VALIDATION_FAILED`；非法 country → `VALIDATION_FAILED`；项目不存在 → 404。
3. **W2 局部更新**：只传 `fob_unit_cost` → **asin/country/is_active 不被重置**（§9 #2 陷阱锁契约）；更新后唯一键冲突 → `SKU_INFO_DUPLICATE`（409）；改身份字段（sku/asin/country）→ `VALIDATION_FAILED`。
4. **W3 上/下架**：false → is_active=false 且审计 before/after 含变化；同值重放幂等（不重复审计）；下架后 R1 默认 `is_active=true` 不再返回该 SKU（`is_active=false` 可查）。
5. **缓存失效**：W1/W2/W3 写后断言 `invalidate_financial_series_cache` 被调用（mock）——与内部端点行为对齐。
6. **R1/R2/R3**：分页/筛选；`is_active` 默认 true；record 不存在或跨项目 → 404；R3 审计行含 agent_id/idempotency_key；读不落审计（行数不变）。
7. **scope 门禁**：business_scope 不含 `sku_info` → 403 `AGENT_BUSINESS_OUT_OF_SCOPE`；project 不在白名单 → 403 `AGENT_PROJECT_OUT_OF_SCOPE`。
8. **confirm 流**：无 X-Confirm-Token → 200 预览壳；重放 body 不一致 → `CONFIRM_TOKEN_INVALID`；过期 → `CONFIRM_TOKEN_EXPIRED`；Idempotency-Key 复用不同 body → `IDEMPOTENCY_KEY_CONFLICT`。
9. **路由注册**：`agent/__init__.py` 兜底路由之前；镜像路径已排除（`_EXCLUDED_EXTERNAL_PATHS` 含 sku-info）。
10. **回归**：内部 `/api/v1/sku-info/*` 行为不变（服务函数零改动）；外部镜像收口后 `/agent/projects/{id}/sku-info` 仍 200 且走原生 handler（路由数量不重复）。

## 8. 阶段规划（BLF-579 S2–S3）

| 阶段 | 规划 | 范围 |
|---|---|---|
| **S1 设计定稿**（本 issue，本 run） | 本 spec | 现状梳理 + D1–D8 拍板 + 端点清单 + 必要元素 + confirm/溯源/幂等契约；**无代码变更**；spec 落库 PR 随本阶段提交 |
| **S2 实施**（backlog） | 照本 spec §4/§5/§7 | 新增 `backend/app/api/v1/endpoints/agent/sku_info.py` + `backend/app/schemas/agent_sku_info.py` + `errors.py` 2 码 + `external_mirror.py` 排除 + `agent/__init__.py` 挂载（business_scope("sku_info")）+ 服务层 `_invalidate_financial_cache` 下沉 + 测试。**无 DB 迁移**（复用 `product_costs`）。risk:high（首个主数据写域，影响财务/补货/报表） |
| **S3 上线收尾**（backlog） | 照 BLF-526 模板 | 前端 `lib/agent-domains.ts` 注册表加域（`sku_info`，live，读+写，routeCount 6）+ agent-usage-guide 调用说明 + BLF-479 §2.10 行状态同步 + 归档 BLF-579 |

## 9. 风险与开放问题

1. **`first_leg_cost_rmb` 可被货件同步回写**（`sync_first_leg_cost_from_shipment_summary`）：Agent 手写头程价会被后续同步覆盖——与内部行为一致，spec 注明；如需 Agent 侧「锁定」头程值需新能力（超本域范围）。
2. **内部 `SkuRecordUpdate` 默认值陷阱**（W2 必防）：`asin=""` / `country="US"` / `is_active=True` 缺失即回填（`crud.py:448/517/565` 无条件覆盖）。S2 用读-改-写合并或字段集驱动更新，**测试锁契约**（§7 #3）；不改服务函数（0 存量影响），避免把内部行为改坏。
3. **`asin` 必填 vs 未上架新 SKU**：Agent 创建**尚未上架**的 SKU 时 ASIN 未知——本 spec 收紧为必填（主数据干净 + 避免空串唯一键碰撞）。若 S2 遇到真实「预上架 SKU」场景，可评估放宽为可选（空串 + 唯一键碰撞警告），需用户拍板。
4. **W1 upsert 与 W2 patch 双路径**：同一 SKU 两种写入口（按唯一键 vs 按 id）——语义清晰（W1=整体建立/覆盖，W2=定点修改），但 Agent 需按场景选择；usage-guide（S3）写清「改成本/规格用 W2、建新 SKU 用 W1、上/下架用 W3」。
5. **生产库数据量实查**：本轮 S1 未做 VPS 实查（代码核实充分）；S2 实施时如需要可补「product_costs 行数 / is_active 分布」快照，评估 R1 分页默认值是否合理。
6. **`sku_factory_info` 为自由 JSON**：Agent 写入前应先用内部 `batch-parse-factory-info`（AI 解析）得到结构化键值对；直接写自由 JSON 可能污染下游（`context_helpers.py` 读取）——usage-guide 提示，不强制 schema 约束（S2 可评）。

## 版本记录

- v0.1（2026-08-10）：BLF-579 S1 设计定稿。内容基于 2026-08-10 代码核实：`SkuRecord` 模型（`backend/app/models/sku_info.py`）、内部 18 端点（`backend/app/api/v1/endpoints/sku_info.py`）、服务层（`backend/app/services/data/sku_info/crud.py`）、agent 基础设施（`app/api/agent/{confirm,scope,errors}.py`）、external 镜像（`app/api/v1/endpoints/agent/external_mirror.py`）、前端注册表（`frontend/lib/agent-domains.ts`）；影响面经 CodeGraph（29,590 nodes / 66,958 edges）`callers`/`search` 核实（§6）。
