# Amazon 评论追踪第一阶段实施计划

> **For agentic workers:** 按任务逐项实施；每项先补测试再实现。保持本阶段范围，不提前实现 Review 快照、评论页面或 Agent API。

**Goal:** 为 SKU info 增加可维护的 Father ID 父子 ASIN 关系，以及稳定的内部评论共享组和代表 ASIN 配置基础。

**Architecture:** 在现有 `product_costs` SKU 行增加可空 Father ID；以独立共享组和成员关系表表示评论归组，避免将组身份绑定到可变化的父体或自由文本。通过内部运营 API 提供组及成员的查询、创建、更新、停用能力；所有成员必须来自同一 Project 与 Marketplace 的现有 SKU info 记录，代表 ASIN 必须是有效成员。共享组停用和成员移除均保留记录，不合并历史。

**Tech Stack:** Python 3、FastAPI、Pydantic、SQLAlchemy、Alembic、PostgreSQL、pytest。

## Global Constraints

- Alembic 迁移文件使用 `YYYYMMDD_NNN_description.py`，revision ID 使用纯数字短 ID。
- 新迁移前同步 `origin/main` 并确认只有一个 Alembic head；实施前已同步，当前 head 为 `280`，因此新 revision 使用 `281`，若主分支迁移推进则重新同步并调整。
- 主键使用 `Integer`，与仓库模型约定一致。
- 内部 SKU 身份唯一键 `(project_id, sku, asin, country)` 不改变。
- Father ID 与 ASIN 是不同字段；Father ID 可空，不将它加入现有 SKU 唯一键。
- 父子关系或共享组成员变动不自动合并、拆分或迁移历史数据。
- 本阶段不建立 Review 数据、评分快照、抓取调度、评论追踪页面或 Agent API。
- 因模型与迁移改动触发 T3：按仓库规则运行后端全量 pytest，并按失败集规则对账；同时运行目标 SKU API 测试、迁移检查和相关 lint/格式检查。

---

## 文件结构与职责

### 新增

- `backend/alembic/versions/20261012_281_add_sku_father_id_and_review_groups.py`：增加 `product_costs.father_id`，创建内部评论共享组与成员关系表、索引和约束。
- `backend/app/models/amazon_review_tracking.py`：内部共享组与成员 ORM 模型。
- `backend/app/schemas/amazon_review_tracking.py`：共享组 CRUD 请求和响应 schema。
- `backend/app/services/amazon_review_tracking_service.py`：组、成员、代表 ASIN 的事务性业务规则。
- `backend/app/api/v1/endpoints/amazon_review_tracking.py`：受保护的运营管理 API。
- `backend/tests/api/test_amazon_review_tracking.py`：共享组 API、成员关系、验证和软删除测试。
- `backend/tests/services/test_amazon_review_tracking_service.py`：服务层约束测试。

### 修改

- `backend/app/models/sku_info.py`：`SkuRecord` 增加可空 `father_id`。
- `backend/app/models/__init__.py`：注册新模型，确保元数据和迁移环境导入。
- `backend/app/schemas/sku_info.py`：SKU 列表、创建与更新 schema 暴露 `father_id`。
- `backend/app/services/data/sku_info/crud.py`：SKU upsert / 按 ID 更新保存 `father_id`，保持未提供字段不覆盖现值的 PATCH 语义。
- `backend/app/api/v1/endpoints/sku_info.py`：SKU 响应序列化返回 `father_id`。
- `backend/app/api/v1/router.py`：挂载新的内部评论共享组运营路由。
- SKU info 既有后端 API 测试文件：补充 Father ID 创建、更新、读取和空值兼容测试（按仓库中实际覆盖列表/更新的既有测试文件落位）。

## 设计契约

### Father ID

- 在每条 SKU info 记录上存储可空 `father_id`，由运营人员手动维护。
- `father_id` 是字符串外部标识，不作为外键；允许没有父体的记录为 `NULL`。
- 不自动推导 Father ID，不改变项目、SKU、ASIN、站点的既有唯一性。
- 内部 API 的创建、更新、列表和响应都支持该字段；未提供表示不修改，显式 `null` 或空白表示清除。

### 内部评论共享组

- 共享组记录稳定身份、Project、Marketplace、名称/说明、代表 SKU 记录、活动状态和审计时间。
- 成员关系引用现有 `product_costs.id`，含软删除状态和加入/移除时间；同一 ASIN 同站点最多属于一个有效内部组。
- 代表 ASIN 必须是同组有效成员；每个有效组必须恰有一个代表成员。
- 组成员必须属于组 Project 和 Marketplace；禁止跨项目、跨站点混组。
- 创建组和配置成员在一个事务内完成；更新代表成员时原代表成员资格仍保留。
- 移除成员 / 停用组只做状态标记，不删除组、成员记录或未来依赖它们的历史。
- 不允许在本阶段把组成员变化解释成历史数据合并或拆分。

### 运营 API

