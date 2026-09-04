# Agent 管理页操作明细计划（BLF-460）

> **状态**：V1 草案（待与用户详细制定）
> **创建**：2026-08-06 · Damon
> **实施人**：后端 Damon / 前端 Seth
> **关联页面**：`dashboard/system/agent-management`（Agent 接入管理页，BLF-448 重构产物）

---

## 目标

打磨 Agent 管理页，突出对 Agent 整体「读 / 写」操作的把握与操作明细：

1. **写操作明细**：记录并展示采用写方案 API（POST/PUT/PATCH/DELETE）进行修改的操作细节，例如「货件状态：in_transit → complete（已入库）」。
2. **读操作明细完善**：读访问日志除端点外，补充**项目 ID** 与**操作类型**（业务域，如 shipment）。

## 关键发现（现状盘点）

> 调研结论直接决定了本方案的形态，**写操作明细数据其实已经存在**，缺的是管理侧查询与展示。

| 现状 | 位置 | 结论 |
|------|------|------|
| 每个 `/api/v1/agent/*` + `/api/v1/external/*` 请求一行**访问日志** | `agent_api_audit_log`（中间件 `middleware/agent_api_audit.py` 写入） | 只有 method/path/status/latency/ip/key_id，**缺 project_id 与操作类型** |
| 每个**写操作**（confirm 两步确认后）落一条**操作审计**，含 `before_json` / `after_json` / `agent_id` / `idempotency_key` / `request_path` | `operation_audit_logs`（`services/audit_log_service.py` 的 `append_operation_audit_log`，货件/店铺测算/新品测算全部写路由都已接） | **写明细数据已具备**（如 `before={"shipment_status": "in_transit"}`, `after={"shipment_status": "complete"}`）；但管理端无按 agent 查询的端点，前端无展示 |
| 所有写路由 path 都含 `/projects/{project_id}/...` | `agent/shipments.py` / `agent/shop_calculations.py` / `agent/new_product_calculations.py` 的 router prefix | project_id 可在查询/写入时从 path 可靠解析，**无需改写路由** |
| 管理端已有读访问日志端点 | `system_management/agent_access.py`（list + summary） | 补列即可 |
| 管理端已有全量操作审计端点 | `system_management/audit.py`（`/audit-logs`） | 面向人工 operator，**无 agent_id 过滤、keyword 不含 agent_id**；不动它，另起专用端点（blast radius 最小） |

## 方案设计

### A. 读操作明细增强（后端）

**A1. 迁移（rev `238`）**：`agent_api_audit_log` 加两列 + 回填
- `project_id` `Integer` nullable + 索引
- `operation_type` `String(32)` nullable + 索引
- upgrade 内**分批回填**存量行：从 `path` 解析（正则 `/projects/(\d+)`）project_id；operation_type 走路径映射表；幂等。

**A2. 中间件打标**（`middleware/agent_api_audit.py`）
- 新增模块级纯函数 `parse_audit_path_meta(path) -> tuple[int | None, str | None]`（可直接单测）：
  - project_id：正则 `r"/projects/(\d+)"` → int，未命中 None（如 `/projects` 列表、health）
  - operation_type：常量 `AGENT_PATH_DOMAIN_MAP: list[tuple[str, str]]`（**片段 → 域 code**，长片段优先），如 `("/shop-calculations", "shop_calculations")`、`("/new-product-calculations", "new_product_calculations")`、`("/shipments", "shipments")`，外加 external 镜像路由片段（return-analysis / ads / inventory / finance…）。与 `frontend/lib/agent-domains.ts` 注册表 + `agent/__init__.py` 路由接线保持一致；未命中 → None（前端显示「未知/其他」）
- `_write_audit(...)` 增加 `project_id` / `operation_type` 两参数。

**A3. 管理端端点**（`system_management/agent_access.py`）
- `AgentAccessLogItem` 加 `project_id: int | None`、`operation_type: str | None`（向后兼容，可空）
- list 端点加 Query：`project_id: int | None`、`operation_type: str | None`；`_apply_filters` 同步支持

### B. 写操作明细上架（后端）

