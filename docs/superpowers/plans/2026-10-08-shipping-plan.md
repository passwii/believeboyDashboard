# 发货规划实施计划

> 状态：实施中（BLF-1284）

> **面向 AI 代理的工作者：** 使用 executing-plans 或 subagent-driven-development 逐任务实施；先写失败测试，再实现，最后验证。每项步骤使用 checkbox 跟踪。

**目标：** 新增独立「发货规划（Shipping Plan）」页面，以 SKU 增长系数、正式货件和预期计划分析未来 180 天供给约束下的销售上限；将现有页面准确命名为「货件管理（Shipment Management）」。

**架构：** 新页面只保存未落实计划、SKU 增长系数以及计划与正式货件的数量关联；正式货件继续以现有货件表为唯一数据源。后端复用补货分析的销售需求基线和库存快照，用独立纯函数进行逐日供给模拟，再返回确定/计划两种情景与去年同期 `orderSales` 参照；前端只展示 API 结果，不重写预测公式。历史发运按 ETD 日期统计；站点日期以 API 返回的 `as_of_date` 为准。

**技术栈：** FastAPI、SQLAlchemy、Alembic、Pydantic、PostgreSQL/SQLite、Next.js App Router、React、Vitest、Playwright。

## 全局约束

- 新页面路由：`/dashboard/operations/shipping-plan`；导航名称「发货规划」，英文标识 `shipping-plan`。现有路由 `/dashboard/operations/shipment-management`、API `/shipment-schedules` 和技术标识保持不变，仅用户可见名称统一为「货件管理」，英文名称 `Shipment Management`。
- 导航中「发货规划」紧邻「货件管理」，顺序为先规划、后管理。
- 增长系数按 `(project_id, country, sku)` 配置，是需求倍率；缺省 `1.0`，V1 手工维护。将“系数来源解析”与预测算法隔离，未来可以增加系统自动核算来源而不改模拟器。
- 发货规划预测/计划管理要求选择单一站点；全局站点为 `ALL` 时显示选择站点提示，不把不同站点下同名 SKU 合并计算。
- 预测需求 = 现有补货分析的基础加权日均销量 `base_dms` × SKU 增长系数。复用 30/14/7/3 天加权口径；不叠加 `safety_factor`。去年同期 `orderSales` 仅作参考，不参与任何需求或上限计算。
- 预测范围固定 180 天，按天模拟；`as_of_date` 为站点当天，预测从次日开始，180 天区间包含预测起始日、不包含 `start_date + 180`；第 1–90 天逐日展示，第 91–180 天按自然月聚合展示，并显示每个聚合区间裁剪后的起止日期。
- 确定情景供给 = 当前可售库存 + `in_transit` 货件 + 预测期内 `actual_inbound_date` 晚于库存快照日期的 `completed` 货件（按实际入仓日作为未来供给日期）。计划情景在确定情景上增加 `draft` 货件 + 未落实的有效预期计划。实际入仓日期不晚于库存快照日期的已完成货件视为已包含，不再重复加入。
- 正式货件的历史发运量按 ETD 日期统计 `in_transit` / `completed` 货件；ETD 明确标注为 V1 发运日期代理口径，不冒充实际离港记录。缺 ETD 货件不放入日期桶并单独提示。既有 `include_in_history_shipping_calc` 只控制物流成本历史计算，不用它过滤本页的发运件数/数量。
- 未建正式货件的预期计划按「计划批次 + 预计到仓日 + SKU + 数量」维护。计划数量关联正式货件后，从计划剩余量扣除，由货件自己的状态与 ETA 接替；部分关联时余额仍参与计划情景。关联对象使用 `(shipment_schedule_id, sku)` 稳定业务键，不使用会因货件明细替换而重建的明细行 ID。
- 关联数不得超过计划剩余量，也不得超过对应正式货件 SKU 尚未被所有计划关联占用的数量。关联只允许同项目、同站点、同 SKU 的 `draft` / `in_transit` 货件；不允许 `completed`。同一 `(plan_item_id, shipment_schedule_id)` 重复提交返回冲突，不隐式累加；需调整时先解除旧关联再创建新关联。V1 只提供取消计划，不提供批次/明细硬删除；取消计划后未关联余额退出预测，已关联货件仍按货件状态计算。若正式货件通过既有管理路径删除，allocation 由外键级联清理，恢复仍有效计划的余额。替换货件明细若移除有关联 SKU 或将数量降至已关联量以下，后端拒绝并要求先调整关联。
- 货件 ETA 解析顺序：`eta_date` → `etd_date + shipping_days` → `created_date + shipping_days`；无日期数据的数量显示在明细/提示中，但不擅自放入某一天。
- 未完成货件的解析 ETA 早于预测起始日时标记为「ETA 已逾期」，不假设它已经入仓，也不擅自作为起始库存或某天到货；数量在数据质量提示中独立展示，待货件 ETA/状态更新后重新纳入时间线。
- 对 `completed` 货件，仅当 `actual_inbound_date` 与库存快照日期都存在且前者晚于后者时，才按实际入仓日纳入两个情景；`actual_inbound_date` 不晚于快照日期视为已包含。缺任一比较日期时显示为「入仓状态未核实」，不自动加入供给，且不得用 ETA 代替 actual inbound date。
- 若 completed 货件实际入仓日在库存快照日之后、但早于预测起始日，现有库存快照无法代表预测起点库存，且无法仅凭收货量还原期间销售/调整；将该 SKU 标记为「快照后已入仓、库存待核实」，不把收货量伪装成未来到货，也不返回精确销售上限，提示更新库存快照后再计算。实际入仓日等于预测起始日时按当天到货计入。
- 有效预期批次的预计到仓日早于预测起始日时标记为「计划已逾期」，不直接把计划数量并入初始库存；显示过期量并要求用户调整计划日期后再纳入未来时间线。
- 到货日当天计入可售供给；每天销量为 `min(预测需求, 当日可用库存)`；未满足需求不滚存到未来日期；使用 Decimal，不逐日取整。两个情景分别从同一库存基线模拟，计划情景销量不得低于确定情景。
- 缺少销量基线或库存快照时不伪造精确上限，返回数据质量状态并显示快照日期、销量基线日期范围和缺失原因。SKU 汇总同时返回有效预测 SKU 数与缺失 SKU 数；任何合计不得把未知 SKU 按 0 隐式计入。历史销量没有记录与真实 0 销量可区分：仅当销售报表覆盖证明某日完整时，缺少订单行才可呈现为 0；覆盖不足时为 null。
- 读写 API 沿用 `protected`、`project_service.ensure_project_access`、审计、读/主库依赖；V1 不新增 Agent scope，不改造 Agent 货件域。
- 建迁移前必须 `git fetch origin && git rebase origin/main`、确认 `alembic heads` 唯一，再使用递增纯数字 revision；计划草案中的“当前最新编号 278”已过时，不得据此命名。实施前本工作树已 fetch 得到 `origin/main`，检查到的唯一 head 为 `279`；正式迁移仍须在后端负责人 rebase 后重新检查真实 head。迁移和依赖它的代码同批上线。
- 该变更涉及模型、迁移、schema、权限/API，按仓库 T3：后端全量 `pytest` 一次、前端全量 `pnpm test` 一次、`pnpm lint`，迁移检查必跑；build 交 Vercel。
- Commit 使用中文 Conventional Commits；PR 标题、PR 分节抬头均用中文。

