# CRM 基础版实施计划（价值阶梯 · Living Doc）

> **状态**：🧭 路线图定稿，P1 待开工（P0 演示骨架已完成，见 [`CRM-MVP-PLAN.md`](./CRM-MVP-PLAN.md)）
> **版本**：v1.0 · 2026-07-22
> **定位**：本文是 **CRM 基础版** 的总体设计 + 分阶段路线图，是 [`CRM-MVP-PLAN.md`](./CRM-MVP-PLAN.md) 的**继承者**——MVP 即本路线图的 P0（已完成），自 P1 起以本文为权威。
> **关联**：[`CRM-MVP-PLAN.md`](./CRM-MVP-PLAN.md)（P0 演示骨架 · 已完成）、[`cordys-crm-analysis.md`](./cordys-crm-analysis.md)（CordysCRM 调研）、[`superpowers/plans/2026-07-18-crm-vs-cordys-evaluation.md`](./superpowers/plans/2026-07-18-crm-vs-cordys-evaluation.md)（对照评估）
> **维护规则**：每个 Phase 结束更新「进度日志」+ 勾选复选框；每个 Phase 开工前用 `writing-plans` 技能产出该阶段的**详细实现计划**（本文不预写 P2-P5 的 day-by-day 任务，避免在 P1 结果未定时过度规划）。

---

## 0. 进度日志

| 日期 | 阶段 | 完成项 | 阻塞 / 风险 | 备注 |
|---|---|---|---|---|
| 2026-07-22 | 路线图 | 基础版总体设计定稿；三个定位决策拍板；P0-P5 价值阶梯成型 | — | P0（演示骨架）已在 CRM-MVP-PLAN.md 完成 |

---

## 1. 三个已拍板的定位决策（决定整个路线图重心）

> 2026-07-22 review 时由用户确认。这三条是本计划与 MVP 计划的**根本分野**——MVP 是「Dashboard 内的 Mock 演示片段」，基础版是「销售团队真实日常使用的工具」。

| # | 决策 | 裁定 | 对路线图的影响 |
|---|---|---|---|
| **L1** | 基础版本质 | ✅ **真实可用的工具**：接 FastAPI 真实后端 + 真实数据 + 真实登录身份 | **接真实后端从 MVP 的「V2 脚注」提为 P1 主线**，是基础版本体（~60% 真实工作量在后端） |
| **L2** | 主要使用者 | ✅ **真实销售团队**（多人） | 部门数据权限、公海自动回收 + 领取冷却、我的工作台从「可选」提为**刚需**，分别排入 P3/P4 |
| **L3** | 客户数据归属 | ✅ **CRM Customer 独立新建**（暂不与 business-dev/suppliers、commission project 耦合） | P1 数据模型独立建表；与 commission project 的打通**推迟**到 P5+ / V2，但 P2 商机赢单处**预留挂接点**（外键 nullable） |

> **L3 的取舍说明**：review 中曾建议「商机赢单 → 直接生成 commission project」打通你独有的业务闭环。用户选择**先独立**，故本路线图把该打通推迟，但在 §5（P2）的 `opportunity` 表保留 `linked_project_id: int | null` 挂接点，未来打通零迁移成本。

---

## 2. 核心构想：从「功能清单」到「价值阶梯」

MVP 计划用「MVP + V2 功能列表」组织，基础版改用**价值里程碑**组织——每一阶段让 CRM 跨过一个**质变门槛**，而不是堆功能：

```
P0 演示骨架 ──> P1 让它真实 ──> P2 让它成管道 ──> P3 让它有粘性 ──> P4 让它撑团队 ──> P5 让它聪明
   (已完成)       (demo→工具)     (三表→一条流)    (被叫才开→每天开)   (个人→团队)       (差异化·复用AI)
```

**相对 MVP 计划的三点实质升级：**

