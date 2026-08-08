# CRM P7 任务系统 · 设计文档（待办 / 看板 / 提醒）

> **状态**：brainstorming 设计稿（2026-08-08）。含 2 个待用户拍板的决策点（§3 跟进整合、§4 提醒机制），拍板后进 writing-plans 拆实现计划。
> **基线**：main @ `9891ce8a`（BLF-524 已合）；prod alembic = **242**。⚠️ P6b 分支（`agent/damon/blf506-p6b-product-categories`）含迁移 **243** 未合 main —— P7-1 建迁移前必须先确认 P6b 是否已合，编号取合入后的 head+1（见 §12）。
> **范围**：任务实体 + 基础 CRUD + 客户/线索关联 + 看板 + 提醒 + 抽屉集成/筛选 + 跟进整合。**不含**：邮件/外部推送、子任务/评论/附件、循环任务、跨用户指派审批流、与 P9 规则引擎联动。

---

## 1. 业务背景

CRM 已上线 P1–P6：客户/线索 CRUD、跟进时间线、待跟进视图（P2，按 `next_follow_at` 分逾期/今日/本周）、公海自动回收（P3，N 天无跟进掉公海）、审计日志（P4/P5）、价值分档与产品类目（P6a/P6b）。

销售日常工作里「该打电话了 / 该拜访了 / 明天要跟进某客户」这类**待办**目前没有专门载体——只能靠客户身上的 `next_follow_at` 隐式表达（待跟进视图），无法管理「谁负责、多重要、什么类型、做没做完」。

**P7 目标**：引入独立的任务系统，把「未来的义务」管起来：
1. **待办管理**：创建带负责人/截止/优先级/类型的任务，状态流转（待办→进行中→完成/取消）。
2. **看板**：三列 Kanban 拖拽改状态，卡片一眼看到客户、截止、优先级。
3. **提醒**：截止前 24h 站内 Toast，不引入外部推送。
4. **与跟进体系衔接**：任务完成不破坏既有 P2 待跟进视图 / P3 公海回收的数据一致性。

---

## 2. 范围

| 做（本期） | 不做（本期） |
|---|---|
| `crm_tasks` 实体 + 基础 CRUD + 状态流转 + 权限 | 邮件 / 外部推送提醒 |
| 客户 / 线索关联（FK + 联查） | 子任务 / 任务评论 / 附件 |
| Kanban 三列 + 拖拽改状态（@dnd-kit/core） | 循环任务 / 模板任务 |
| 截止前 24h 站内 Toast 提醒（celery beat + SSE） | 跨用户指派审批流 |
| 任务列表筛选 / 排序 + 客户/线索抽屉任务 tab | 任务看板与 P9 规则引擎联动 |
| 跟进整合（§3 决策落地）+ 审计 | 任务到期提醒的邮件副本 |

---

## 3. 决策点 ①：跟进 follow 是否并入 task（核心，需用户拍板）

### 3.1 现状梳理（代码事实）

- `crm_follows`（`follow_service.py` / `models/crm.py:CrmFollow`）= **已发生互动的时间线日志**：`entity_type`(customer/lead) + `entity_id` + `type`(phone/visit/wechat/email/note) + `content`(聊了什么) + `next_follow_at`，append-only，无 status/priority/完成语义。
- **创建 follow 时回写实体**：客户 `last_follow_at` + `next_follow_at`，线索 `next_follow_at`（`follow_service.create_follow`）。
- 这两个字段驱动**两条已上线功能**：
  - P2 待跟进视图（`follow_up_service.py`：按 `next_follow_at` 分 overdue/today/this_week）；
  - P3 公海回收（`sea_reclaim_service.py`：`COALESCE(last_follow_at, created_at)` > N 天 → 掉公海 + 写系统 follow 留痕）。
- 客户/线索抽屉的「跟进时间线」直接渲染 `crm_follows`。

**语义结论**：follow 记「已发生」，task 管「待发生」——两者正交。follow 是历史，task 是未来义务。