---

## 已批准的业务设计

### 页面边界

**实施文档勘误（2026-10-08）：** 初始外部草案曾写 Alembic 最新编号为 278；该数字已失效，本 worktree 在同步 `origin/main` 后观察到的 head 是 279，迁移负责人开工仍需 rebase 后复核。预测日期按站点当天的次日为第 1 天，覆盖 `[start_date, start_date + 180 天)`。allocation 对同计划明细与货件的重复 POST 返回冲突、不静默累加；V1 计划仅取消并保留记录、不开放硬删除。以上修订取代本文其他冲突/模糊的表述。

| 页面 | 英文 | 职责 | 写入数据 |
| --- | --- | --- | --- |
| 发货规划 | Shipping Plan | 发货量趋势、预期到货计划、销售上限、SKU 增长系数 | 预期批次、SKU 系数、计划-货件数量关联 |
| 货件管理 | Shipment Management | 已建立正式货件、物流状态、ETD/ETA、实际入仓、货件 SKU 明细 | 现有正式货件 |

发货规划不得复制正式货件信息；“关联货件”只记录计划数量接替关系，货件编号、状态、ETA 和 SKU 数量仍来自现有货件表。

### 计算口径

```text
基础日需求 = 补货分析未乘安全系数的 base_dms
预测日需求 = 基础日需求 × SKU 增长系数
每日情景销量 = min(预测日需求, 当日到货后可用库存)
每日结余库存 = 当日到货后可用库存 - 每日情景销量
累计销售上限 = 预测区间内每日情景销量之和

确定供给 = 当前可售库存 + 未来 ETA 的 in_transit 货件
             + 预测期内且 actual_inbound_date 晚于库存快照日期的 completed 货件
计划供给 = 确定供给 + 未来 ETA 的 draft 货件 + 未关联的有效预期计划余额
```