1. **接真实后端是 P1 主线，不是脚注。** 你已有成熟 FastAPI 0.139 + SQLAlchemy 2.0 + Alembic + 真实部署（`believeboy-api` systemd + `deploy_vps.py`），建 CRM 后端模块的基建**全部现成**。且 MVP 的 `CrmClient` 接口契约（D4 Mock 先行）此刻**兑现红利**：P1 前端几乎不重写，只需实现一个 `http-crm-client.ts` + 翻 Provider 开关，工作量集中在后端。
2. **管道是一等公民。** MVP 有线索/客户/商机三张孤立表；基础版补「结缔组织」——阶段变更历史、转化追踪、漏斗指标，让三张表变成一条可度量的销售流。
3. **AI 从「非目标」变 P5 差异化杠杆。** 你已有 `ai_chat` 模型 + pydantic-ai 2.9 流式编排。跟进摘要、下一步跟进建议、线索打分——CordysCRM 需独立 `/agent` 模块，你这是**复用现成底座**。

---

## 3. 阶段总览

| 阶段 | 主题 | 跨过的门槛 | 关键交付 | 工期估算* | 状态 |
|---|---|---|---|---|---|
| **P0** | 演示骨架 | UX 范式跑通 | Mock + 三实体闭环 UI + `CrmClient` 契约 | 10d | ✅ 完成 |
| **P1** | 让它真实 | demo → 能用的工具 | Postgres schema、FastAPI CRM 模块、真实 `http-crm-client`、接 `X-User-Id` 身份、冷启动 | **10-15d** | 🚧 待开工 |
| **P2** | 让它成管道 | 三张表 → 一条销售流 | 阶段历史、线索→客户转化追踪、管道漏斗、赢单挂接点 | 5-8d | ⏳ |
| **P3** | 让它有粘性 | 被叫才开 → 每天主动开 | 我的工作台、跟进提醒、公海自动回收 + 冷却、保存视图 | 6-9d | ⏳ |
| **P4** | 让它撑团队 | 个人 → 团队 | 部门数据权限、真 RBAC、Kanban、轻量自定义字段、查重、导入导出 | 8-12d | ⏳ |
| **P5** | 让它聪明 | 差异化 | 复用 pydantic-ai：跟进摘要 / 下一步建议 / 线索打分 | 5-8d | ⏳ |

> \* 工期为单人 + AI 辅助的**估算**，P2-P5 较粗（依赖 P1 落地结果）；每阶段开工前以 `writing-plans` 细化。P1 内部再分 P1a-P1d（见 §4）。

---

## 4. P1 · 让它真实（后端 + 身份 + 数据模型）— 路线图主干

> **目标**：CRM 从 Mock 演示变为销售团队可真实使用的工具。前端复用 P0 成果，工作量集中在后端。
> **门槛**：销售用真实账号登录，看到/编辑的是 Postgres 里的真实数据，刷新/换人不丢。

### 4.1 后端数据模型（Alembic + SQLAlchemy 2.0）

遵循现有模型风格（`app/models/alert_rule.py`：`Mapped`/`mapped_column`、`str`-enum 类、`__table_args__` Index、`server_default=func.now()`、Integer 主键）。新建 `app/models/crm.py`：

```python
#  sketch —— 遵循 alert_rule.py 风格，非最终字段
class CrmCustomer(Base):
    __tablename__ = "crm_customers"
    __table_args__ = (
        Index("idx_cc_owner", "owner_id"),
        Index("idx_cc_status_rating", "status", "rating"),
        Index("idx_cc_last_follow", "last_follow_at"),   # P3 公海回收/待跟进依赖
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    rating: Mapped[str] = mapped_column(String(2), default="C")      # A/B/C/D
    status: Mapped[str] = mapped_column(String(20), default="active")
    source: Mapped[str | None] = mapped_column(String(30))
    owner_id: Mapped[int | None] = mapped_column(Integer)            # null = 在公海
    last_follow_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)  # 软删除（团队工具必备）
    # ... 其余字段对齐 frontend/lib/crm/types/customer.ts

class CrmLead(Base):       # 同构，含 converted_to_customer_id / converted_at
class CrmOpportunity(Base): # 同构，含 stage / linked_project_id(nullable, L3 挂接点)
class CrmFollow(Base):      # 多态 entity_type + entity_id，next_follow_at（P3 提醒依赖）
```