### 3.2 三个方案

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 并存 + 完成联动双写**（推荐） | `crm_follows` 保持原样不动；`crm_tasks` 新建；**互动类任务 done 时自动生成一条 follow 记录并回写 `next_follow_at`/`last_follow_at`**（复用 `follow_service` 回写逻辑） | 零迁移零回归（P2/P3/时间线不动）；任务完成自动喂饱待跟进视图与公海回收；无数据分裂 | 需一个「done 联动」的事务内实现（task + follow + 回写 + 审计原子提交） |
| **B. follow 降级为 task 的一种 type** | 新跟进直接写 `crm_tasks(type=follow_up, status=done)`；`crm_follows` 冻结为历史归档 | 单一入口（跟进=任务） | 需把 P2 待跟进视图、P3 公海回收、`last_follow_at`/`next_follow_at` 回写全部迁移到 tasks —— 动 5+ 处已上线且已测试的逻辑（follow_service / follow_up_service / sea_reclaim_service / 前端时间线 / 待跟进视图），风险高；历史 follow 还要双读；本期收益仅是「少一个入口」 |
| **C. 纯并存不联动** | 两套完全独立，互不感知 | 实现最简 | 任务完成不刷新 `last_follow_at` → **公海回收失真**（销售明明在做任务，客户却被判定「N 天未跟进」回收）；待跟进视图也看不到任务安排 → 需额外补丁，实际省不了事 |

### 3.3 推荐：方案 A（并存 + 完成联动双写）

- **follow 保持时间线日志**：历史数据、P2/P3、抽屉时间线全部不动。
- **task 管未来待办**：`type=follow_up / call / visit / custom`。
- **联动规则**（核心）：互动类任务（follow_up/call/visit）**标记完成时**，在同一事务内：
  1. `status → done`、`completed_at = now`；
  2. 自动创建一条 follow：`type` 映射（call→phone / visit→visit / follow_up→note），`content` = 任务标题（可带完成备注）；
  3. 回写实体：客户 `last_follow_at = now`；若完成表单填了「下次跟进时间」→ `next_follow_at` 设值（保持 P2 视图工作），未填 → 清空（表示这次跟进了、没约下次，与 `follow_service.create_follow` 现有语义一致）；
  4. 审计 `action=complete`。
- `custom` 类任务（如「整理客户资料」）非互动 → done 不自动生成 follow，但抽屉里可手动补跟进。
- **done 联动需原子化**：`follow_service.create_follow` 目前自带 commit；P7 实现时给 follow 创建抽 `commit=` 参数（沿用 P5-6 强一致模式：service flush + 端点统一 commit），保证 task + follow + 回写 + 审计同事务。

### 3.4 对现有视图的影响

- P2 待跟进视图：照旧读 `next_follow_at`，任务 done 联动回写后自然包含「任务安排的下次跟进」。
- P3 公海回收：照旧读 `last_follow_at`，任务 done 联动刷新 → 销售做了任务不再被误回收。
- 前端无破坏性改动：时间线组件照旧，任务另起 tab/页面。

---

## 4. 决策点 ②：提醒机制（需用户拍板）

### 4.1 目标形态（roadmap P7.3 已定）

- **形态**：截止前 **24h** 站内 Toast（复用 `useNotifications().notify()`，`components/notifications/notifications-context.tsx`）。
- **收件人**：任务 `owner_id`（负责人）。未指派（owner 空）不提醒。
- **不引入**：邮件、微信/钉钉等外部推送。

### 4.2 链路（推荐 A：DB 去重标记 + SSE 轮询推送）