`base_dms` 使用现有 30/14/7/3 天窗口：30 天×10%、14 天×30%、7 天×30%（3 天窗口可用时）、3 天×30%；3 天不可用时 7 天为 60%；缺失窗口按现有服务规则对有效权重重新归一化。不得把 `weighted_dms`（已经叠加安全系数）当作销售需求。

去年同期参照使用同 SKU、同站点、已计入销售的 `orderSales`，按预测日减 365 天映射，与现有季节性对比日期口径一致；销售报表没有完整覆盖的日期返回缺失；有完整报表覆盖但没有订单行才显示 0。该参照不参与预测计算。

### 页面组成

> 页面名称在旧计划草案中曾称“发货管理”；该用词已统一更正为“货件管理”，不改动稳定路由、API 和 Agent 技术标识。

- 筛选：项目、站点、SKU；接入终端全局项目/站点筛选；180 天预测范围固定。
- 概览：按 ETD 月度发运量、确定/计划供给摘要、库存快照日期及距预测起始日的库存数据年龄、有效/缺失预测 SKU 数、缺失/逾期 ETA 提醒。
- SKU 表：库存、在途/草稿、计划余额、基础日需求、增长系数、确定/计划 180 天销售上限、数据质量；支持调整 SKU 系数。
- 图表：需求、确定情景销量、计划情景销量、去年同期实际销量分层对比；前 90 天逐日、后 90 天按自然月。
- 预期计划：批次创建/编辑/取消，批次内多 SKU；可部分关联到既有正式货件。只读查看正式货件，不提供创建、编辑状态或删除正式货件操作。

## 文件结构与职责

**后端**
- 新增 `backend/app/models/shipping_plan.py`：SKU 增长系数、计划批次、计划 SKU 明细、货件关联模型；在 `backend/app/models/__init__.py` 注册。
- 新增 `backend/alembic/versions/YYYYMMDD_NNN_shipping_plan.py`：四表、唯一/检查约束、外键和索引。
- 修改 `backend/app/services/inventory/replenishment.py`：提供新的窄范围公开读取函数，复用 SKU、库存快照、`base_dms` 计算，不复制补货公式。
- 新增 `backend/app/services/shipping_plan/{__init__.py,forecast.py,service.py}`：纯预测函数与 DB 编排分开；service 负责 ETD/到货、历史销量、批次 CRUD、系数、关联校验。
- 新增 `backend/app/schemas/shipping_plan.py`、`backend/app/api/v1/endpoints/shipping_plan.py`；在 `backend/app/api/v1/router_groups/inventory_group.py` 注册。
- 修改 `backend/app/services/shipment/item.py`：保护已有计划关联不被货件 SKU 明细替换破坏。
- 新增后端测试：`backend/tests/models/test_shipping_plan_models.py`、`backend/tests/services/inventory/test_shipping_plan_baseline.py`、`backend/tests/services/shipping_plan/test_forecast.py`、`backend/tests/services/test_shipment_plan_allocation.py`、`backend/tests/services/test_shipment_item_allocation_guard.py`、`backend/tests/api/test_shipping_plan_{read,settings,batches}_api.py`。仓库当前没有独立迁移测试目录；迁移使用 `check_alembic.py` 加本地 `BLF_test` 升级/降级实测验证。

**前端与文档**
- 新增 `frontend/app/dashboard/operations/shipping-plan/page.tsx`、`shipping-plan-client.tsx`，组件 `components/{forecast-chart,sku-forecast-table,plan-batch-manager,plan-batch-dialog}.tsx`。
- 修改 `frontend/lib/sidebar-config.ts`、`frontend/lib/dashboard-route-meta.ts` 和 `frontend/components/terminal/global-filter-context.tsx`；更新各自既有测试。
- 新增页面组件/集成测试和 `frontend/tests/dashboard/shipping-plan.spec.ts`；在 `frontend/tests/crawl/discovery.spec.ts` 注册页面。
- 新增 `docs/发货规划.md`；按需要仅补充 `docs/REFERENCE.md` 和 `docs/库存补货分析.md` 的模块边界说明，不改变补货语义。