- `GET /api/v1/amazon-review-tracking/groups`：按 Project、Marketplace、状态筛选内部共享组，响应组、成员和代表 ASIN。
- `POST /api/v1/amazon-review-tracking/groups`：创建内部组并指定成员及代表 SKU 记录。
- `PATCH /api/v1/amazon-review-tracking/groups/{group_id}`：更新名称、说明、成员和代表；只应用请求显式提供的字段。
- `POST /api/v1/amazon-review-tracking/groups/{group_id}/deactivate`：软停用组。
- 所有写操作需用现有 Session / operator 认证、权限校验、操作审计模式；写入在单事务内完成，校验失败时不留下部分成员变更。

## Task 1：为 SKU info 添加 Father ID

**Files:**
- Modify: `backend/app/models/sku_info.py`
- Modify: `backend/app/schemas/sku_info.py`
- Modify: `backend/app/services/data/sku_info/crud.py`
- Modify: `backend/app/api/v1/endpoints/sku_info.py`
- Test: 现有 SKU info API 测试文件（先定位列表与 PATCH 覆盖所在文件）

- [x] 在现有 SKU info API 测试中加入创建、PATCH、列表读取 Father ID 的失败用例。
- [x] 运行目标测试，确认新断言因字段未实现而失败。
- [x] 增加可空模型字段及 create/update/response schema 字段。
- [x] 在 upsert 和按 ID 更新逻辑中区分字段未提供与显式清空，并加入序列化。
- [x] 运行目标测试并通过；确认现有 SKU 唯一键测试仍通过。

## Task 2：迁移并注册共享组数据模型

**Files:**
- Create: `backend/alembic/versions/20261012_281_add_sku_father_id_and_review_groups.py`
- Create: `backend/app/models/amazon_review_tracking.py`
- Modify: `backend/app/models/__init__.py`
- Test: `backend/tests/services/test_amazon_review_tracking_service.py`

- [x] 为共享组和成员模型设计 Integer 主键、Project/SKU 外键、软删除字段、时间戳、唯一约束和查询索引。
- [x] 先写模型元数据约束测试：成员 SKU 引用、Marketplace/Project 归属字段、活动成员唯一约束及历史记录可保留。
- [x] 实现迁移 upgrade/downgrade：增加 nullable Father ID 列，创建两张关系表及约束；downgrade 按依赖顺序移除新表和列。
- [x] 在模型包注册新模型，运行迁移检查并确认 Alembic 单 head。
- [x] 在 `BLF_test` 执行迁移往返验证；不在 `BLF` 上运行写入测试。

## Task 3：实现共享组服务规则

**Files:**
- Create: `backend/app/schemas/amazon_review_tracking.py`
- Create: `backend/app/services/amazon_review_tracking_service.py`
- Test: `backend/tests/services/test_amazon_review_tracking_service.py`

- [x] 先测试创建组成功、代表 ASIN 不属于成员时拒绝、跨 Project/Marketplace 成员拒绝、重复有效成员拒绝。
- [x] 测试成员调整和代表切换保留被移除成员行，不改变组的稳定 ID。
- [x] 实现输入校验、组/成员查询、事务性成员替换、代表设置和软停用服务。
- [x] 测试重复创建、未知 SKU、停用组变更和无效 Marketplace 的预期错误响应。
- [x] 运行服务测试并通过。

## Task 4：暴露运营管理 API

**Files:**
- Create: `backend/app/api/v1/endpoints/amazon_review_tracking.py`
- Modify: `backend/app/api/v1/router.py`
- Test: `backend/tests/api/test_amazon_review_tracking.py`

- [x] 先写 API 测试：未认证拒绝、列表筛选、创建、PATCH、软停用、跨 Project/Marketplace 拒绝和失败事务无部分写入。
- [x] 将服务接入 FastAPI 路由；写接口使用主库 session，读接口遵循本域既有只读 session 规范。
- [x] 对写操作记录 operation audit log，审计前后快照不得包含评论正文（本阶段尚无评论内容）。
- [x] 挂载路由并验证 OpenAPI 中请求/响应 schema。
- [x] 运行目标 API 测试并通过。

## Task 5：整合与全量验证

**Files:**
- Modify: 本阶段涉及的 SKU info / 共享组文件
- Test: SKU info 目标测试、`backend/tests/api/test_amazon_review_tracking.py`、全量后端测试

- [x] 运行 SKU info 相关后端目标测试与共享组服务/API 测试。
- [x] 运行 `cd backend && python scripts/check_alembic.py`，确认命名、revision、单 head 和链路有效。
- [x] 运行后端全量 `cd backend && pytest`；记录所有失败项，不使用 `pytest -n auto`。
- [ ] 对全量失败按仓库失败集对账规则判断基线与新增失败；Task 5 报告记录 40 failed、4097 passed、14 skipped，但原始失败 node ID 未能准确恢复，尚未与 main 对账，因此不能判断这些失败属于基线还是本次回归。
- [x] 运行 `git diff --check` 并检查迁移 upgrade/downgrade、schema/OpenAPI 与审计行为；迁移往返和目标测试结果见 Task 5 报告。

## 后续阶段（不属于本计划）

- 阶段 B：评论共享组快照、Review、抓取运行记录和运营查询后端。
- 阶段 C：评论追踪运营页面及外部竞品店铺关联管理。
- 阶段 D：Agent 目标读取与按共享组独立提交 API。

每阶段完成后再单独编写范围明确的实施计划，避免把多套独立交付物混成一个无法审查的超大变更。