**⚠️ P1 开工前必须拍板的数据模型决策（见 §4.6）：**

- **Customer 与 Contact 是否拆分（Account 1:N Contact）？** MVP 把 `contactName/contactPhone/contactEmail` 压扁在 Customer 上（一公司一联系人）。真实团队需要多联系人（采购/技术/老板）。
  - **推荐：P1 就拆** `crm_contacts`（FK → customer，含 `is_primary`）。理由：**现在还没有真实数据，是拆分最便宜的时刻**；一旦灌入真实客户再拆，迁移痛苦。CordysCRM 正是 Account 1:N Contact。
  - **回退**：若控工期，P1 先保留压扁的 primary contact 字段，P2 再拆（代价：P2 多一次迁移）。
- **`owner_id` 指向哪张用户表？** 复用现有认证体系的用户 id（与 `X-User-Id` 一致），**不另建 CRM 用户表**；`crm-user-select` 的数据源走现有用户接口（P1 确认现有用户表/接口形态）。
- **软删除 + 操作日志**：团队工具必备。软删除用 `is_deleted`；操作日志**复用现有 `operation_audit_log` 基建**（不另造），P1 仅在关键 mutation（转移/移公海/领取/转化）写入。

### 4.2 后端模块结构（遵循现有约定）

```
backend/app/
├── models/crm.py                 # 上述 5 个模型
├── schemas/crm.py                # Pydantic：CustomerIn/Out、LeadIn/Out、ListParams、Paginated[T]
├── services/crm/                 # 业务逻辑（scope 过滤、转化、公海领取、last_follow_at 维护）
│   ├── customer_service.py
│   ├── lead_service.py           # convert_lead：事务内建 Customer + 标记 Lead converted
│   └── follow_service.py         # 写跟进时回写实体 last_follow_at
├── api/v1/endpoints/crm.py       # 路由，注册进 api/v1/router.py
└── alembic/versions/<ts>_add_crm_tables.py
```

**端点草图**（对齐 MVP §6.1 `CrmClient` 接口，一一映射）：

```
GET    /api/v1/crm/customers            列表（scope/filter/page/sort/keyword）
POST   /api/v1/crm/customers            新建
GET    /api/v1/crm/customers/{id}       详情
PATCH  /api/v1/crm/customers/{id}       编辑
DELETE /api/v1/crm/customers/{id}       软删除
POST   /api/v1/crm/customers/batch-transfer   批量转移
POST   /api/v1/crm/customers/batch-move-sea   批量移入公海（owner_id=null）
POST   /api/v1/crm/customers/{id}/claim       从公海领取（owner_id=当前用户）
GET/POST /api/v1/crm/customers/{id}/contacts  联系人（若 §4.6 拍板拆分）
GET/POST/PATCH /api/v1/crm/leads ...    + POST /{id}/convert（转客户）
GET/POST/PATCH /api/v1/crm/opportunities ...
GET    /api/v1/crm/follows?entity_type=&entity_id=    + POST
GET    /api/v1/crm/users                 供 crm-user-select
```

**身份与数据范围（遵循现有约定，不发明）：**

- 端点读 `X-User-Id` header（Next proxy 从已登录 session 注入，同 `profile.py` / `scheduled_reports.py` / `ai_chat.py`）。复用 `auth.py::get_current_user` 或 `scheduled_reports.py::_get_user_id` 模式抽一个 CRM 依赖。
- `scope=mine` → `WHERE owner_id = :current_user`；`scope=all` → 不加 owner 过滤（**P4 之前**「all」= 全员可见，P4 引入部门粒度后按角色收紧）。
- 操作级权限（`canEdit/canDelete/canClaim`）从 MVP 的前端 `permission.ts` **下沉到后端 service 校验**（前端判断保留作 UX，后端是权威）。

### 4.3 前端切换（兑现 D4 Mock 先行红利）

P0 已铺好 `CrmClient` 接口 + Provider，前端**几乎不重写**：