---

## Task 1：数据模型与迁移

**接口：** `ShippingPlanSkuSetting(project_id,country,sku,growth_factor)`、`ShippingPlanBatch(project_id,country,name,expected_arrival_date,status,remark)`、`ShippingPlanItem(batch_id,sku,quantity)`、`ShippingPlanAllocation(plan_item_id,shipment_schedule_id,sku,quantity)`。系数默认 `Numeric(8,4)=1.0` 且非负；状态为 `active|cancelled`；计划与关联数量均为正整数。批次 SKU 唯一；系数唯一键 `(project_id,country,sku)`；allocation 对 `(plan_item_id,shipment_schedule_id)` 唯一。数据库 FK 删除计划明细/批次或正式货件时会清理对应明细/关联，但 V1 API 仅允许取消批次，不开放计划硬删除。

**文件：** 模型、`models/__init__.py`、递增数字 Alembic 迁移、模型/迁移测试。

- [ ] **步骤 1：先写失败测试**：覆盖站点级系数隔离、重复系数唯一约束、负系数拒绝、同批 SKU 唯一、计划/关联数量 >0、计划和货件删除级联；将模型 DDL/metadata 和 FK 约束纳入断言。
- [ ] **步骤 2：确认红灯**：`cd backend && python -m pytest tests/models/test_shipping_plan_models.py -q`；失败应来自模型缺失/约束缺失。
- [ ] **步骤 3：同步并创建迁移**：`git fetch origin && git rebase origin/main`；`cd backend && alembic heads` 确认唯一 head，再根据真实 head 生成 `YYYYMMDD_NNN_shipping_plan.py` 与纯数字 revision，禁止裸跑随机 revision。
- [ ] **步骤 4：实现模型与迁移**：主键统一使用 `Integer`；FK 类型与现有 referenced model 对齐；迁移 upgrade/downgrade 对称，约束和索引与模型一致。
- [ ] **步骤 5：验证**：运行模型测试、`python scripts/check_alembic.py`；在本地 `BLF_test` 执行 upgrade head、downgrade -1、upgrade head，确认单 head。
- [ ] **步骤 6：提交**：`git add backend/app/models/__init__.py backend/app/models/shipping_plan.py backend/alembic/versions backend/tests/models/test_shipping_plan_models.py`；中文提交示例：`feat(发货规划): 建立预期批次与系数模型`。

## Task 2：复用销量基准与纯预测引擎

**接口：** 在 `inventory/replenishment.py` 新增公开读取函数 `load_shipping_plan_baseline(db, *, project_id, country, as_of_date) -> ShippingPlanBaseline`，按 SKU 返回当前可售量、库存报告日期、基础 `base_dms`、商品信息及运输天数。新增纯函数：

```python
@dataclass(frozen=True)
class ShippingPlanBaselineItem:
    sku: str
    asin: str | None
    product_name: str | None
    available_inventory: int | None
    inventory_snapshot_date: date | None
    base_dms: Decimal | None
    shipping_days: int

@dataclass(frozen=True)
class ShippingPlanBaseline:
    project_id: int
    country: str
    as_of_date: date
    items: tuple[ShippingPlanBaselineItem, ...]

@dataclass(frozen=True)
class SupplyArrival:
    arrival_date: date
    quantity: int

@dataclass(frozen=True)
class DailyForecastPoint:
    forecast_date: date
    demand: Decimal | None
    confirmed_sales: Decimal | None
    planned_sales: Decimal | None
    confirmed_closing_inventory: Decimal | None
    planned_closing_inventory: Decimal | None

def simulate_sku_forecast(
    *, start_date: date, horizon_days: int,
    available_inventory: int | None, base_dms: Decimal | None,
    growth_factor: Decimal,
    confirmed_arrivals: Sequence[SupplyArrival],
    planned_only_arrivals: Sequence[SupplyArrival],
) -> list[DailyForecastPoint]: ...
```

**文件：** `inventory/replenishment.py`、`services/shipping_plan/forecast.py`、以上基准和纯函数测试。