```
celery beat 每小时（crontab(minute=5) 错开整点）
  └─ crm_task_reminder_scan：扫 status ∈ {pending, in_progress} AND due_date ∈ (now, now+24h]
       AND reminded_at IS NULL   →  命中即 set reminded_at = now（每小时窗口内只提醒一次）
                                  （无独立提醒表：task.reminded_at 字段即「已提醒」标记）
  └─ （提醒可被 SSE 轮询拾取，无需 Redis pub/sub）

SSE 端点 GET /crm/tasks/reminders/stream（登录态，复用 digital_office 的 StreamingResponse 模式：
   每 60s tick + to_thread 查 DB + keep-alive 注释行 + is_disconnected 断连检测）
  └─ 查当前用户「应提醒且未过期」的任务（reminded_at IS NOT NULL AND due_date >= now
       AND status ∈ {pending, in_progress} AND owner_id = 当前用户）
  └─ 与上次推送的 id 集对比，有新增 → yield `event: task_reminder` + JSON

前端 TaskReminderToast（挂 CRM layout，仿 useOfficeStream 的 EventSource + 指数退避重连）
  └─ 收到事件 → notify({type:'warning', title:'任务即将到期', message:'「{title}」还剩不到 24 小时'})
  └─ 点击 toast → 跳转 /dashboard/crm/tasks
  └─ 会话去重：sessionStorage 记录本次会话已提醒的 task_id（仿 FollowUpToast 的 TOAST_FLAG 模式）
```

**为什么不用 Redis pub/sub 直推**：提醒是每小时级低频事件；若用户浏览器当时未打开，pub/sub 事件直接丢失。DB 标记 + SSE 轮询让提醒**持久化**——用户离线时错过提醒，下次进站重放一次（`reminded_at` 非空且未过期即重放）。复杂度低于 pub/sub（无 channel 管理、无丢失窗口、好测试）。

### 4.3 备选

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A. DB 标记 + SSE 轮询**（推荐） | 上文链路 | 离线不丢、可重放、复用仓库既有 SSE 模式；每小时级低频 → 60s 轮询延迟可接受 |
| B. Redis pub/sub 直推 | celery 发布 channel → SSE 订阅转发 | 最贴「推送」字面；无订阅者时事件丢失、无法重放；多一层 Redis 依赖 |
| C. 前端定时轮询 | 前端每 15–30min 拉 `GET /crm/tasks/reminders` | 最简；非推送语义，在线用户最多滞后 15–30min，与 roadmap「SSE 事件」不符 |

### 4.4 边界

- **逾期任务不提醒**（due_date < now 不再弹）——逾期场景 P2 已有「逾期未跟进」进站 toast 覆盖；任务列表/看板用红色标注逾期。
- **已 done/cancelled 不提醒**（扫描条件排除）。
- 提醒间隔常量 `REMIND_LEAD_HOURS = 24`（可配置，本期不开放 UI）。
- 同一任务只提醒一次（`reminded_at`），不每小时轰炸。

---

## 5. 数据模型（`crm_tasks`）

```
crm_tasks (
  id            Integer PK autoincrement
  title         String(200)  not null
  description   Text         nullable
  due_date      DateTime(timezone) nullable   -- 截止时间；null=无期限（不参与提醒/逾期标注）
  priority      String(10)   default 'medium' -- low / medium / high / urgent
  status        String(20)   default 'pending'-- pending / in_progress / done / cancelled
  type          String(20)   default 'custom' -- follow_up / call / visit / custom
  owner_id      String(36)   nullable         -- user_accounts.id UUID；null=未指派
  customer_id   Integer      nullable FK→crm_customers.id
  lead_id       Integer      nullable FK→crm_leads.id
  reminded_at   DateTime(timezone) nullable   -- 已提醒标记（§4 去重用）
  created_by    String(36)   nullable         -- 创建人
  completed_at  DateTime(timezone) nullable   -- done 时写入
  created_at    DateTime(timezone) server_default now()
  updated_at    DateTime(timezone) onupdate now()

  Index: idx_ct_owner_status(owner_id, status), idx_ct_due_date(due_date),
         idx_ct_customer(customer_id), idx_ct_lead(lead_id)
)
```