1. 实现 `frontend/lib/crm/api/http-crm-client.ts`（替换现有 `throw NotImplemented` 桩），逐方法对接 §4.2 端点。
2. `pnpm gen:api-types`（openapi-typescript，从 FastAPI OpenAPI 生成 TS 类型）——`pnpm build` 含 `gen:api-types:check`，类型不符直接红。
3. 翻 Provider 开关：`NEXT_PUBLIC_CRM_API_MODE=http`（`crm-client-provider.tsx` 已支持 mock/http 切换）。
4. 请求头携带操作者标识（对齐现有 projects API 的 `X-Operator` → Next proxy → 后端 `X-User-Id` 链路）。
5. Mock 保留作单测/E2E 夹具，**不删**（`MockCrmClient` 继续服务单元测试与离线演示）。

### 4.4 数据冷启动（L3：Customer 独立，无历史数据可迁）

- L3 已定 Customer 独立新建，且 `business-dev/suppliers` **无后端实体**（仅前端薄页 + 一个已 drop 的列），故**无遗留数据迁移**——P1 起于空表。
- 真实数据冷启动两条路：① 销售手工录入；② P1 末提供一个**最小 CSV 导入**（仅 customer，列映射写死）方便首批灌入。完整导入导出推 P4。
- 种子脚本：`backend/app/scripts/seed_crm.py`（dev 环境灌演示数据，复用 MVP `_generator.ts` 的分布逻辑）。

### 4.5 P1 内部分段 + 退出标准 + 风险

**内部分段（避免 3 周一坨）：**

- **P1a · 纵向打通一片**（customer + 身份 + http-client）：建 `crm_customers` 表 + customer CRUD 端点 + `X-User-Id` 依赖 + `http-crm-client` 的 customer 部分 + `gen:api-types`。退出：客户列表/详情/编辑用真实后端跑通。
- **P1b · lead + follow**：建表 + 端点 + `convert_lead` 事务 + follow 回写 `last_follow_at`。退出：线索→客户转化在真实后端闭环。
- **P1c · opportunity + scope + sea**：建表 + 端点 + `scope=mine/all` 过滤 + 公海领取/移入。退出：公海领取闭环、scope 切换生效。
- **P1d · 硬化**：操作级权限下沉后端 + 软删除 + 操作日志 + E2E 切真实后端 + 冷启动 CSV。退出：§4.5 退出标准全过。

**退出标准（DoD）：**

- [ ] `NEXT_PUBLIC_CRM_API_MODE=http` 下，客户/线索/商机/公海全流程操作真实 Postgres 数据
- [ ] 换账号登录，`scope=mine` 只看本人数据；操作级权限后端校验生效
- [ ] `pnpm gen:api-types:check` 绿（前后端类型一致）
- [ ] 后端 `pytest` 覆盖 CRM service（转化/公海/scope/权限）；前端单测继续绿（Mock 夹具）
- [ ] 4 条 Playwright E2E 在真实后端模式跑通
- [ ] `git deploy` 部署成功（命中 backend/ 触发 VPS：`alembic upgrade head` + 重启 + 健康检查）

**P1 风险：**

| 风险 | 缓解 |
|---|---|
| 现有用户表/接口形态不明，`owner_id`/`crm-user-select` 数据源不确定 | P1a 第一天先摸清现有认证/用户模型，再定 `owner_id` 外键 |
| 前后端类型漂移 | 每加一组端点即跑 `gen:api-types`，build 强制 check |
| Contact 拆分增工期 | §4.6 先拍板；控工期可走「P1 压扁、P2 拆」回退 |
| 真实后端 E2E 比 Mock 慢/不稳 | E2E 用独立测试库 + 事务回滚夹具；保留 Mock E2E 作 CI 快路径 |

### 4.6 P1 开工前需拍板清单

| # | 决策 | 推荐 | 备选 |
|---|---|---|---|
| P1-D1 | Customer/Contact 拆分 | **P1 就拆** `crm_contacts`（数据未灌入，最便宜） | P1 压扁、P2 拆 |
| P1-D2 | `owner_id` 用户来源 | 复用现有认证用户 id，不另建 CRM 用户表 | — |
| P1-D3 | 操作日志 | 复用 `operation_audit_log`，仅关键 mutation 写 | 另建 crm_log |
| P1-D4 | 冷启动 | 手工录入 + 最小 customer CSV 导入 | 仅手工 |
| P1-D5 | E2E 数据策略 | 独立测试库 + 事务回滚 | 每次清表 |

