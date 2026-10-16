# Task 4 Brief

## Task 4：暴露运营管理 API

**Files:**
- Create: `backend/app/api/v1/endpoints/amazon_review_tracking.py`
- Modify: `backend/app/api/v1/router.py`
- Test: `backend/tests/api/test_amazon_review_tracking.py`

- [ ] 先写 API 测试：未认证拒绝、列表筛选、创建、PATCH、软停用、跨 Project/Marketplace 拒绝和失败事务无部分写入。
- [ ] 将服务接入 FastAPI 路由；写接口使用主库 session，读接口遵循本域既有只读 session 规范。
- [ ] 对写操作记录 operation audit log，审计前后快照不得包含评论正文（本阶段尚无评论内容）。
- [ ] 挂载路由并验证 OpenAPI 中请求/响应 schema。
- [ ] 运行目标 API 测试并通过。
