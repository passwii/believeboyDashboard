# Task 2 执行报告

## 完成内容

- 新增 `backend/app/models/amazon_review_tracking.py`，注册 `AmazonReviewGroup` 与 `AmazonReviewGroupMember`：Integer 主键；Project、SKU 及组外键；组活动状态、成员移除时间及加入/创建/更新时间；组范围和成员查询索引；成员活动状态（`removed_at IS NULL`）部分唯一索引，保留移除的历史成员行。
- `backend/alembic/versions/20261012_281_add_sku_father_id_and_review_groups.py`，revision `281`、down_revision `280`。upgrade 为干净 revision-280 schema 新增 nullable `product_costs.father_id`，若列已存在则保留，并创建两张关系表和约束/索引；downgrade 仅回滚本迁移创建的共享组表，**始终保留 `father_id`**（它是 Task 1 功能列，不属于本迁移所有）。
- 在 `backend/app/models/__init__.py` 注册模型，并在 `backend/alembic/env.py` 导入，确保 Alembic 元数据包含新模型。
- 新增 `backend/tests/services/test_amazon_review_tracking_service.py`，验证主键类型、Project/Marketplace/SKU 归属列、外键、时间戳/软删除和活动成员唯一索引。

## 验证命令与结果

运行目录：`/Users/damon/DamonProjects/believeboyDashboard/.worktrees/feat/amazon-review-tracking/backend`。由于该 worktree 无 `backend/.env.test`，按仓库 `TESTING.md` 从主工作区既有 `.env.test` 读取并显式使用 `TEST_DATABASE_URL=postgresql+psycopg://damon@/BLF_test?host=/tmp`；操作目标为本地隔离库 `BLF_test`。

- 未设置环境变量的首轮 `pytest tests/services/test_amazon_review_tracking_service.py` 收集失败：`DATABASE_URL` 未配置，错误提示需配置 `DATABASE_URL` 或 `TEST_DATABASE_URL`。随后按仓库入口显式设 `TEST_DATABASE_URL`。
- `pytest tests/services/test_amazon_review_tracking_service.py -q`：2 passed。
- `python scripts/check_alembic.py`：通过。
- `alembic downgrade 280` 后 `alembic upgrade 281`：往返通过，`alembic current` 为 `281 (head)`；验证 `product_costs.father_id` 在 downgrade 后仍存在。
- `git diff --check`：通过。


## 数据库环境差异与处理

- Task 1 报告记录迁移时连接的是 `/Users/damon/DamonProjects/believeboyDashboard/.worktrees/feat/amazon-review-tracking/backend` 下的 `BLF_test`；本次再次显式设置 `TEST_DATABASE_URL=postgresql+psycopg://damon@/BLF_test?host=/tmp`，并用 `select current_database()` 确认实际连接 `BLF_test`。该库本次往返前为 revision 281 且 `father_id` 已存在。
- 另一次只读检查所见本地 `BLF` 为 revision 280 且 `father_id` 存在；`BLF_test` 是 revision 281 且列未查到的观测，与 Task 1 报告记录不一致，说明存在时点或连接环境差异。revision 280 时列存在不能证明生产 schema 状态；生产数据库本任务未查询，不据此声称生产已有或缺少该列。
- 原迁移 downgrade 无条件删列会损坏 revision 281 之前存在的 Task 1 字段。本次修正为 downgrade 永不删 `father_id`；upgrade 在列缺失时添加，可适配干净 revision 280 和预存列两种状态。BLF_test 往返后确认该列仍存在。该列按 Task 1 所有权处理，未来移除由 Task 1 对应迁移负责。
- SKU/project ID 外键字段采用 BigInteger，与 `projects.id` / `product_costs.id` 一致。复合约束曾因 product_costs 对应组合列缺少唯一约束导致 upgrade 失败；已改为引用实际主键的直接 FK，往返验证通过。

## 范围与提交

- 未改动 Task 1 行为或字段语义；未实现服务层规则、API 或 UI。
- Commit：随本报告提交的 Task 2 commit（当前 HEAD）。
- 未解决问题：无。