- [ ] **步骤 1：写基准失败测试**：同 SKU 调用新读取函数与现有补货列表，断言 `base_dms` 完全一致、且没有乘 `safety_factor`；覆盖缺失销售窗口归一化、无销量、缺快照、快照日期和项目/站点隔离。不同站点同名 SKU 不得被合并。
- [ ] **步骤 2：验证红灯**：`cd backend && python -m pytest tests/services/inventory/test_shipping_plan_baseline.py -q`。
- [ ] **步骤 3：增加公共基准读取函数**：内部复用现有 SKU/库存/DMS loader 和 `_normalize_weighted_dms`，以新公开函数封装；不复制 SQL，不让新服务直接 import 私有 helper。
- [ ] **步骤 4：写纯函数失败测试**：无到货、到货日当天入库、两情景差异、售罄与不滚存、系数 0/1/大于 1、缺 DMS/库存返回未知、多批同日合并、预测首尾日期、Decimal 精度；service 测试额外覆盖已逾期未完成货件保持可见但不自动记作已到货。
- [ ] **步骤 5：验证红灯并实现**：`cd backend && python -m pytest tests/services/shipping_plan/test_forecast.py -q`；然后实现纯函数，缺失输入时不计算确定值，确定/计划从同一初始库存独立模拟。
- [ ] **步骤 6：回归与影响检查**：运行上述两目标测试和逾期供给服务测试；`codegraph callers _normalize_weighted_dms`、`codegraph impact _normalize_weighted_dms` 确认原消费者返回字段无变化。
- [ ] **步骤 7：提交**：中文提交示例：`feat(发货规划): 复用补货基准并模拟销售上限`。

## Task 3：预测、历史发运与增长系数 API

**端点：**

| 方法与路径 | 契约 |
| --- | --- |
| `GET /shipping-plan/skus` | SKU 分页列表：库存与日期、base DMS、系数及来源、在途/草稿量、计划余额、两情景 180 天上限、数据质量 |
| `PUT /shipping-plan/skus/{sku:path}/growth-factor` | 写入项目/站点/SKU 手动倍率 |
| `GET /shipping-plan/forecast` | 指定 SKU 的 180 天逐日需求、两情景销售/库存、未来到货、去年同期 `orderSales` 参照 |
| `GET /shipping-plan/shipment-history` | 按 ETD 区间返回历史发运量、货件数、SKU 量及无 ETD 计数 |

预测响应至少包括 `as_of_date`、`inventory_snapshot_date`、`base_dms`、`growth_factor`、`demand_source(manual|default)`、`data_quality`、`daily_points`、`historical_order_sales`、情景合计及 ETA 缺失明细。增长系数默认读取 1.0，不对每个 SKU 懒写配置行。

**文件：** schema、`services/shipping_plan/service.py`、新 endpoint、inventory router group、read/settings API 测试。

- [ ] **步骤 1：写 API 红灯测试**：未认证、无项目权限、跨项目/站点、全局站点 `ALL` 时阻止聚合、默认倍率、合法/负倍率写入、预测缺 SKU 参数、180 天边界、历史销量缺失 vs 0（只有报表覆盖完整才为 0）、历史 ETD 聚合及缺失计数、`draft` 排除且 `in_transit` / `completed` 纳入；不同 `include_in_history_shipping_calc` 值不改变发运件数/数量统计；审计记录。
- [ ] **步骤 2：确认红灯**：`cd backend && python -m pytest tests/api/test_shipping_plan_read_api.py tests/api/test_shipping_plan_settings_api.py -q`。
- [ ] **步骤 3：实现 schema/service**：Decimal 安全序列化；严格筛 project/country/SKU；预测历史参照用现有 `AnalysisSalesOrderRow.is_counted_sales` 口径，并读取 `AnalysisSourceFile` 的成功销售报表日期覆盖；完整覆盖且无订单才返回 0，未覆盖返回 null；ETD 只按 `in_transit|completed` 状态过滤，有 ETD 的货件进入日期桶，缺 ETD 独立汇总；不使用物流成本历史排除标记过滤发运数量。
- [ ] **步骤 4：拼装供给与预测**：确定情景读取 `in_transit` ETA 和 `completed` 实际入仓日；仅当 `actual_inbound_date > inventory_snapshot_date` 且实际入仓日在预测期内时，把 completed 数量按实际入仓日纳入两个情景。实际入仓日不晚于快照日视为已包含；缺任一日期标记未核实且不自动纳入；收货日晚于快照日但早于预测起始日时标记该 SKU 库存待核实，不展示精确上限。计划情景另加 `draft` ETA 和 active batch 未关联余额；draft/在途 ETA 及计划预计到仓日早于起始日时单独标逾期、不补入当前库存；去年销量依预测日减 365 天匹配，依销售报表覆盖区分真实 0 与未采集日期。
- [ ] **步骤 5：实现系数读写**：protected、项目访问校验、主库写入、审计与事务；倍率校验 `>=0`，缺省读取 1.0。
- [ ] **步骤 6：验证**：运行新增 API 测试及 `tests/api/test_inventory_replenishment_settings_endpoint.py`；确认补货设置 API 不变，OpenAPI 含新路径及 schema。
- [ ] **步骤 7：提交**：中文提交示例：`feat(发货规划): 提供预测和历史发运统计接口`。

