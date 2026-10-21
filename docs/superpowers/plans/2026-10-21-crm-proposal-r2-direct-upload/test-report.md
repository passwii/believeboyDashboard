# CRM 方案直传 R2 · 全局测试报告

> 日期：2026-10-21 · 分支：`main` @ `f465d71c` · 执行人：Damon
> 关联计划：[`2026-10-21-crm-proposal-r2-direct-upload.md`](./2026-10-21-crm-proposal-r2-direct-upload.md)

## 1. 环境修复（测试前置）

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| 后端 Python 环境 | 系统 Python：fastapi 0.115 / pydantic 2.7（`requirements.txt` 要求 0.139 / 2.12）→ CRM 测试收集直接失败 `PydanticUndefinedAnnotation: name 'CustomerCreate' is not defined` | `uv venv .venv --python 3.12` + 清华镜像安装锁定版本 → fastapi **0.139.0** / pydantic **2.12.5** / sqlalchemy **2.0.41** |
| 前端依赖 | 缺 `@vitejs/plugin-react`，`vitest.config.ts` 无法加载 | `pnpm install --frozen-lockfile` → 补齐 |
| 测试库 | `BLF_TEST` 不存在 | `pg_dump` 从 `BLF` 克隆 schema |
| 测试库迁移 | 本地 `BLF` 快照停在迁移 **158**（缺 `user_accounts.role_type` 等列） | `alembic stamp 158` → `alembic upgrade head` → **283** |
| 测试账号 | 种子失败（缺密码变量） | `TEST_*_PASSWORD` 注入后种子成功 |

## 2. 前端全量

```bash
cd frontend && pnpm test
```

| 指标 | 结果 |
| --- | --- |
| Test Files | **274 passed (274)** |
| Tests | **2124 passed (2124)** |
| Duration | 89.51s |
| `check:mocks` / `check:motion` | 前置脚本通过（pnpm test 入口自动执行） |

**结论：前端全绿，无回归。**

## 3. 后端 CRM 目标集

```bash
cd backend && pytest tests/api/crm tests/services/crm -q -p no:randomly
```

| 指标 | 结果 |
| --- | --- |
| passed | **723** |
| failed | **10** |

失败清单：

```text
tests/api/crm/test_category_api.py::test_list_categories_any_user
tests/api/crm/test_performance_api.py::test_performance_mine_for_operator
tests/api/crm/test_performance_api.py::test_performance_all_admin
tests/api/crm/test_performance_api.py::test_performance_month_param
tests/services/crm/test_category_service.py::test_list_categories_seeded
tests/services/crm/test_performance_service.py::test_mine_metrics_and_rank
tests/services/crm/test_performance_service.py::test_mine_zero_metrics_when_no_data
tests/services/crm/test_performance_service.py::test_all_global_and_ranking
tests/services/crm/test_performance_service.py::test_all_ranking_sort_by_new_customers
tests/services/crm/test_performance_service.py::test_ranking_sort_by_completion_rate_none_last
```

**失败原因（逐条核实）：**

- `test_list_categories_seeded`：`assert any(c.name == "家居")` 失败。`crm_categories` 是迁移 `252` 的种子数据，测试库被 autouse `TRUNCATE` 清空后未重新灌入。
- performance 系列：`crm_performance` 排行需要多用户业务数据；`my_rank` 为 `None`。

均为**测试库参考数据缺失**，与 CRM 方案上传代码无关，也与 PR #767 记录的基线现象同源。

## 4. 后端上传相关集

```bash
cd backend && pytest tests/api -k "upload or attachment or avatar or screenshot or proposal"
```

| 指标 | 结果 |
| --- | --- |
| passed | 153 |
| failed | 13 |
| skipped | 2 |
| collection error | 2（`fakeredis` 未安装，`test_ai_chat_stream_v2.py` / `test_insight_runs_stream.py`） |

13 个失败全部在 `tests/api/test_project_workflow_attachments.py`，根因：

```text
KeyError: 'tasks'
```

即 workflow 模板 `store-launch-v1` 在测试库中不存在（参考数据缺失），创建 workflow 返回体无 `tasks`。**与上传体积/代理限制无关**，属同一类基线数据问题。

## 5. 全局上传链路体检

| 上传功能 | 前端路径 | 后端上限 | 撞 4.5MB？ |
| --- | --- | --- | --- |
| CRM 客户方案 | `/api/backend/v1/crm/proposals` | 20MB | **是（已实测 5MB 失败）** |
| 项目流程附件 | `/api/backend/api/v1/.../attachments` | 50MB | **是** |
| 报表识别/提交 | `/api/backend/api/v1/report-upload/*` | 50MB | **是** |
| 广告报表上传 | `/api/backend/api/v1/ad-upload/*` | 50MB 级 | **是** |
| 巡检截图 | `/api/inspections/screenshot-upload` | 10MB | **是** |
| page-render | `/api/backend/api/v1/page-render/upload` | 2MB | 否 |
| 用户头像 | `/api/user/avatar` | 5MB | 边缘 |
| AI 文件上传 | `/api/file-upload` | 50MB | **是** |

**现状：仓库内没有“浏览器直连后端上传”的现成通道。** 所有调用都经 `app/api/backend/[...path]/route.ts`，后端 `protected` 依赖要求 `X-API-Key`，浏览器不能持有；R2 只有巡检截图的 **GET** presigned，没有 PUT。

## 6. 与用户实测的对照

| 实测 | 结论 |
| --- | --- |
| < 5MB 成功 | 低于 Vercel 函数请求体约 4.5MB 硬上限，正常 |
| > 5MB 失败 | 命中网关 413（`FUNCTION_PAYLOAD_TOO_LARGE`），请求未到应用代码 |
| 后端改动“生效” | #767 的 scope 改动确实已部署；它不涉及上传体积，所以无法解决 5MB 问题 |

## 7. 待补验证（实施后执行）

- [ ] 真机 R2 桶 CORS 已配置 `PUT` + `Content-Type` + `ExposeHeaders: ETag`
- [ ] 1MB / 4.9MB / 6MB / 20MB 四档实测 201
- [ ] 20MB + 1 字节 → 413
- [ ] 非 HTML → 400/422
- [ ] presigned URL 过期 → 403 且前端提示重试
- [ ] 未 finalize 的临时对象在 30 分钟后被清理
- [ ] `crm_proposals` / `crm_proposal_versions` 行与 R2 对象一一对应