- **FK 策略**：`customer_id`/`lead_id` ON DELETE CASCADE（与 `crm_customer_categories` 一致）；业务删除以软删为主（`is_deleted`），软删不触发 FK，任务保留（历史待办不该消失）。
- **迁移**：**1 个迁移文件**（建表 + 全部列 + 索引），编号 = 合入 P6b 后的 head+1（当前 main head=242，P6b=243 → 预计 **244**；以 `alembic heads` 实测为准）。
- 主键 Integer、迁移命名 `YYYYMMDD_NNN_description.py`、纯增量可回滚（遵循 BEL-492 约定）。

---

## 6. 后端设计

### 6.1 服务模块 `app/services/crm/task_service.py`

```
create_task(db, payload, *, user_id, commit=True)          -- 建任务；owner 默认=user_id；admin 可指派他人
update_task(db, task, payload, *, user_id, commit=True)    -- 改字段；owner_id 仅 admin 可改（非 admin 传 owner_id → 403）
list_tasks(db, *, user_id, scope, filters, sort)           -- 列表 + 筛选 + 排序（复用 resolve_scope/filter_owned_ids）
get_task(db, task_id)                                      -- 详情（联查客户名/线索名/owner 名）
complete_task(db, task, *, user_id, commit=True)           -- done + completed_at + §3.3 联动（follow 生成 + 回写）+ 审计
cancel_task(db, task, *, user_id, commit=True)             -- cancelled + 审计
set_task_status(db, task, status, *, user_id, commit=True) -- 看板拖拽流转（pending/in_progress/done）
```

- **列表默认排序**：`due_date ASC NULLS LAST, priority DESC, created_at DESC`（紧迫的在前；null 截止垫底）。
- **筛选白名单**：`type / status / priority / owner_id / customer_id / lead_id`（复用 `filter_engine` 白名单模式防注入）。
- **排序白名单**：`due_date / priority / created_at / completed_at`。
- **联动原子化**：`follow_service` 抽 `commit=` 参数（或 task_service 内联回写），保证 task+follow+回写+审计单事务（P5-6 强一致）。

### 6.2 端点（挂 `backend/app/api/v1/endpoints/crm.py`，prefix `/crm`，`Depends(protected)`）

| 端点 | 权限 | 说明 |
|---|---|---|
| `GET /crm/tasks` | 登录（scope=mine/all，`resolve_scope` 降级） | 列表：筛选 + 排序 + 分页；admin/all 可 `owner_id` 过滤 |
| `POST /crm/tasks` | 登录 | 创建；`owner_id` 默认=自己；admin 可指派他人；关联客户/线索时校验其存在（404） |
| `GET /crm/tasks/{id}` | owner/admin（`require_owner_or_admin(task.owner_id)`） | 详情（联查客户名/线索名） |
| `PATCH /crm/tasks/{id}` | owner/admin | 改 title/description/due_date/priority/type；`owner_id` 仅 admin 可改（非 admin 传 → 403） |
| `POST /crm/tasks/{id}/status` | owner/admin | 看板拖拽：`{status}` 流转（pending/in_progress/done） |
| `POST /crm/tasks/{id}/complete` | owner/admin | 完成 + §3.3 联动（互动类自动生成 follow + 回写 next_follow_at/last_follow_at） |
| `POST /crm/tasks/{id}/cancel` | owner/admin | 取消 |

> 权限规则（拍板简化版）：**任务操作权限 = 任务 owner 或 admin**，不随关联客户 owner 自动授权（避免隐式越权面过大）。任务跟随负责人而非客户：客户被回收公海/转手，任务 owner 不变。

### 6.3 审计

- `entity_type="task"`；`create / update / complete / cancel / status` 全部走 `audit_service.record_log`（P5-6：service flush + 端点统一 commit）。
- update 摘要沿用 `summarize_update` 模式（如「优先级：中→高；截止：8/10→8/12」）。
- 审计前端标签 `AUDIT` 常量新增 `"task"`（P7-6 收尾）。

---