---

## 5. P2 · 让它成管道（结缔组织）

> **目标**：把线索/客户/商机三张孤立表变成一条**可度量的销售流**。
> **门槛**：管理者能看到「线索→客户转化率、各阶段管道金额、阶段停留时长」，商机赢单有处可去。

**交付：**

- **阶段变更历史**：`crm_stage_history`（entity_type/entity_id/from/to/changed_by/changed_at），商机 stage 变更与客户 status 变更都落历史。
- **转化追踪**：`convert_lead` 已建关联（P1），P2 补**转化漏斗视图**（线索总数 → 已联系 → 合格 → 转化，按 source/owner 维度）。
- **管道指标**：按 stage 聚合商机金额/数量、平均阶段停留时长、赢单率。后端出聚合端点，前端 `crm-pipeline-funnel`（只读，复用现有 `components/ui/chart.tsx`，**不引 iframe BI**——MVP 已确认）。
- **赢单挂接点（L3）**：`opportunity.linked_project_id: int | null` 预留；赢单时**不**自动生成 commission project（L3 推迟），但 UI 留「关联项目」只读展示位，未来打通零迁移。

**退出标准**：漏斗 + 管道金额 + 阶段停留三张图基于真实数据渲染；阶段变更有历史可查。

---

## 6. P3 · 让它有粘性（每日驱动）

> **目标**：让销售**每天主动打开** CRM，而不是被叫才开。这是 L2（真实团队）的刚需。
> **门槛**：销售上班先开工作台看「今天该跟谁」，公海按规则自动流转。

**交付：**

- **我的工作台**（`/dashboard/crm/workbench`，替换 MVP 的 redirect）：今日待跟进（`follow.next_follow_at <= today`）/ 待首次联系的新线索 / 本周将到期商机 / 我的管道快照 / N 天未跟进客户。数据全在 P1/P2 已有，**后端出聚合端点 `GET /crm/workbench/summary`，前端组装卡片**（复用 `components/ui/data-card.tsx`）。
- **跟进提醒引擎**：`next_follow_at` 驱动工作台「今日待跟进」队列 + 列表「已逾期」标记。MVP 模型已有 `nextFollowAt`，P3 让它真正被消费。
- **公海自动回收**（CordysCRM 核心机制，L2 刚需）：规则「N 天无跟进（`last_follow_at`）→ 自动 `owner_id=null` 回公海」+ **领取冷却期**（领取后 M 天内不可再释放）。用现有 **celery 定时任务**（`backend/app/celery_tasks`）跑每日回收扫描。N/M 写死配置（设置 UI 推 P4+）。
- **保存视图**（`crm-view-select`，CordysCRM 范式）：把当前筛选条件存为命名视图（「我的客户」「本周待跟进」「高意向线索」），个人级（团队共享推 P4）。

**退出标准**：工作台五卡片基于真实数据；逾期跟进/公海回收可演示；保存视图可切换。

---

## 7. P4 · 让它撑团队（权限 + 深度）

> **目标**：从「个人能用」到「团队可管」，再补 CRM 体验深度。
> **门槛**：经理看本部门、老板看全部；商机有看板；字段可轻量自定义。

**交付（按优先级）：**

1. **部门数据权限**（L2 收尾）：`scope` 从 `mine|all` 扩为 `mine|department|all`，按角色/部门树过滤（CordysCRM `permissionTab` 范式，抽 `useDataScope`）。需后端补部门/团队模型（视现有组织模型而定，P4 开工前评估）。
2. **真 RBAC**：操作级权限从「写死函数」升级为角色驱动（复用现有角色体系）。
3. **商机 Kanban**（`crm-stage-board`，`@dnd-kit/core`，MVP D8/D13 推迟项）：拖拽换 stage，落 `crm_stage_history`（P2 已建）。
4. **轻量自定义字段**（MVP D5 推迟项的**第一步**）：`FieldDefinition` 从前端常量升级为后端 `crm_field_def` 表 + 管理员配置 UI（**不含**拖拽设计器/公式引擎——那是 V2+）。
5. **查重 / 导入导出**：`crm-duplicate-check`（创建前按名称/电话查重）+ Excel 导入导出（复用现有 `lib/excel-styles.ts`）。

