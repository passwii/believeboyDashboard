# Task 4 审查报告：运营管理 API

## 结论

- **Spec compliance：FAIL**
- **Task quality：Not approved**

## 发现

1. **[必须修复] 管理员权限可由任意请求头伪造，且未验证内部 Session 身份**
   - `/Users/damon/DamonProjects/believeboyDashboard/.worktrees/feat/amazon-review-tracking/backend/app/api/v1/endpoints/amazon_review_tracking.py:50-53`
   - `_require_admin` 将客户端可直接设置的 `X-Is-Admin` 作为授权依据（FastAPI bool 转换），没有要求内部 Session/已认证用户。未认证请求只是在缺省该头时返回 403；攻击者自行发送 `X-Is-Admin: true` 即可进入所有管理端点，写入和读取共享组数据。与全局约束“内部 Session 认证”不符。建议使用可信认证链验证 Session 身份与管理员角色，不能把客户端可控头当作凭据。

2. **[必须修复] PATCH 将 JSON null 当作有效更新，可能引发 500 或绕过契约**
   - `/Users/damon/DamonProjects/believeboyDashboard/.worktrees/feat/amazon-review-tracking/backend/app/api/v1/endpoints/amazon_review_tracking.py:58-62, 156-161`
   - `member_ids` 与 `representative_id` 声明为可空；显式传 `null` 后仍进入更新分支。`member_ids: null` 会在构造 `ReviewGroupMemberReplace` 时校验失败，且该 `ValidationError` 未转为 4xx；`representative_id: null` 同样传给 `ReviewGroupRepresentativeUpdate`，可能产生未处理的校验异常。建议明确 PATCH 的 null 语义：不允许则用非空字段类型拒绝；允许清空代表则实现并测试该语义，且将校验错误稳定映射为 422。

3. **[必须修复] PATCH 和软停用缺少失败回滚，不能保证失败无部分写**
   - `/Users/damon/DamonProjects/believeboyDashboard/.worktrees/feat/amazon-review-tracking/backend/app/api/v1/endpoints/amazon_review_tracking.py:133-190`（尤其 `169-171` 与 `181-190`）
   - PATCH 有异常回滚，但仅包围已取到 group 后的更新；前置查询/快照异常不在保护范围。软停用整个流程无 `try/except`/rollback：服务或审计写入失败时，主库 Session 可能保留未提交变更，后续复用该事务会造成部分写入或污染。创建接口 `123-130` 也无异常回滚保护。建议将每个写操作的业务修改、审计和提交置于统一事务边界，任意异常显式 rollback；补充审计失败/服务失败时数据库状态不变的测试。

4. **[必须修复] 跨 Project/Marketplace 修改未在 API 层建立并验证资源范围**
   - `/Users/damon/DamonProjects/believeboyDashboard/.worktrees/feat/amazon-review-tracking/backend/app/api/v1/endpoints/amazon_review_tracking.py:144-161, 181-185`
   - PATCH 和停用仅按 `group_id` 查询；PATCH 成员/代表更新也只传 `group_id` 与 SKU ID，API 没有校验请求目标仍属于该组的 Project/Marketplace。Brief 明确要求覆盖跨 Project/Marketplace 拒绝；所提交 API 测试仅覆盖 OpenAPI 和缺少管理员头（测试文件 `252-263`），没有相应场景证据。建议以组的项目/Marketplace 作为操作边界，并针对外部 SKU/目标跨域场景验证拒绝且事务无写入。

5. **[建议修改] 读取成员列表逐组查询，形成 N+1**
   - `/Users/damon/DamonProjects/believeboyDashboard/.worktrees/feat/amazon-review-tracking/backend/app/api/v1/endpoints/amazon_review_tracking.py:75-81, 112-113`
   - 列表先查全部组，再对每组单独查询成员；组数增长时请求查询数线性增长。可批量查询当前结果组的成员并按 group_id 聚合，或使用适当的 eager loading。

## 修复记录

按审查意见完成五项修复：管理端点要求 API key、有效 Session 和数据库中的启用管理员账号，拒绝仅凭 `X-Is-Admin` 授权；PATCH 的 name/member_ids/representative_id 显式 null 返回 422；创建、更新、停用全程异常均 rollback；API 测试覆盖跨 Project / Marketplace 成员拒绝及无部分写；列表成员改为一次批量查询。

验证：`TEST_DATABASE_URL='postgresql+psycopg://damon@/BLF_test?host=/tmp' pytest tests/api/test_amazon_review_tracking.py tests/services/test_amazon_review_tracking_service.py -q`，14 passed。另有 3 条 SlowAPI 弃用警告。

## 复审补充（2026-10-12）

按 reviewer 要求，将跨 Project / Marketplace 拒绝场景从 service 直调补充为真实 HTTP client PATCH 调用。两种外部 SKU 都通过组成员替换请求提交，均断言稳定返回 422，并检查原组仍存在、成员列表未改变且没有额外组写入，覆盖事务失败无部分写。

验证：`TEST_DATABASE_URL='postgresql+psycopg://damon@/BLF_test?host=/tmp' pytest tests/api/test_amazon_review_tracking.py::test_api_rejects_cross_project_and_marketplace_members -q`，1 passed；3 条 SlowAPI 弃用警告。

