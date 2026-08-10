# CRM Stage5-1 对照验证报告：CordysCRM 7 大抽象模式 vs 当前实现

> 验证时间：2026-08-10（Stage5 往回验证与打磨，BLF-586 / BLF-587）
> 基准：`docs/cordys-crm-analysis.md` §7（7 大抽象模式）
> 前置：`docs/superpowers/plans/2026-07-18-crm-vs-cordys-evaluation.md`（2026-07-18 方案评估）
> 范围：本次为**逐域代码核对**（非方案层评估），产出 gap 清单供 Stage5 收口与 V2 立项
> 方法：CodeGraph 符号核对 + 源码逐行验证（所有结论附 file:line 证据）；后端测试基线 591 passed

---

## 0. 一句话结论

**7 大抽象模式中 5 个已按"简化版"完整落地，1 个部分落地（数据权限 mine/all 二分），1 个确认为缺口（Save View 视图复用，已立项 BLF-589 Stage5-3）。** 另发现 2 个此前评估未覆盖的实测缺口：①公海领取后列表不刷新（破坏 2026-07-18 评估 §3.2 的硬 DoD）；②线索池领取仅后端有能力、前端无入口。商机死代码残留已确认（后端模型/表/schema），随 BLF-588 一并清理。

---

## 1. 逐模式核对表

| # | CordysCRM 模式 | 状态 | 证据（file:line） | 说明 |
|---|---|---|---|---|
| 7.1 | Custom Field Schema（FieldDefinition + 渲染器） | ✅ 落地 | `frontend/lib/crm/types/field.ts`（FieldDefinition）；`frontend/lib/crm/field-defs/customer.ts`（CUSTOMER_FIELD_DEFS，16 字段含 text/select/phone/email/url/number/date/textarea）；`field-defs/lead.ts`（LEAD_FIELD_DEFS）；渲染器 `frontend/components/crm/crm-detail-card/` | 按 7.1 第二阶段建议实现（写死字段值 + FIELD_DEFS 数组 + renderField）；第三阶段拖拽表单设计器按 D5/D6 推 V2 |
| 7.2 | FormDesignKey 枚举（实体→schema 映射） | ✅ 等价落地 | `crm-overview-drawer` 泛型接收 `fields={CUSTOMER_FIELD_DEFS}` / `fields={LEAD_FIELD_DEFS}`（sea-table.tsx:173 / lead 侧同构） | 用"实体常量数组"等价替代 formKey 枚举；当前实体仅 customer/lead 两个（商机已砍），无需枚举表 |
| 7.3 | Save View（筛选条件保存/复用） | ❌ 缺口 | 前端无 view-select 组件（`frontend/components/crm/` 全量核对）；筛选态仅存 URL searchParams（`crm-table/use-crm-table.ts` buildUrl:67） | 会话级可复制 URL 共享，无持久化命名视图。**已立项 BLF-589（Stage5-3）**：个人视图优先，admin 共享 V2 |
| 7.4 | Overview Drawer（列表+侧拉详情，Tabs） | ✅ 落地 | `frontend/components/crm/crm-overview-drawer/index.tsx`（Tabs：详情/跟进/联系人/任务/操作记录/编辑，index.tsx:110-119） | 泛型 + FIELD_DEFS + 多态 FollowTimeline + 任务/审计 Tab；**上一条/下一条翻页按钮未做**（CordysCRM 增强项，V2 候选，非 DoD） |
| 7.5 | Follow Record（多态跟进 + 独立 Timeline） | ✅ 落地 | 后端 `crm_follows` 表 entity_type+entity_id 多态（`models/crm.py` CrmFollow:269）；`follow_service.create_follow` 回写 last_follow_at/next_follow_at（客户+线索，follow_service.py:94-112）；前端 `crm-follow-timeline/`（FollowEntityType='customer'\|'lead'，types/follow.ts:2） | P9-4 (BLF-542) 跟进刷新 last_follow_at 同时重置回收计时，与 7.5 语义对齐且更完善 |
| 7.6 | 公海 + 线索池 + 回收规则 | ✅ 落地（超原计划） | 领取：`POST /customers/{id}/claim`（crm.py:388，409 若不在公海+审计）、`POST /leads/{id}/claim`（crm.py:662）；自动回收：`celery_tasks/crm_sea_reclaim.py` + `sea_reclaim_service.reclaim_stale_to_sea`（N 天未跟进→owner=null，客户 rating=A 永不回收 P9-3，写系统跟进留痕） | 2026-07-18 评估时公海为"仅手动、无自动回收"；P9 已补上自动回收，**超出 MVP 原计划**。见 §3.1/§3.2 两个实测缺口 |
| 7.7 | 数据权限（RBAC CRM 版：本人/部门/子部门/全部/自定义） | ⚠️ 部分落地 | `permissions.resolve_scope`（非 admin all→mine，permissions.py:17）；list 端点 scope 参数（crm.py:132/513）；service 层过滤（mine=owner_id==cur、sea=owner_id IS NULL、all=不过滤，customer_service.py:144-148）；`require_owner_or_admin`（写操作：非 owner 403，permissions.py:30） | mine/all/sea 三档 + 操作级权限已闭环；**缺部门粒度**（user_accounts 无部门字段，customer_service.py:148 注释已预留）。见 §4 评估 |

