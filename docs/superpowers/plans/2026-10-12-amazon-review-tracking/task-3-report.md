# Task 3 执行报告

## 完成内容

- 新增 `backend/app/schemas/amazon_review_tracking.py`：共享 Marketplace 集合与标准化校验，以及创建组、替换成员、设置代表的 Pydantic 请求 schema；校验名称、重复/空成员、正整数 ID 和代表成员关系。
- 新增 `backend/app/services/amazon_review_tracking_service.py`：创建/查询组，严格校验 SKU 所属 Project 与 Marketplace，建立成员与代表的复合归属字段，依赖 DB 复合外键及活动成员唯一索引兜底并转换约束错误；成员替换保留组 ID、软移除历史行；设置代表和软停用组，拒绝停用组修改。
- 扩展 `backend/tests/services/test_amazon_review_tracking_service.py`，覆盖成功创建、代表校验、跨 Marketplace 成员拒绝、重复成员、组成员替换软移除/稳定 ID、重复组、未知 SKU、停用组变更和无效 Marketplace。

## 验证

工作目录：`/Users/damon/DamonProjects/believeboyDashboard/.worktrees/feat/amazon-review-tracking/backend`。显式使用隔离数据库 `BLF_test`（`TEST_DATABASE_URL=postgresql+psycopg://damon@/BLF_test?host=/tmp`）。

- 初始红灯：实现缺失时测试收集报 `ModuleNotFoundError`。
- 首轮实现测试发现测试数据 `CA` 不满足 `product_costs_country_check`；改用合法 Marketplace `UK`。
- `TEST_DATABASE_URL=... pytest tests/services/test_amazon_review_tracking_service.py -q`：4 passed。

## 提交与未解决事项

- Commit：待提交。
- 未解决：无。当前服务不包含 API/前端或评论数据功能，按 Task 3 边界未实现。