## Task 4：预期计划批次及正式货件数量接替

**端点：** `GET/POST /shipping-plan/batches`、`PATCH /shipping-plan/batches/{batch_id}`、`POST /shipping-plan/batches/{batch_id}/cancel`、`POST /shipping-plan/batches/{batch_id}/allocations`、`DELETE /shipping-plan/allocations/{allocation_id}`。

余额定义：`remaining_quantity = max(0, planned_quantity - SUM(allocation.quantity))`。一个批次允许多个 SKU，同一批次内重复 SKU 请求拒绝；编辑数量不得小于已关联数量。取消批次保留记录，未关联余额不再参与预测。

**文件：** schema/service/endpoint、`backend/app/services/shipment/item.py`、批次 API / allocation / shipment item 测试。

- [ ] **步骤 1：写红灯测试**：多 SKU 批次创建、部分关联和余额；跨项目/站点/SKU 错配拒绝；状态限制；计划余额和货件 SKU 可分配量双重超额拒绝；取消与解除关联行为；删除货件恢复有效计划余额；货件明细替换不能降低至已关联量以下。对应 SKU、country、project 数据不可混算。
- [ ] **步骤 2：确认红灯**：`cd backend && python -m pytest tests/api/test_shipping_plan_batches_api.py tests/services/test_shipment_plan_allocation.py -q`。
- [ ] **步骤 3：实现批次事务和审计**：校验 SKU 属于项目/站点，批次及明细一次事务写入；编辑保留关联数量下限；取消只变计划状态，不改正式货件。
- [ ] **步骤 4：实现关联事务**：只允许同项目/站点、相同 SKU 且状态为 draft/in_transit 的 schedule；在同一数据库事务中对 plan item 与 shipment schedule 主记录按固定顺序 `SELECT ... FOR UPDATE`，再聚合该正式货件 SKU 已被所有计划关联量并验证剩余计划量和剩余货件量，防止并发创建关联超额。相同计划明细与正式货件的重复关联请求返回 409，不累加；需调整时先 DELETE allocation 再 POST 新数量。
- [ ] **步骤 5：防护货件明细替换**：`replace_shipment_schedule_items` 在同一事务中锁定 schedule 主记录，删除明细前按 `(schedule_id,sku)` 汇总 allocation；若 SKU 被移除或数量低于关联量，返回 HTTP 409；不满足校验时不删除、不部分改写明细。回归测试写入 `backend/tests/services/test_shipment_item_allocation_guard.py`，因为当前没有 shipment item service 测试目录。
- [ ] **步骤 6：覆盖状态与删除回归**：draft→in_transit 将货件数量从计划情景移到确定情景；in_transit→completed 后只有实际入仓日在预测区间且晚于快照日才作为未来供给，已在快照中的不重复计算，日期不明标记未核实，快照后但预测开始日前已入仓则该 SKU 不展示精确上限；schedule 删除级联解除关联；关联存在时修改明细拒绝或合法保留。
- [ ] **步骤 7：运行目标测试**：`cd backend && python -m pytest tests/api/test_shipping_plan_batches_api.py tests/services/test_shipment_plan_allocation.py tests/services/test_shipment_item_allocation_guard.py -q`，并运行受影响的既有货件 API 测试，再运行 `python scripts/check_alembic.py`。
- [ ] **步骤 8：提交**：中文提交示例：`feat(发货规划): 管理预期批次并接替货件数量`。

## Task 5：新页面、导航与销售上限图表

**文件：** 新增 `frontend/app/dashboard/operations/shipping-plan/page.tsx`、`shipping-plan-client.tsx`、`components/forecast-chart.tsx`、`components/sku-forecast-table.tsx`；修改 sidebar、页面标题和 global filter；新增/更新 Vitest。

