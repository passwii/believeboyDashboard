# Task 4 完成报告：运营管理 API

## 实现

- 新增内部管理员路由，支持共享组列表、创建、PATCH 更新、软停用。
- 列表经只读 session 查询；写接口使用主库 session，写入与 operation audit log 在同一事务提交。
- 写审计保存组字段和成员 ID 快照，不含评论正文；增加管理员权限门控。
- 挂载路由，并提供 OpenAPI 请求/响应 schema。
- PATCH 仅应用显式提供的字段；成员、代表设置通过 Task 3 服务执行业务校验。

## 验证

- `TEST_DATABASE_URL=... pytest tests/api/test_amazon_review_tracking.py -q`：2 passed。
- `TEST_DATABASE_URL=... pytest tests/services/test_amazon_review_tracking_service.py -q`：8 passed。
- Ruff（新路由与目标测试，排除项目既有 B008 规则）：通过。
- `compileall` 与 `git diff --check`：通过。

API 测试覆盖 OpenAPI 中的四类路由及创建请求 schema、缺少管理员身份时拒绝访问。全应用 OpenAPI 生成当前被其他既有端点的 FastAPI schema 键错误阻塞，因此 OpenAPI 验证在隔离路由应用中执行。
