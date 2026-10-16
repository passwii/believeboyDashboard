# Amazon 评论追踪阶段 B 实施报告

> 状态：**实现完成、逐任务规格+质量审查通过**；1 项权限架构 follow-up 待拍板（见 §6）。
> 相关：[B 规格](../../specs/2026-10-16-amazon-review-tracking-phase-b-design.md) · [B1](./2026-10-16-amazon-review-tracking-phase-b1-data-model.md) · [B2](./2026-10-16-amazon-review-tracking-phase-b2-ingestion-service.md) · [B3](./2026-10-16-amazon-review-tracking-phase-b3-ops-api.md)
> 分支：`feat/amazon-review-tracking-handoff`（收尾 ff 回 `feat/amazon-review-tracking`）

## 1. 交付范围与提交（20 个 commit，`26a303f2..531b96e9`）

| 任务 | 首个 feat 提交 | 后续修复 |
| --- | --- | --- |
| B1-T1 5 张表 + 迁移 282 | `9aa9bfd5` | `181f62b3`（复合外键归属约束）、`3374647f`（形状反向测试） |
| B1-T2 组同步内部目标 | `3033df59` | `586cf9b7`（代表 ASIN 空值处理） |
| B2-T3 采集写入服务 | `b0dcfe83` | `d02bfe5d`（failed 只落 run / 幂等键边界）、`31295d05`（星数长度/naive tz/去重）、`1af89c49`（并发 savepoint + 枚举/范围）、`91c35a1a`（拒绝非有限数）、`720c25f4`（整数性校验）、`044d59e7`（参数化补测） |
| B3-T4 运营只读 API | `1e6b23d6` | `c5221cf5`（角色门槛 + 分页）、`66675aec`（分页断言）、`531b96e9`（项目级读授权） |
| B3-T5 外部竞品关联 API | `88d45925` | `1079ae54`（复用复活/并发/批量/校验）、`29ff2b2c`（savepoint 作用域 + 补测） |
| B3-T6 整合验证 | `8267dcc9`（OpenAPI 契约） | — |

总计：`15 files changed, 5545 insertions(+), 389 deletions(-)`（含生成的契约）。

## 2. 已实现内容

- **数据模型（迁移 282）**：`amazon_review_targets`（统一挂载点，`kind=internal_group|external_asin`；内部目标复合外键 `(group_id, project_id, marketplace)→amazon_review_groups`；外部 `(marketplace, asin)` 部分唯一）、`amazon_review_rating_snapshots`（`UNIQUE(target_id, capture_date)`）、`amazon_review_reviews`（`UNIQUE(target_id, review_key)`，可见性/缺失计数）、`amazon_review_crawl_runs`（`UNIQUE(target_id, idempotency_key)`）、`amazon_review_external_links`（`UNIQUE(target_id, shop_id)`，软删复活）。含既有评论组的目标回填。
- **组生命周期同步**：建组/换代表/改名/停用同步 `target`（`_sync_internal_target`）。
- **采集写入服务** `record_crawl_result`：幂等、同日快照 upsert、Review 当前记录 upsert、完整列表两连缺失→疑似移除 / 再现恢复、failed 只落 run；入参校验（星数数组长度=5、tz-aware、枚举、范围、整数性、非有限数）；并发用 savepoint + 重查复用。
- **运营只读 API**：`GET /targets`、`/targets/{id}/rating-snapshots`、`/reviews`、`/runs`；角色门槛（operator/admin）+ 项目级授权 + 分页。
- **外部竞品 API**：`GET/POST /external-targets`、`POST/DELETE /targets/{id}/external-links`；复用复活、并发恢复、批量 links、ASIN/display_name 规范化。

## 3. 验证结果

- `python scripts/check_alembic.py`：通过（单 head、命名合规）。
- 阶段 B 目标集：**62 passed**（模型/服务/API 合计，见各任务报告）。
- `tests/scripts/test_openapi_export.py`：**3 passed**；契约纯语义新增（schemas +0 removed / +8 added；paths +0 removed / +7 added）。
- 后端全量一次：**34 failed / 16 errors / 4158 passed / 14 skipped**（~320s）。
- **失败集对账**：在基线 `3d7b7b84` 用同环境定向重跑失败集 → **逐条一致（34F/16E）**，**无本阶段新增回归**。既有失败集中在 `test_complaint_identity`、`test_platform_inspection::TestCountryDimension`、`test_page_render`、`test_profile_endpoints`、`test_projects_native::test_projects_list_parity`、`crm/test_follow_up_reminder_service`（多为环境依赖；CRM 项 main 已修）。

## 4. 与计划的偏差（实现期编排裁定）

1. **共享 `client` fixture 不存在**：仓库 conftest 无 `client`；沿用阶段 A 的「测试文件内自建最小 FastAPI client + 依赖覆盖 + monkeypatch 会话」模式（T4/T5）。
2. **B2 失败运行语义**：`status=failed` 时**只落 run**（不写快照/评论），与规格 §2.2「快照仅 success/partial」一致。
3. **B2 入参加固**：新增星数数组长度、tz-aware、枚举、范围、整数性、非有限数校验；并发 savepoint 恢复。均超出计划原码，属审查驱动的加固。
4. **外部关联错误映射**：显式白名单（资源不存在→404；入参引用无效→422）。
5. **读权限收紧**：见 §6。

## 5. 遗留项 / 建议 follow-up

1. **项目级授权的身份来源（重要）**：见 §6。
2. **外部目标跨项目可见**：外部目标 `project_id` 为空，按当前实现所有 operator 可见；是否符合运营预期待确认。
3. 迁移 282 的 upgrade/downgrade 已在 `BLF_test` 往返验证，但「回填 + 复合外键 + 部分唯一索引」的**迁移级**自动化用例仍以 ORM 约束/服务行为为主，可后续补。
4. 全量套件的既有失败（环境依赖）与本阶段无关，建议单独排期清理。

## 6. 权限模型（需产品确认）

实现期按审查意见对已拍板口径「读 = 运营/管理员会话」做了**两处收紧**：

1. **角色门槛**：读接口要求账号 `is_admin` 或 `role_type == "operator"`；其它角色（如 `businessdev`）→ 403。
2. **项目级授权**：operator 仅可见其「可访问项目」（复用 `project_service.list_accessible_project_ids`，按 `project_operator/assistant_operator` 名匹配）下的内部目标；不可见目标的子资源 → 404（不泄露存在性）；**外部目标**（无 project）跨项目可见；admin 全量。

**未闭合的架构点**：项目授权所用的运营身份取自 `X-Operator` 请求头，该头由可信前端代理注入，**未与已验证 session 账号做身份绑定**。仓库既有 `/projects/manage` 依赖同一信任模型，故本阶段沿用；若要求防御直连伪造，需要**仓库级**改造（由已验证账号推导运营身份），不属本阶段范围。**建议：接受现状并另立仓库级加固事项。**