- [ ] **步骤 1：先写失败 UI 契约测试**：断言新旧路由标题、导航相邻顺序与名称、旧路由无重定向、全局 project/country filter 识别新页面、历史别名/Agent 技术标识不改变。
- [ ] **步骤 2：确认红灯**：`cd frontend && pnpm exec vitest run lib/sidebar-config.test.ts lib/dashboard-route-meta.test.ts components/terminal/global-filter-context.test.tsx`。
- [ ] **步骤 3：实现页面骨架和请求状态**：遵循现有终端 UI、`DataTableCard`、Tabs、加载/空/错误状态；使用 `/api/backend`、NextAuth session；项目/站点读全局 filter、SKU 为局部选择；筛选变化时取消或忽略旧请求。
- [ ] **步骤 4：实现名称和入口**：新增「发货规划」路由；原 shipment-management 仅显示「货件管理」；sidebar 规划入口排在货件管理前；更新 `dashboard-route-meta`。不改旧 URL、API、Agent `shipments` scope 或自动跳转。
- [ ] **步骤 5：实现图表**：展示需求、确定情景销量、计划情景销量、去年同期实际销量；90 天内逐日，91–180 天按自然月分桶并标出实际日期范围；历史缺失画空断点，不画作 0；说明 ETD 与库存日期口径。
- [ ] **步骤 6：实现 SKU 表和倍率编辑**：展示库存/快照日期、base DMS、倍率、预测需求、在途/草稿、计划余额、两情景上限和数据质量；保存失败保留输入并允许重试；成功后刷新受影响数据。
- [ ] **步骤 7：运行 UI 单测**：`cd frontend && pnpm exec vitest run app/dashboard/operations/shipping-plan lib/sidebar-config.test.ts lib/dashboard-route-meta.test.ts components/terminal/global-filter-context.test.tsx`。
- [ ] **步骤 8：提交**：中文提交示例：`feat(发货规划): 新增独立分析页面和导航入口`。

## Task 6：历史发运概览和预期计划管理交互

**文件：** 新增 `components/plan-batch-manager.tsx`、`components/plan-batch-dialog.tsx`；修改页面协调组件；增加组件和 Playwright 测试、crawler 路由发现项。

- [ ] **步骤 1：写失败交互测试**：覆盖多 SKU 批次创建、编辑 ETA/数量、取消二次确认、部分关联余额、候选货件选择与数量输入、解除关联余额恢复，以及写入成功/错误通知。
- [ ] **步骤 2：实现批次对话框**：验证 ETA、非空 SKU、正整数数量、批次内 SKU 唯一；关联行数量不能低于已关联量；取消需二次确认并显示未落实余额会退出计划情景。
- [ ] **步骤 3：实现正式货件选择和接替 UI**：按 project/country 列出候选货件，显示编号、状态、SKU 未关联数量、ETD/ETA；仅允许 draft/in_transit；前端预校验但以后端事务校验为准。
- [ ] **步骤 4：实现历史发运概览**：按 ETD 月份显示件数与数量；说明 ETD 代理口径；明确显示缺 ETD 货件数和不计入状态范围的货件量；不得把物流成本历史的排除标记误作发运量排除规则。
- [ ] **步骤 5：实现局部刷新与竞态保护**：写操作仅刷新关联批次、SKU 预测和汇总；项目/站点/SKU 变化时丢弃旧响应。
- [ ] **步骤 6：补充浏览器测试**：`frontend/tests/dashboard/shipping-plan.spec.ts` 验证新路由、页面核心数据和基本写流程；Playwright viewport 覆盖桌面 1440px 与移动端 390px，无横向溢出；对话框移动端可滚动。
- [ ] **步骤 7：验证**：运行页面组件 Vitest、crawler 相关测试及 `cd frontend && pnpm exec playwright test tests/dashboard/shipping-plan.spec.ts`。
- [ ] **步骤 8：提交**：中文提交示例：`feat(发货规划): 增加预期批次和货件关联管理`。

## Task 7：文档、全量验证与交付

**文件：** 新增 `docs/发货规划.md`；修改 `docs/REFERENCE.md` 添加业务说明链接；修改 `docs/库存补货分析.md` 补充其与发货规划的模块边界。

