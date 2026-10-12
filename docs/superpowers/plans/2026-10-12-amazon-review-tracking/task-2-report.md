# Task 2 执行报告

## 完成内容

- 新增 `backend/app/models/amazon_review_tracking.py`，注册 `AmazonReviewGroup` 与 `AmazonReviewGroupMember`：Integer 主键；Project、SKU 及组外键；组活动状态、成员移除时间及加入/创建/更新时间；组范围和成员查询索引；成员活动状态（`removed_at IS NULL`）部分唯一索引，保留移除的历史成员行。
- 新增 `backend/alembic/versions/20261012_281_add_sku_father_id_and_review_groups.py`，revision `281`、down_revision `280`。迁移增加 nullable `product_costs.father_id`、创建两张关系表和约束/索引；downgrade 先按依赖顺序删成员表、组表，再删 Father ID 列。
- 在 `backend/app/models/__init__.py` 注册模型，并在 `backend/alembic/env.py` 导入，确保 Alembic 元数据包含新模型。
- 新增 `backend/tests/services/test_amazon_review_tracking_service.py`，验证主键类型、Project/Marketplace/SKU 归属列、外键、时间戳/软删除和活动成员唯一索引。

## 验证命令与结果

运行目录：`/Users/damon/DamonProjects/believeboyDashboard/.worktrees/feat/amazon-review-tracking/backend`。显式使用 `TEST_DATABASE_URL=postgresql+psycopg://damon@/BLF_test?host=/tmp`，所有迁移写入均针对 `BLF_test`，未对 `BLF` 执行写操作。

- `pytest tests/services/test_amazon_review_tracking_service.py -q`：1 passed。
- `python scripts/check_alembic.py`：通过，命名、迁移链及单 head 检查通过。
- `alembic heads`：`281 (head)`。
- `alembic current`：`281 (head)`。
- `alembic upgrade 281`、`alembic downgrade 280`、`alembic upgrade 281`：往返通过。
- `git diff --check`：通过。

TDD 过程中的首次 pytest 收集因未设置 `TEST_DATABASE_URL` 而被数据库配置阻断；随后显式设置本地 `BLF_test` URL 后目标用例通过。首次迁移升级遇到测试库在 revision 280 时已有 Task 1 ORM 所对应的 `father_id` 列（数据库 schema 先于迁移版本记录），故迁移在升级时检查列是否已存在，仅在不存在时增加；后续 upgrade/downgrade/upgrade 往返通过。此兼容逻辑未改变 Task 1 字段语义。

## 范围与提交

- 未改动 Task 1 行为或字段语义；未实现服务层规则、API 或 UI。
- Commit：随本报告提交的 Task 2 commit（当前 HEAD）。
- 未解决问题：无。