## 7. 提醒后端（§4 落地）

- **celery beat**：`celery_app.py` 的 `beat_schedule` 新增 `crm-task-reminder`（`crontab(minute=5)` 每小时 :05，错开整点任务），task 指向 `app/celery_tasks/crm_task_reminder.py`（仿 `crm_sea_reclaim.py` 结构）。
- **扫描**：`status ∈ {pending, in_progress}` AND `due_date IS NOT NULL` AND `due_date > now` AND `due_date <= now + 24h` AND `reminded_at IS NULL` → `reminded_at = now`（单次提醒）。
- **SSE 端点**：`GET /crm/tasks/reminders/stream`（登录态，StreamingResponse `text/event-stream`）：每 60s 查当前用户应提醒任务（`reminded_at` 非空、未过期、未完成、owner=当前用户），与上次推送 id 集 diff，新增则 `event: task_reminder` + `{task_id, title, due_date}`。首次连接即推送一次（重放离线期错过的提醒）。

---

## 8. 前端设计

### 8.1 页面与入口

- **`app/dashboard/crm/tasks/page.tsx`**：任务页（看板 + 列表双视图切换）。
- **侧边栏**：`frontend/lib/sidebar-config.ts` CRM 组加「任务」入口（url `/dashboard/crm/tasks`，icon 沿用组内风格）。
- **CRM layout**：挂 `TaskReminderToast`（仿 `FollowUpToast` 挂法）。

### 8.2 看板（P7-3，BLF-512）

- **依赖**：`@dnd-kit/core` + `@dnd-kit/sortable` **需安装**（当前未装，roadmap 已标注需确认）。
- 三列：`pending → in_progress → done`；`cancelled` 不入看板（列表可见）。
- 卡片：标题 + 客户/线索名（chips）+ `due_date`（逾期红、今日黄）+ priority 色条 + type 徽章 + owner 名（all 视图）。
- 拖拽落列 → `POST /crm/tasks/{id}/status`；乐观更新 + 失败回滚。
- 列头筛选：按 `type` 过滤（roadmap P7.4 看板可按 type 筛选）；`mine/all` 数据范围沿用 `useCrmDataScope`。

### 8.3 列表（P7-5，BLF-514）

- 表头筛选行：type / status / priority / owner / 关联客户（复用 P5 筛选基建）；排序：截止 / 优先级 / 创建时间。
- 行操作：编辑（弹窗）/ 完成 / 取消；完成后显示 completed_at。

### 8.4 抽屉集成（P7-5，BLF-514）

- `crm-overview-drawer` 新增「任务」tab（客户详情 / 线索详情内可见该实体关联任务，可新建）。
- 新建任务弹窗：标题必填、类型/优先级/截止/描述/（互动类）下次跟进时间。

### 8.5 API 层（三件套同步：`crm-client.ts` 接口 + `http-crm-client.ts` + `mock-crm-client.ts` + `dto-mappers.ts`）

- 类型 `Task`（types/task.ts）：id/title/description/dueDate/priority/status/type/ownerId/ownerName/customerId/customerName/leadId/leadName/remindedAt/completedAt/createdAt。
- 方法：`listTasks / createTask / updateTask / completeTask / cancelTask / setTaskStatus`。
- 常量（types/enums）：`TASK_STATUS`、`TASK_PRIORITY`、`TASK_TYPE` 中文标签 + 配色（仿 value-score 常量模式）。

---

## 9. 测试策略（TDD，先红后绿）

**后端**（基线：CRM ~305（P6b 分支口径），main 以实测为准）：
- `task_service`：CRUD；状态流转合法性（done/cancelled 后不可再流转）；权限 403（非 owner 非 admin）。
- **§3.3 联动（核心）**：complete follow_up/call/visit → 自动生成 follow（type 映射正确）+ 客户 `last_follow_at` 刷新 + `next_follow_at` 回写/清空；custom 完成不生成 follow；联动与审计同事务（失败回滚）。
- 端点：list 筛选/排序/分页；owner 变更仅 admin；关联客户/线索不存在 → 404；审计强一致。
- 提醒：扫描窗口（24h 边界）、`reminded_at` 去重（同一任务只提醒一次）、owner 过滤、done/cancelled 排除、SSE 重放逻辑（`reminded_at` 非空且未过期 → 推送）。