**退出标准**：部门 scope 三角色可见性正确；Kanban 拖拽换阶段；管理员可加自定义字段并在详情/列表展示。

---

## 8. P5 · 让它聪明（复用现有 AI 底座）

> **目标**：差异化。CordysCRM 需独立 `/agent` 模块，你**复用现成 `ai_chat` + pydantic-ai 2.9**。
> **门槛**：CRM 里能一键「总结这个客户的跟进历史」「建议下一步跟进」「给线索打分」。

**交付（小步、按需）：**

- **跟进历史摘要**：详情 Drawer「AI 总结」按钮 → 调现有 pydantic-ai agent，喂该实体 follow 时间线，出摘要。
- **下一步跟进建议**：基于跟进历史 + 客户状态，建议下次跟进类型/话术要点。
- **线索打分**：基于 intent/来源/互动频次给线索评分，辅助优先跟进。
- **（可选·L3 打通）**：商机赢单 → 经 AI/规则建议生成 commission project 草稿，闭合「销售→佣金」链路（L3 推迟项的落地时机，视业务需求）。

**退出标准**：详情 Drawer AI 摘要可用；线索打分展示在工作台/列表。

---

## 9. 从 MVP 继承的决策状态（D1-D22）

> MVP 的 22 条决策大部分在基础版**继续成立**（前端范式不变），少数随 L1-L3 **演进**。

| 决策 | 基础版状态 | 说明 |
|---|---|---|
| D1-D3（sidebar/layout/路由） | ✅ 保持 | P0 已落地 |
| **D4 Mock 先行 + 接口契约** | ✅ **兑现红利** | P1 前端不重写，只实现 http-client + 翻开关 |
| D5 写死字段 / 留 FieldDefinition | ⏫ **P4 升级** | P4 把 FieldDefinition 升为后端表 + 配置 UI（仍不含设计器/公式） |
| D6 公式引擎 / D7 表单设计器 | ❌ 仍推 V2+ | 不变 |
| **D8 商机 Kanban** | ⏫ **P4 落地** | 团队版需要，配 `@dnd-kit`（D13） |
| D9 侧拉 Drawer | ✅ 保持 | 核心 UX 范式 |
| **D10 独立 workbench** | ⏫ **P3 落地** | 团队版每日拉力刚需，替换 redirect |
| D11-D12（不引状态库/RQ） | ✅ 保持 | 前端范式不变 |
| D13 @dnd-kit | ⏫ P4 装 | 配 Kanban |
| D14 Vitest+Playwright | ✅ 保持 | P1 起 E2E 增「真实后端模式」 |
| D15 仅中文 | ✅ 保持 | i18n 仍 V2+ |
| D16 Toast 复用 | ✅ 保持 | — |
| D17 react-hook-form+zod | ✅ 保持 | — |
| D18 列宽拖拽 | ❌ 仍推后 | 不变 |
| D19-D22 | ✅ 保持 | 目录/文档约定不变 |

---

## 10. 跨阶段约定

- **测试**：后端 `pytest`（service 层重点：转化/公海/scope/权限）；前端 Vitest 继续用 Mock 夹具；Playwright 增 `mode=http` 真实后端路径（独立测试库 + 事务回滚）。
- **部署**：遵循 `git deploy`——P1 起每次命中 `backend/` 的 push 触发 VPS 部署（`alembic upgrade head` → 重启 `believeboy-api` → 健康检查）。**每个 Phase 的 alembic 迁移独立成文件**，可单独 `upgrade`。
- **类型同步**：后端每加端点即 `pnpm gen:api-types`，`pnpm build` 的 `gen:api-types:check` 把前后端类型漂移挡在 CI。
- **Commit**：中文 + Conventional Commits（`feat(crm): ...`），scope 中文，subject ≤50 字。
- **每阶段开工前**：用 `writing-plans` 技能产出该阶段详细实现计划（day-by-day + TDD 任务），本文只给路线图，不预写 P2-P5 细节。