---

## 2. 商机残留核对（cross-cutting）

用户已拍板砍商机（2026-07-18 评估 §3.1：维持 D8 砍）。实测残留清单：

**后端（BLF-588 清理对象）**：
| 位置 | 内容 | 是否被引用 |
|---|---|---|
| `backend/app/models/crm.py:233-266` | `CrmOpportunity` 模型（表 `crm_opportunities`，含 2 索引） | ❌ 无任何 service/endpoint 引用（CodeGraph 全量 callers=0） |
| `backend/app/models/crm.py:61-67` | `CrmOpportunityStage` 枚举 | ❌ 仅被死模型引用 |
| `backend/app/models/crm.py:76-81` | `CrmFollowEntityType.OPPORTUNITY` | ❌ CodeGraph callers=0（全 enum 未被引用） |
| `backend/app/models/__init__.py:134/258` | `CrmOpportunity` 导出 | 随模型删除 |
| `backend/app/schemas/crm.py:302-349` | `OpportunityCreate/Update/Item/ListResponse` | ❌ 无任何 import（CodeGraph 全量核对） |
| `backend/app/schemas/crm.py:354` | `FollowCreate.entity_type: Literal[..., "opportunity"]` | ⚠️ 被 create_follow 使用——"opportunity" 分支在 follow_service 无对应处理（follow_service.py 仅 customer/lead），属死枚举值 |
| 迁移 215/217 | 建表/owner_id 改造（历史） | 保留不改（BEL-492：已部署迁移禁止改） |
| 17 个测试文件 | `truncate ... crm_opportunities` | 表删除后 truncate 会失败，需同步清理 |
| `frontend/types/api-generated/api.d.ts:12142` | `entity_type: "customer" | "lead" | "opportunity"` | OpenAPI 自动生成；后端清理后 `make openapi-export` 再生成即消 |

**前端**：`frontend/app/dashboard/crm/` 无商机页面/路由；`frontend/lib/crm/` 无 opportunity 类型/组件。**商机在前端已完全清除**，残留仅 OpenAPI 生成文件。

---

## 3. 公海/线索池行为核对（BLF-588 任务项，实测发现 2 个缺口）

### 3.1 【缺口 A · 前端】公海领取后列表不刷新 —— 违反 2026-07-18 评估 §3.2 硬 DoD

评估定稿的硬 DoD："**领取后能从公海消失、列表刷新**"（§3.2 第 3 条硬指令）。实测**未满足**：

- 领取处理：`sea-table.tsx` `handleClaim`（:140-146）→ `client.claimFromSea(id)` → 关 Drawer，**无任何列表刷新**（未调 `refresh()`，未 bump `refreshKey`）
- 刷新机制：`crm-table/index.tsx` 有 `refreshKey` prop（:125/:161），`use-crm-table.ts` 暴露 `refresh()`（:200-202）；但 `sea/page.tsx` 的 `<CrmSeaTable key={refreshKey} />`（:23）仅 `onImported`（批量导入）时 bump（:27）
- 后果：领取成功的客户仍留在公海列表（翻页/改筛选/重进页面才消失），演示与心智均穿帮

**修复归属**：前端（Seth，BLF-555 职责边界）。最小改动：`handleClaim` 成功后调 `table.refresh()`（CrmTable 需向调用方暴露，或 sea 页将 refreshKey 提升——与客户页 `customer-table.tsx:114` 同模式）。

### 3.2 【缺口 B · 前后端】线索池领取仅后端有能力，前端无入口

- 后端：`POST /leads/{lead_id}/claim`（crm.py:662）+ `lead_service.claim_from_pool`（:213）完整
- 前端：`http-crm-client.ts` **无 `claimFromPool` 方法**（全量核对）；线索页（`leads/page.tsx`）仅 mine/all ScopeToggle，无"线索池"视图；`batch-move-pool` 同理仅后端
- 现状：线索池数据可见性 = scope=all（admin）/mine 不含池（池 owner_id IS NULL）；池内线索无任何前端领取入口 → **线索池"只进不出"**（除非 admin 用 API）

**修复归属**：前端（Seth）。方案建议：线索页增加"线索池"筛选/独立视图（参照公海页），客户端补 `claimFromPool`；或确认"线索池 V2 再做"。

### 3.3 回收冷却期（CordysCRM 7.6 "领取有冷却期"）

