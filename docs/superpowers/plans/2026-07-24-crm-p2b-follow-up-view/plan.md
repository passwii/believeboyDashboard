# CRM P2b — 待跟进视图 + 提醒（实施计划）

> 状态：✅ 完成（待合并）｜ 分支：`feat/crm-p2b-follow-up-view` ｜ 日期：2026-07-24
> 上游：P1b 已合并部署（main=3bd7fc17，迁移 218）。本计划新增迁移 **219**。
>
> **完成验证**：后端 147 passed（+18 新）/ 前端 lint 0 错 · build 91 页 · test 212 passed（+3）；
> 本地真实 HTTP 冒烟全通（三分组 / 线索转化排除 / scope / next_follow_at 回写+暴露+清空）。

## 目标

销售每日刚需「今天该跟谁」。打开 CRM 即见逾期/今日/本周待跟进的线索+客户，逾期标红 + 站内 toast 提醒 + sidebar 红点 badge。

## 已确认设计（用户「全部按推荐」2026-07-24）

| # | 决策 |
|---|---|
| 1 | 数据模型：`crm_customers` + `crm_leads` 各加 `next_follow_at`(DateTime tz, nullable) 冗余列 + 索引 |
| 2 | 覆盖：线索 + 客户都算 |
| 3 | 分组：逾期(`<今日0点`,标红) / 今日 / 本周（互斥；超出本周不显示） |
| 4 | UI：sidebar 独立「待跟进」入口 + 逾期数红点 badge |
| 5 | 回写：create_follow 带 next_follow_at→设；不带→清空(null) |
| 6 | toast：进入 CRM 检查逾期数，每会话一次(sessionStorage)，用 `useNotifications().notify()` |
| 权限 | 销售只见自己名下；admin 可切 all 看全部（复用 `resolve_scope`） |
| 时区 | 日/周边界按 **Asia/Shanghai** 业务时区计算（库存储 UTC） |

## 后端任务

### B1 迁移 219 + 模型列
- `alembic revision --rev-id 219 -m "crm 客户/线索增加 next_follow_at"`（先 rebase origin/main 确认单 head）
- 加列：`crm_customers.next_follow_at`、`crm_leads.next_follow_at`（DateTime tz nullable）+ 索引 `idx_cc_next_follow` / `idx_cl_next_follow`
- `app/models/crm.py`：CrmCustomer / CrmLead 加 `next_follow_at: Mapped[datetime | None]`

### B2 create_follow 回写 next_follow_at（TDD）
- `follow_service.create_follow`：客户分支保留 last_follow_at 回写，新增 `cust.next_follow_at = payload.next_follow_at`；新增线索分支 `lead.next_follow_at = payload.next_follow_at`
- 测试 `tests/services/crm/test_follow_service.py`：带 next_follow_at 设入客户/线索；不带清空；线索原本无 last_follow_at 不报错

### B3 Schemas
- `app/schemas/crm.py`：`FollowUpItem`(entity_type/entity_id/name/subtitle/owner_id/owner_name/next_follow_at/last_follow_content/last_follow_at/rating/status/intent) + `FollowUpGroups`(overdue/today/this_week + overdue_count/total_count)

### B4 follow_up_service（TDD）
- 新文件 `app/services/crm/follow_up_service.py::list_follow_ups(db, *, user_id, scope, tz)`
- 查客户：`next_follow_at IS NOT NULL AND is_deleted=False`，scope 过滤（mine→owner_id==cur；all→不过滤）
- 查线索：`next_follow_at IS NOT NULL AND is_deleted=False AND status NOT IN (converted, discarded)`，同 scope 过滤
- 批量补：owner_names（user_accounts）、每实体最新一条 follow 的 content/created_at（一次 IN 查询，避免 N+1）
- 按 Asia/Shanghai 分组：overdue(next_follow_at < 今日0点) / today(今日) / this_week(明日~本周日23:59)；各组内按 next_follow_at asc
- 测试 `tests/services/crm/test_follow_up_service.py`：分组边界、scope 过滤、线索排除已转化/弃置、N+1 批量

### B5 路由（TDD）
- `app/api/v1/endpoints/crm.py`：`GET /follow-ups?scope=mine`（resolve_scope + get_request_user_id/is_admin）→ FollowUpGroups
- 测试 `tests/api/crm/test_follow_up_api.py`：销售只见自己、admin 见全部、分组正确、空结果

## 前端任务

### F1 类型
- `types/customer.ts` + `types/lead.ts`：加 `nextFollowAt?: string`
- 新 `types/follow-up.ts`：`FollowUpItem` + `FollowUpGroups`（camelCase）；`types/index.ts` 导出

### F2 dto-mappers（TDD）
- `dto-mappers.ts`：`mapFollowUp`(snake→camel, id int→string) + `mapFollowUpGroups`
- `dto-mappers.test.ts` 补用例

### F3 CrmClient 三件套
- `crm-client.ts`：接口加 `listFollowUps(scope?: 'mine'|'all'): Promise<FollowUpGroups>`
- `http-crm-client.ts`：`GET /crm/follow-ups?scope=`
- `mock-crm-client.ts`：从 mock follows 派生（nextFollowAt 落库到实体后分组）

### F4 待跟进页 + 列表组件
- `app/dashboard/crm/follow-ups/page.tsx` + `components/crm/follow-up-list/index.tsx`
- 三分组渲染（逾期红 / 今日 / 本周），每项：实体类型徽标 + 名称 + 副标题 + 负责人 + 下次跟进时间 + 上次跟进内容；点击打开 CrmOverviewDrawer（记跟进后刷新）
- admin 顶部 scope 切换（mine/all）

### F5 sidebar 入口 + badge
- `sidebar-config.ts` CRM 组加「待跟进」项（url `/dashboard/crm/follow-ups`，icon Bell/CalendarRange，matchPrefixes）
- SidebarSubItem 加可选 `badge?: ComponentType`；sidebar-panel 渲染 `{item.badge && <item.badge/>}`
- 新 `components/crm/follow-up-badge.tsx`：自包含 fetch `/api/backend/v1/crm/follow-ups`（全局 sidebar 在 CrmClientProvider 外，故直接 fetch），overdue_count>0 显示红点数字，60s 轮询

### F6 toast 提醒
- `app/dashboard/crm/layout.tsx` 内挂 `<FollowUpToast/>`（在 CrmClientProvider 内）：mount 时 listFollowUps，overdue_count>0 且 sessionStorage 无 `crm-overdue-toasted` → notify 一次并写标记

## 验证

- 后端：`cd backend && pytest tests/services/crm tests/api/crm`
- 前端：`cd frontend && pnpm lint && pnpm build && pnpm test`
- 本地全栈冒烟（同 P1b）：建线索→记跟进带 next_follow_at（昨日/今日/本周各一）→ GET /follow-ups 验三分组→转化/弃置后排除→toast/badge

## 风险/注意

- 迁移前 `git fetch && rebase origin/main` 确认单 head（防撞，遵 AGENTS.md）
- badge 改 sidebar-panel 有全局 blast radius → 仅加可选字段 + 条件渲染，不动现有逻辑
- 时区：分组边界用 Asia/Shanghai，避免 UTC 偏移导致「今日」错位
- 不碰数字员工分支 / 用户未提交 AI 文件