**B1. 新端点** `system_management/agent_operations.py`（router prefix `/agent-operation-logs`）
- `list_agent_operation_logs`：查 `operation_audit_logs` WHERE `agent_id IS NOT NULL`；过滤 `agent_id` / `project_id` / `action` / `result` / `date_from` / `date_to` / `keyword` / 分页
  - project_id 过滤：`request_path LIKE '%/projects/{id}/%'`（PG/SQLite 通用；不引入新列，避免动写路由）
  - 响应项派生 `project_id`：优先 `request_path` 正则，其次 `before/after_json.project_id`（部分 action 已带）
- `agent_operation_logs_summary`：total / success / failure / unique_agent_count / top_agents / top_actions
- Schema：`schemas/system_management/agent_operations.py`（`AgentOperationLogItem`：id / created_at / agent_id / action / target_type / target_id / result / project_id / request_path / request_method / before_json / after_json / idempotency_key / error_message）

**C. 前端改造（Seth 负责，可并行）**

**C1. 读访问日志面板增强**（`components/system/agent-access-logs-panel.tsx`）
- 表格加「项目 ID」「操作类型」列；筛选区加 project_id 输入 + 操作类型下拉（选项来自 `agent-domains.ts`）

**C2. 新增写操作明细面板**（`components/system/agent-operation-logs-panel.tsx`）
- 列表：时间 / Agent / 操作（语义化标签）/ 项目 ID / 对象（target_type + target_id）/ 结果 / 详情
- 详情 Dialog：before/after **语义化 diff**（核心体验）
- 新增纯函数模块 `lib/agent-operation-diff.ts`：`describeOperation(action, before, after) -> { title, changes: [{ field, from, to }] }`
  - 已知 action 映射：如 `shipment.status.transition` → 「货件状态」 from=「在途 (in_transit)」 to=「已入库 (complete)」（状态码 → 中文文案表放前端）；create / items.replace / update / delete / recalculate_costs / shop_calculation.* / new_product_calculation.* 等
  - **通用兜底**：遍历 before/after 顶层键 diff，渲染 `key: old → new`

**C3. 挂载**（`app/dashboard/system/agent-management/agent-management-client.tsx`）
- 访问日志 Tab 内拆「读访问」「写操作」两个子 Tab，或新增独立 Tab（**待用户拍板**，见待确认问题 1）

## 待确认问题（详细制定环节）

1. **展示位置**：访问日志 Tab 内拆子 Tab（推荐，集中管理）还是独立 Tab「操作明细」？
2. **操作类型粒度**：external 镜像 51 条读路由覆盖退货/广告/库存/财务等**规划中**域——operation_type 对规划中域显示域 code，还是统一「其他」？是否本次就全量补映射？
3. **diff 语义化范围**：仅货件状态等关键字段做语义化展示，其余通用 old→new 列表，是否够用？（推荐：语义化白名单 + 通用兜底）
4. **写操作按项目过滤**：是否需要？（推荐：要，成本低）
5. **`operation_audit_logs` 保留期**：读访问日志有 90 天 Celery 清理，写操作表**目前无清理**——是否同步加保留期任务？（推荐：要，防无限膨胀）
6. **「业务域概览」加读/写统计**：呼应「对整体读写操作的把握」——概览 Tab 每域展示近 N 天读/写调用次数？（推荐：summary 端点扩展，可放二期）
7. **agent 维度概览**：是否需要「某 Agent 的读/写次数 + 最近写操作」速览卡片？

## 任务拆解

### Phase 1：后端 — 读侧增强

**Task 1：迁移 + 模型** ✅（rev `238`，已部署）
- 文件：`alembic/versions/20260806_238_agent_audit_log_operation_fields.py`、`models/agent_api_audit_log.py`
- 接口：`AgentApiAuditLog.project_id: Mapped[int | None]`、`AgentApiAuditLog.operation_type: Mapped[str | None]`
- 状态：完成；存量 249 行回填 227 行（project_id）；VPS `alembic current`=238

**Task 2：中间件打标** ✅
- 文件：`middleware/agent_api_audit.py`
- 接口：`parse_audit_path_meta(path: str) -> tuple[int | None, str | None]`、`AGENT_PATH_DOMAIN_MAP: tuple[tuple[str, str], ...]`
- 状态：完成；域映射覆盖 external 镜像片段（Seth Q2 建议）；`tests/api/test_agent_api_audit_path_meta.py` 18 参数化用例