- [ ] **步骤 1：写业务说明**：记录页面分工、计算公式、基础 DMS 窗口、增长倍率默认值、历史 ETD 代理口径、两种情景、关联/取消/删除语义、到货当天可用假设、`orderSales` 仅参照、快照和数据质量限制、V1 不包括的事项。
- [ ] **步骤 2：文档和名称审查**：REFERENCE 添加新业务说明链接；补货分析文档只说明模块边界；全仓查用户可见旧名称「发货管理」，确保正式货件页统一叫「货件管理」，不改真实的“发货计划”业务术语、路径、接口或域 code。
- [ ] **步骤 3：迁移校验**：`cd backend && python scripts/check_alembic.py`；仅在本地 `BLF_test` 验证，不向生产库执行迁移。
- [ ] **步骤 4：后端 T3 全量**：`cd backend && pytest`，只跑一次；若失败按仓库规则只对失败文件在 main 对账，不重跑第二次全量。
- [ ] **步骤 5：前端 T3 全量**：`cd frontend && pnpm test && pnpm lint`；全量作为唯一信号源，不以局部测试替代。
- [ ] **步骤 6：端到端验收**：新增 Playwright 用例通过；确认菜单文案、增长倍率、销售上限双情景、去年同期缺失呈空值、ETD 说明、部分数量接替、移动端布局。
- [ ] **步骤 7：OpenAPI / 旧路由契约**：若仓库有提交生成类型则导出 OpenAPI 并更新类型；确认旧 `/shipment-management` 页面路由、`/shipment-schedules` API、Agent shipments 路由仍可用。
- [ ] **步骤 8：交付前检查**：`git diff --check`、`git status --short`、`git diff --stat`；未获明确授权不 push、不 deploy。若开 PR，标题示例 `feat(发货规划): 新增发货规划与销售上限分析`，正文使用中文分节。

## 验收标准

- [ ] 新导航将「发货规划」排在「货件管理」前；旧页面路径/API 稳定，仅用户可见名称准确化。
- [ ] SKU/站点倍率可保存，缺省是 1.0，预测算法与倍率来源隔离。
- [ ] 基准 `base_dms` 与补货分析一致，且没有重复加安全系数。
- [ ] 未来 180 天按日计算；页面前 90 天逐日、后 90 天自然月趋势；确定和计划供给边界符合本计划。
- [ ] 每日销量不超过需求或可用库存；结余库存非负；未满足需求不滚存；计划情景销量不低于确定情景；实际入仓日在预测期内且晚于库存快照的已完成货件准确加入供给；快照后、预测起始日前已入仓的 SKU 不得被遗漏后仍声称精确；预测不回写库存/正式货件。
- [ ] 去年同期 `orderSales` 只作展示，不进入任何预测计算；历史缺失与零销量有区别。
- [ ] 发运历史按 ETD 和状态统计，显示 ETD 代理说明、状态过滤规则和缺 ETD 记录。
- [ ] 批次支持多 SKU、编辑、取消和部分关联；已关联量从计划余额扣除；货件数量不可重复分配；删除货件恢复有效计划余额；明细替换受关联约束保护。
- [ ] 覆盖权限、API 错误、缺/过期快照、缺 DMS/ETA、销售数据覆盖、项目站点隔离、移动端与旧路径兼容。
- [ ] 单 Alembic head、后端全量 pytest、前端全量 `pnpm test`、`pnpm lint` 和 Playwright 新页面测试通过。

## 实施风险

- 库存数据是最近一份 FBA 快照而非实时值；页面应显示快照日期，避免把计算上限描述为无条件承诺。
- ETD 是计划估计日期；V1 按它统计历史发运量，未来如需审计实际离港日期，应新增实际字段而非更改当前统计说明。
- 到仓日期不等于 Amazon 可售日期；V1 假设到仓日当天可售，未来的接收/上架延迟应作为独立参数设计。
- 计划关联约束会碰到现有货件明细替换写路径；必须以后端事务校验和回归测试保护，不能只靠前端禁用。

## 计划自检

- **需求覆盖：** 页面命名/旧路由兼容由任务五、七覆盖；系数与预测算法由任务二、三、五覆盖；180 天分段和去年销量参照由任务二、三、五覆盖；ETD 历史发运统计由任务三、六覆盖；预期计划 CRUD、数量接替、货件防护由任务一、四、六覆盖；文档、权限、迁移和 T3 验证由任务一、三、七覆盖。
- **占位扫描：** 无 TBD/TODO/待补步骤；迁移文件名中的 `<实际迁移文件>` 是执行时以 rebase 后真实迁移文件替换的 shell path 参数，不是业务决策占位符。
- **接口一致性：** `SupplyArrival`、`DailyForecastPoint`、`simulate_sku_forecast` 在任务二定义并由任务三消费；四张持久化模型由任务一定义、任务三/四使用；allocation 业务键与货件明细守卫在约束及对应任务中一致。
