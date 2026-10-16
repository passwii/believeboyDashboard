# Task 5 补充：阶段 A 全量失败集对账（接手后补做）

> 承接 [`task-5-report.md`](./task-5-report.md) 中遗留的验证缺口。阶段 A 收尾时记录了
> `40 failed / 4097 passed / 14 skipped`，但未归档精确 node ID、也未与基线对账。
> 本文按仓库「失败集对账」规则重做，结论：**1 条 Phase A 回归（已修），其余 22 条与本阶段无关。**

## 环境与方法

- Python 环境：主仓 venv（`Python 3.14.8` / `pytest 8.3.4` / `pytest-asyncio 1.3.0`）。
- 测试库：`BLF_test`（alembic head `281`）；显式加载 `backend/.env.test` 并断言库名为 `BLF_test`。
  **注意**：不要再对 `.env.test` 用 `source`——第 15 行密码含特殊字符会导致 shell 语法错误，
  使 `TEST_USER_PASSWORD` 等变量丢失（阶段 A 当时很可能就踩了这个坑）。改用 Python 逐行解析。
- 特征分支 `feat/amazon-review-tracking-handoff`（== `ee8b20df`）全量一次：
  `pytest -q --tb=no -rf --junitxml=...` → **23 failed / 4118 passed / 14 skipped**（316s）。
- 取这 23 条 node ID，在基线 `3d7b7b84`（分支基点）与 `origin/main`（`5bdf3d02`）用**同一命令/环境**
  定向重跑对账（不再跑第二遍全量）。

## 结果

| 分类 | 条数 | 判据 |
| --- | --- | --- |
| 稳定基线失败 | 21 | feature / base / main 三处均失败 |
| 基线失败但 main 已修 | 1 | base 失败、main 通过 |
| **Phase A 回归** | 1 | base 与 main 通过、仅 feature 失败 |

### 1. Phase A 回归（已修复）

`tests/scripts/test_openapi_export.py::test_committed_openapi_matches_current_schema`

- 原因：阶段 A 新增运营路由（`amazon-review-tracking/groups`）与 SKU `father_id` 字段，但未重生成
  被跟踪的契约快照 `frontend/types/api-generated/openapi.json`（及派生的 `api.d.ts`）→ 契约漂移。
- 修复：`cd backend && make openapi-export`（VENV 指向主仓 venv，需 `TEST_DATABASE_URL`）→
  再用 `openapi-typescript@7.13.0` 生成 `api.d.ts`。产物为**纯新增 1116 行**（无删除），
  与「只加 schema / 字段」一致。
- 验证：`tests/scripts/test_openapi_export.py` → **3 passed**；`openapi-typescript --check` 通过。

### 2. main 已修、基线仍失败（1）

`tests/services/crm/test_follow_up_reminder_service.py::test_scan_reactivates_after_followup_and_restale`

- 本分支基点 `3d7b7b84` 失败，`origin/main` 通过（main #729「冻结跟进时间修复过期用例」已修）。
- 非本阶段回归；本分支 rebase 到 main 后即消失。

### 3. 稳定基线失败（21）

平台巡检、页面渲染、头像上传三类，feature/base/main 表现一致，属本地环境既有失败
（多为 R2 / 对象存储等外部依赖缺失），与本阶段改动无关：

- `tests/api/agent/test_platform_inspection.py::TestCountryDimension::*` ×8
- `tests/api/test_page_render.py::*` ×10
- `tests/api/test_profile_endpoints.py::test_upload_avatar_*` ×3

详见文末附录。

## 与阶段 A 记录（40 failed）的差异

本次可复现失败集为 23，而非 40。差异原因：原运行的失败清单当时未落盘（agent 输出被截断），
且很可能因 `.env.test` 的 `source` 失败丢失 `TEST_USER_PASSWORD` 等变量而多出**环境相关**的失败。
本次以在同一环境可稳复现的 23 条为准，不把未知失败当作既有失败。

## 结论

- Phase A 代码回归：**1 条**（OpenAPI 契约漂移），已修复并验证。
- 其余 **22 条与本阶段无关**：21 条本地环境既有失败，1 条 main 已修。
- 「全量失败集未对账」这一验证缺口**已关闭**。

## 附录：23 条失败 node ID 与分类

```text
# 稳定基线失败（21）—— feature/base/main 均失败
tests/api/agent/test_platform_inspection.py::TestCountryDimension::test_r0_valid_and_invalid_country_param
tests/api/agent/test_platform_inspection.py::TestCountryDimension::test_w1_country_mismatch_400
tests/api/agent/test_platform_inspection.py::TestCountryDimension::test_w1_invalid_country_400
tests/api/agent/test_platform_inspection.py::TestCountryDimension::test_w1_project_not_found_404
tests/api/agent/test_platform_inspection.py::TestCountryDimension::test_w2_preview_echoes_country_and_mismatch_400
tests/api/agent/test_platform_inspection.py::TestCountryDimension::test_w2_submit_response_echoes_country
tests/api/agent/test_platform_inspection.py::TestCountryDimension::test_w3_response_echoes_country
tests/api/agent/test_platform_inspection.py::TestCountryDimension::test_w4_preview_and_response_echo_country
tests/api/test_page_render.py::test_delete_foreign_returns_404
tests/api/test_page_render.py::test_delete_owner_success
tests/api/test_page_render.py::test_history_scoped_to_user
tests/api/test_page_render.py::test_public_endpoint_returns_metadata
tests/api/test_page_render.py::test_upload_accepts_md_with_plain_mime
tests/api/test_page_render.py::test_upload_html_success
tests/api/test_page_render.py::test_upload_markdown_extension
tests/api/test_page_render.py::test_upload_markdown_success
tests/api/test_page_render.py::test_upload_title_fallback_to_filename
tests/api/test_page_render.py::test_upload_title_sanitized
tests/api/test_profile_endpoints.py::test_upload_avatar_rejects_non_image
tests/api/test_profile_endpoints.py::test_upload_avatar_size_limit_returns_413
tests/api/test_profile_endpoints.py::test_upload_avatar_writes_r2_and_updates_db

# 基线失败、main 已修（1）
tests/services/crm/test_follow_up_reminder_service.py::test_scan_reactivates_after_followup_and_restale

# Phase A 回归（1，已修）
tests/scripts/test_openapi_export.py::test_committed_openapi_matches_current_schema
```