- 现状：`batch_move_to_sea` / `batch_move_to_pool`（owner_id=None）后**无冷却期**，可立即被（自己或他人）重新领取（claim 仅校验 owner_id IS NULL，customer_service.py:310-316 / lead_service.py:219-225）
- 评估：属 V2（需 schema 加 `released_at` 字段 + claim 校验逻辑）。MVP 范围明确"自动回收 V2"，冷却期随自动回收体系一起做更自然。**不在本次打磨范围**（记录待 V2 立项）。

### 3.4 已确认良好的行为（无需改动）

- 领取原子性：claim 后 owner 立即写入 + 审计留痕（`action="claim"`），409 防并发双领（owner_id IS NULL 条件在 SQL 层）
- 自动回收闭环：N 天无跟进→回收→写系统跟进（`_write_system_follow`，sea_reclaim_service.py:33-45）；A 档客户永不回收（P9-3）；跟进成功重置计时（P9-4）
- 权限配合：非 admin 不能写非自己名下记录（`require_owner_or_admin`）；批量释放仅过滤自己名下 id（`filter_owned_ids`）

---

## 4. 权限粒度缺口评估（BLF-588 任务项：是否补部门粒度）

### 4.1 现状

- **读**：scope=mine / all / sea 三档；非 admin 的 all 静默降级 mine（`resolve_scope`，permissions.py:17-21）
- **写**：owner 或 admin 二分（`require_owner_or_admin` / `filter_owned_ids`）
- **数据模型**：`user_accounts`（平台表）无部门/组织字段；CRM 实体 owner_id 直接存 user_accounts.id UUID

### 4.2 对照 CordysCRM 7.7（5 档：本人/本部门/本部门及子部门/全部/自定义）

| 维度 | 我们 | CordysCRM | 差距 |
|---|---|---|---|
| 本人 | ✅ mine | ✅ | 无 |
| 本部门 | ❌ 无 | ✅ | **缺**：无部门概念 |
| 部门及子部门 | ❌ 无 | ✅ | **缺**：无组织树 |
| 全部 | ✅ admin | ✅ | 无 |
| 自定义勾选 | ❌ 无 | ✅ | **缺**：属部门粒度之上层 |

### 4.3 结论与建议

- **建议：本次不补部门粒度，列为 V2**。理由：
  1. **前置缺失**：`user_accounts` 无部门字段，平台侧无组织/部门管理模块（CRM 域外），补粒度需先立"组织架构"概念——远超 Stage5 打磨范围；
  2. **团队现状**：当前 CRM 用户以"销售个人 + 管理员"为主（MVP 两角色），mine/all 已覆盖真实使用；
  3. **代码已预留**：`customer_service.py:148` 注释"P4 引入部门粒度后按角色收紧"；`resolve_scope` 是单一入口，未来加 `scope=dept` 只需在此 + service 过滤两处扩展，不影响现有调用方。
- **建议在 V2 立项时**：先补 `user_accounts.department_id` + 部门表 → `resolve_scope` 加 dept 档 → list service 按部门过滤 → 再考虑树形下钻与自定义勾选。

---

## 5. Gap 清单汇总（供收口 / 立项）

| # | Gap | 严重度 | 归属 | 动作 |
|---|---|---|---|---|
| G1 | Save View 缺失（7.3） | 中（已立项） | 前端 + 后端（BLF-589） | Stage5-3 落地：个人视图 + 列表复用 |
| G2 | 公海领取后列表不刷新（3.1） | **高（破坏硬 DoD）** | 前端（Seth） | 领取成功→refresh |
| G3 | 线索池无前端入口（3.2） | 中（池只进不出） | 前端（Seth） | 补 claimFromPool + 池视图（或确认 V2） |
| G4 | 商机死代码残留 | 中（已拍板砍） | 后端（本 PR BLF-588） | 删模型/表/schema + 迁移 + 测试清理 |
| G5 | 部门粒度缺失（7.7） | 低（V2） | 后端（V2） | 组织架构先行（§4.3） |
| G6 | 领取冷却期缺失（3.3） | 低（V2） | 后端（V2） | released_at + claim 校验 |
| G7 | Drawer 上一条/下一条（7.4 增强） | 低（V2） | 前端（V2） | 顺手项 |

---

## 6. 验证方法记录

- 后端符号核对：CodeGraph（`codegraph init` 后 29,770 nodes / 67,354 edges），`CrmOpportunity` 全量 callers/imports 核对、`CrmFollowEntityType` callers=0、Opportunity* schema 无 import
- 前端组件核对：`frontend/components/crm/` 全量目录核对（无 view-select / opportunity 组件）
- 后端测试基线：`tests/services/crm` + `tests/api/crm` + 规则引擎模型测试 **591 passed**（BLF_test，alembic 252）
- 迁移现状：prod alembic=252（P6b PR #228 合并部署后），BLF_test 同步至 252

**版本**：v0.1 · 2026-08-10 · BLF-587
**关联**：BLF-586（Stage5 总）、BLF-588（逻辑打磨）、BLF-589（Save View）、`docs/cordys-crm-analysis.md`、`docs/superpowers/plans/2026-07-18-crm-vs-cordys-evaluation.md`
