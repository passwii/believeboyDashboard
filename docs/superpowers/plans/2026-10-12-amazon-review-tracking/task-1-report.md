# Task 1 执行报告：SKU info Father ID

## 修改文件

- `backend/app/models/sku_info.py`：为 `SkuRecord` 增加可空 `father_id` 字符串列；未创建迁移（按要求留给 Task 2）。
- `backend/app/schemas/sku_info.py`：在 create、update 和响应 schema 暴露可空字段。
- `backend/app/services/data/sku_info/crud.py`：通用 upsert / 按 ID 更新仅在字段显式提供时写入，区分字段缺失与显式 `null`；字符串空白归一为 `None`。
- `backend/app/api/v1/endpoints/sku_info.py`：内部列表、创建和 PATCH 序列化包含 `father_id`。
- `backend/app/schemas/agent_sku_info.py`、`backend/app/api/v1/endpoints/agent/sku_info.py`：Agent SKU upsert/PATCH schema、PATCH 合并逻辑及列表/详情/写响应序列化同步支持字段，保持现有 SKU API 的端点覆盖完整。
- `backend/tests/api/test_sku_listing_copy.py`：覆盖通用 API 创建、PATCH 设置与显式清空、未提供时返回空值。
- `backend/tests/api/agent/test_sku_info.py`：覆盖 Agent upsert 创建及同键 upsert 显式清空。

## TDD 与验证

- 红灯：新增创建断言在实现前失败，响应缺少 `father_id`（`KeyError`）。
- 测试库为独立 `BLF_test`，缺少模型字段对应的数据库列。为在不添加/提交迁移的前提下运行本任务针对性 API 测试，仅在本地隔离测试库临时执行：`ALTER TABLE product_costs ADD COLUMN IF NOT EXISTS father_id VARCHAR NULL`。此为测试环境临时 schema 准备，不是仓库变更或迁移。
- 完整目标测试命令（从 backend 目录运行，先用 `python-dotenv` 加载现有测试配置）：
  `python -c 'from dotenv import load_dotenv; load_dotenv("/Users/damon/DamonProjects/believeboyDashboard/backend/.env.test", override=True); import pytest; raise SystemExit(pytest.main(["-q", "tests/api/test_sku_listing_copy.py", "tests/api/agent/test_sku_info.py"]))'`
  结果：**83 passed**，10 条既有依赖弃用警告。
- 独立契约验证：`test_listing_copy_fields_constant_shape`、`test_model_has_ten_listing_columns`：**2 passed**。
- `black --check` 覆盖全部 8 个修改的 Python 文件：通过。
- `git diff --check`：通过。
- Ruff 对整个 `sku_info.py` 文件报告既有规则问题（FastAPI `Depends`、宽泛异常、其他旧代码等）；自检中发现本次无重复字段定义问题。未对历史 lint 内容扩大修复范围。

## 自我审查

- 检查了变更 diff、序列化路径、通用 CRUD 与 Agent upsert/PATCH 字段传递；验证新值写入、缺字段保持原值、显式 `null` 清空以及唯一键相关 Agent upsert 回归。
- 未新增迁移或改动唯一键。
- 工作区原有未跟踪的 spec/plan 文件未纳入本任务提交；执行报告单独保留为未提交文件，避免在 commit 内自引用 commit hash。

## Commit

- `b51cd4c4521888652ae1139555c28e154da4b3dc` — `feat(SKU): 增加 Father ID 字段`
- 报告文件在实现提交之后单独补充；代码与测试均已随该 commit 提交。

## 未解决问题 / 后续

- Task 2 必须新增数据库迁移；在迁移进入数据库前，运行时 ORM 查询会因生产/测试数据库缺少 `product_costs.father_id` 而失败。本任务只在本地 `BLF_test` 临时添加该列，以便验证 API 行为。
- 当前测试报告没有 commit hash，因为此任务尚未提交。

## 全分支审查补丁：Agent SKU PATCH father_id

- 审查发现当前 `_merge_update_payload` 的可更新字段列表已包含 `father_id`；Agent PATCH schema 也已声明该可空字段。复核运行时行为后确认此前静默丢弃问题在当前代码中不可复现，因此不对合并实现做无意义改动。
- 在 `backend/tests/api/agent/test_sku_info.py` 增加参数化回归覆盖：PATCH 设置 `father_id`、显式 `null` 清除、缺省字段保留原值。
- 红灯验证未复现：新增三种场景首次运行均通过（3 passed），因此视为现有实现的行为锁定测试，而非声称测试先失败后修复。
- Agent SKU 完整目标测试：与 Task 3/API 组合运行见 Task 5 报告；独立 Agent 用例在组合中通过。`git diff --check` 在提交前复核。
- 全量校验更新：见 task-5-report.md；曾尝试离线 migration SQL 生成，但既有 baseline migration 使用 inspector，无法在 Alembic mock connection 离线运行。