---

## 11. 风险登记册（汇总）

| 风险 | 阶段 | 影响 | 缓解 |
|---|---|---|---|
| 现有用户/认证模型不明 | P1 | `owner_id`/user-select 返工 | P1a 首日摸清再定外键 |
| 前后端类型漂移 | P1 | build 红 | 每端点即 gen:api-types，CI check |
| Contact 拆分增工期 | P1 | +2-3d | §4.6 先拍板，备「P2 拆」回退 |
| 真实后端 E2E 不稳 | P1 | CI 飘 | 独立测试库 + 事务回滚；保留 Mock 快路径 |
| 部门模型缺失 | P4 | 权限做不深 | P4 开工前评估现有组织模型，必要时先建最小部门表 |
| 公海回收误伤 | P3 | 销售客户被误回收 | N 天阈值保守 + 回收前提醒 + 领取冷却 |
| AI 摘要质量/成本 | P5 | 体验差 | 小步上线，先内部用，按反馈调 prompt |

---

## 12. 明确不做（V2+，防 scope creep）

继承 MVP §16，并按 L1-L3 调整：

- 公式引擎 / 拖拽式表单设计器（D6/D7，自定义字段的「高级形态」）
- 审批流 / 工作流（`@antv/x6` 流程图）
- 合同 / 订单 / 报价 / 回款 / 发票 / 工商抬头（CordysCRM 的 V2 域）
- **CRM Customer ↔ commission project 自动打通**（L3 推迟，P2 留挂接点，P5 视需求落地）
- 标讯抓取
- 移动端 H5 专项（响应式不崩即可）
- 国际化（中/英）
- iframe BI 仪表板（用现有 chart.tsx，永不引）
- 公海回收规则的**可视化配置 UI**（P3 写死配置，UI 推后）

---

## 附录 A：P1 端点 ↔ 前端 CrmClient 方法映射

| 前端 `CrmClient` 方法 | 后端端点 |
|---|---|
| `listCustomers` | `GET /crm/customers` |
| `getCustomer` | `GET /crm/customers/{id}` |
| `createCustomer` / `updateCustomer` / `deleteCustomer` | `POST` / `PATCH {id}` / `DELETE {id}` |
| `batchTransferCustomers` | `POST /crm/customers/batch-transfer` |
| `batchMoveToSea` | `POST /crm/customers/batch-move-sea` |
| `claimFromSea` | `POST /crm/customers/{id}/claim` |
| `listLeads`/`getLead`/`createLead`/`updateLead` | `GET/POST` + `GET/PATCH /crm/leads/{id}` |
| `convertLead` | `POST /crm/leads/{id}/convert` |
| `listOpportunities`/`getOpportunity`/`create`/`update` | `GET/POST` + `GET/PATCH /crm/opportunities/{id}` |
| `listFollows` / `createFollow` | `GET /crm/follows?entity_type=&entity_id=` / `POST` |
| `listUsers` / `getUser` | `GET /crm/users` / `GET /crm/users/{id}` |

## 附录 B：与 MVP 计划的文档关系

- **P0（演示骨架）**：完整记录在 [`CRM-MVP-PLAN.md`](./CRM-MVP-PLAN.md)，已完成，本文不重复。
- **P1-P5（基础版）**：以本文为权威。MVP 计划的「V2 Backlog」中**被基础版收编**的项：商机 Kanban（→P4）、workbench（→P3）、http-crm-client 真实后端（→P1）、数据权限部门粒度（→P4）、轻量自定义字段（→P4）。
- 建议：在 `CRM-MVP-PLAN.md` 顶部状态行加一句「P0 已完成；基础版（P1+）见 `CRM-BASIC-PLAN.md`」作为指针（本次不改动该文件，待用户确认）。