**前端**（基线：~608（P6b 分支口径））：
- Task mapper 单测；看板拖拽 handler（落列调 setTaskStatus + 乐观回滚）；提醒 toast（mock EventSource 事件 → notify 调用断言 + sessionStorage 去重）；列表筛选/排序；抽屉任务 tab。

**门禁**：`cd backend && .venv/bin/python -m pytest tests/api/crm tests/services/crm -q`；`cd frontend && pnpm lint && pnpm build && pnpm test`。迁移 PR 额外 `cd backend && python scripts/check_alembic.py`。

---

## 10. 子 issue 映射（6 个已挂，对应 roadmap 10 task）

| stage | 子 issue | roadmap task | 交付要点 |
|---|---|---|---|
| 1 | **BLF-510** P7-1 任务实体+CRUD | P7-1/2 | 1 个迁移（建表全列+索引）+ `crm_tasks` schema + `task_service` CRUD + 7 端点 + 权限 + 审计（entity_type="task"） |
| 1 | **BLF-511** P7-2 客户/线索关联 | P7-3 | `customer_id`/`lead_id` FK（随 BLF-510 迁移）+ 列表/详情联查客户名/线索名 |
| 2 | **BLF-512** P7-3 看板页面 | P7-4 | 安装 `@dnd-kit/core` + `@dnd-kit/sortable`；三列拖拽改状态；卡片字段；type 筛选 |
| 2 | **BLF-513** P7-4 提醒 | P7-5 | celery beat 每小时扫描 + `reminded_at` 去重 + SSE 端点 + `TaskReminderToast`（SSE 重放 + sessionStorage 去重） |
| 3 | **BLF-514** P7-5 抽屉+筛选 | P7-6/7 | 抽屉「任务」tab（客户/线索）；列表表头筛选 + 排序；`crm-client` 三件套 |
| 3 | **BLF-515** P7-6 跟进整合+审计收尾 | P7-8/9/10 | §3 决策落地（done 联动双写）+ 审计标签收尾 + 全量回归测试 |

阶段依赖：stage1（BLF-510 → BLF-511）→ stage2（BLF-512/513）→ stage3（BLF-514/515）。BLF-515 依赖 §3 拍板结论（设计文档为默认方案 A）。

---

## 11. 部署与迁移注意

- **迁移编号**：P7-1 建迁移前先 `git fetch origin && git rebase origin/main`，确认 P6b 是否已合（head 242 或 243）→ 编号取 head+1；`alembic heads` 必须单链。
- **含 backend 改动** → `git deploy` 触发 VPS（`alembic upgrade head` + 重启）；celery beat 配置变更需重启 worker/beat。
- **前端**：Vercel 自动部署；`@dnd-kit/*` 为新依赖，随 P7-3 分支引入。
- 提醒功能**默认开启**（新增 beat 项即生效）；若上线后噪声大，先调 `REMIND_LEAD_HOURS`，不紧急下线。

---

## 12. 未来扩展（本期不做，留接口）

- **任务到期邮件**：`REMIND_LEAD_HOURS` 常量 + `reminded_at` 已留位，接邮件只需在扫描任务里加发信分支。
- **子任务 / 评论 / 附件**：`crm_tasks` 可加 `parent_id` 自关联，本期不建表。
- **循环任务**：`type=custom` + cron 表达式字段（本期不加列）。
- **P9 规则引擎联动**：任务作为「规则动作」的落点（如「公海回收前自动建跟进任务」），P9 再做。
- **健康度评分**（roadmap P6 遗留）：任务完成频率可作为输入信号（后续 phase）。