**Task 3：管理端点补列 + 过滤** ✅
- 文件：`schemas/system_management/agent_access_logs.py`、`endpoints/system_management/agent_access.py`、`tests/api/test_agent_access_logs.py`
- 接口：`AgentAccessLogItem.project_id` / `.operation_type`；list 加 `project_id` / `operation_type` Query
- 状态：完成；新增 `test_new_fields_project_and_operation_type`

### Phase 2：后端 — 写侧上架

**Task 4：写操作端点** ✅（已部署）
- 文件：`endpoints/system_management/agent_operations.py`、`schemas/system_management/agent_operations.py`、`tests/api/test_agent_operation_logs.py`；`system_management/__init__.py` 已 include
- 接口：`AgentOperationLogItem`（含 `operation_type` 派生 + `project_id` 派生）；`list_agent_operation_logs`（agent_id/project_id/action/result/date/keyword/page/page_size，响应 `{items,total,page,page_size,has_next}` 对齐读侧——Seth 契约建议）、`agent_operation_logs_summary`
- 状态：完成；operation_type 按 action 前缀派生（Seth 建议）

**Task 5：后端回归 + 部署准备** ✅
- `cd backend && pytest`：44 failed = 43 环境基线（Redis 未起等）+ 1 条 `test_list_joins_agent_identity` 顺序污染（已在 clean main 验证复现，非回归）；新测试全绿
- 迁移 + 端点已随 commit `c529c66f` 合 main，`git deploy` 已部署（VPS alembic=238、端点 200）

### Phase 3：前端（Seth，后端字段契约出即可并行）

**Task 6：读访问日志面板补列**
- 文件：`components/system/agent-access-logs-panel.tsx`、对应测试
- 接口：类型加 `project_id` / `operation_type`；筛选加两控件

**Task 7：diff 语义化模块**
- 文件：`lib/agent-operation-diff.ts`、`lib/agent-operation-diff.test.ts`
- 接口：`describeOperation(action, before, after)`、状态码文案表（in_transit=在途 / complete=已入库 / …）
- 步骤：TDD — 状态推进用例「in_transit → complete」→ 通用兜底用例 → 实现

**Task 8：写操作明细面板**
- 文件：`components/system/agent-operation-logs-panel.tsx`（+ 测试）
- 接口：拉 `/system-management/agent-operation-logs`；列表 + 详情 Dialog 渲染 `describeOperation` 输出

**Task 9：挂载 + 前端回归**
- `agent-management-client.tsx` 挂 Tab/子 Tab（按待确认问题 1 的结论）
- `pnpm lint` → `pnpm build` → `pnpm test`（全绿）+ 手动冒烟清单

### Phase 4：收尾
- 用户手动验收清单（列具体路径与预期）
- 完成判定后按 plans 约定归集 + `index.md`

## 对接边界（Seth）

- **后端先行交付 API 契约**：`AgentAccessLogItem` 新字段 + `agent-operation-logs` 两端点（本计划 Phase 1-2），字段名/类型见上；契约定了 Seth 即可并行开工，无需等后端部署完成。
- 前端 3 个交付物（Task 6/7/8）可由 Seth 独立承担；Damon 负责 Phase 1/2 与 Task 9 联调。
- 本 issue 评论中 @Seth 同步本 plan。

## 风险与对策

| 风险 | 对策 |
|------|------|
| `operation_audit_logs` 无保留期，表膨胀 | 待确认问题 5 增加 Celery 清理任务（对齐 access log 90 天模式）——**已完成**：`celery_tasks/operation_audit_cleanup.py` 每日 04:30 仅清 agent 行（`agent_id IS NOT NULL`，人工 operator 审计不受影响），setting `operation_audit_retention_days` 默认 90 |
| external 镜像 51 条路由 operation_type 映射不全 → 大量「未知」 | 长片段优先映射表 + 未知 fallback；统计口径在概览中说明；可二期补全 |
| 迁移回填大表扫描 | 分批 UPDATE + `agent_api_audit_log` 90 天保留量可控；回填幂等 |
| 动 `system_management` 端点影响既有审计页 | 只加字段/参数（可空、缺省不筛），`/audit-logs` 原端点不动 |
| 多 worktree 撞迁移号 | 建迁移前先 rebase main 取单链（AGENTS.md 流程），rev-id 用 `238` 且随 feature 分支同批合 main |
| 写路由全部已接 `append_operation_audit_log`，未来新增写路由忘接 | 在设计稿/约定中注明「agent 写路由必落操作审计」，可加 lint 或测试断言兜底（二期） |
