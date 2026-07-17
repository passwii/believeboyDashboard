# 设计文档：CRM 功能框架

- 关联文档：[`../../CRM-MVP-PLAN.md`](../../CRM-MVP-PLAN.md)（v1.1；本次设计将作为 v1.2 增量）
- 状态：设计稿 v0.1（4 个未决项 Q1-Q4 拍板后升 v0.2）
- 范围：仅产出设计文档，**不写实现代码**；确认后由 writing-plans 拆实现计划
- 日期：2026-07-17
- 维护：Mavis（M3）+ 用户终审

> **核心约束（用户拍板）：** 现有数据模型（5 entity + 6 enum + 5 fixture）和 Phase 0 Bootstrap / Phase 1 Day 2 客户列表视为「**已落地的参考基线**」，本设计在此之上确定**业务规则 + 状态机 + 公海机制 + 权限边界**。

---

## 1. 目标与非目标

**目标**

- 把 CRM 核心业务流程（线索 → 客户 → 商机 → 公海）落到**单一权威设计**，消除 §0.5 进度日志里"分支污染 / 多口径"的隐患
- 明确 **5 个核心实体**的关系强度、状态机、转换规则
- 定义 **公海**的归属语义、动作通道、权限分级、历史记录
- 解决 plan §scope 遗留的 **business-dev 路由归类冲突**（plan 写"BD 不处理"但 sidebar 重构把 BD 放到了 crm 业务组下）
- 解决 CRM-MVP-PLAN §1.1 表里 `crm-advance-filter/predicate-engine.ts` 1.5+1.6 跳过 与 §1.7 handoff 提及 "≥20 case predicate-engine" 的任务清单矛盾

**非目标（YAGNI / V2 推迟）**

- 不实现商机 Kanban / 拖拽 / 报价单
- 不实现自定义字段 / 公式引擎 / 表单设计器
- 不实现线索池自动分配 / 公海自动回收规则
- 不实现商机 `won/lost` 回写 `customer.status`（plan §1 D8/D13 已有 V2 标记）
- 不实现 business-dev 模块（路由已拆但页面保留占位）
- 不解决"客户查重 / 合并 / 客户画像"（plan §7 V2 增量）
- 不引入新依赖（沿用 plan §Day 0 已装：react-hook-form / zod / shadcn form）

---

## 2. 决策清单

### 2.1 已拍板（7 项 · 2026-07-17 brainstorming）

| ID | 主题 | 决策 | 落地位置 |
|---|---|---|---|
| **D-A** | 主线转化链 | **单线串联**：线索 → 客户 → 商机 → 成单；每步可降级回退；公海是客户的**状态视图** | 数据模型 `lead.convertedToCustomerId` + `opportunity.customerId` 强外键已就位 |
| **D-B** | follow 跟进记录 | 统一表 + `entityType ∈ {customer, lead, opportunity}` + `entityId` 多态外键 | `lib/crm/types/follow.ts` 已就位 |
| **D-C** | 业务状态 × 公海归属 | **正交两维度**：`status` 4 选 1 × `ownerId` 有/无；`customer.status` **不**加 `in_sea`；公海 = `ownerId IS NULL` 的视图 | `lib/crm/types/customer.ts` 已就位（`ownerId: string \| null`） |
| **D-D** | 公海动作 | **丢回(必选原因) + 抢单 + 派单** 三通道；丢回原因：丢单/长期无意向/客户主动放弃/其他 | 需新增 CrmClient 方法：`moveToSea` / `claimFromSea` / `assignFromSea` |
| **D-E** | business-dev 路由 | **拆出 crm 业务组**，与 crm/系统/工具等业务组平级（修复 plan 决策与实际路由归类的冲突） | 需调整 `frontend/lib/sidebar-config.ts`（route move） |
| **D-F** | 业务状态 × 公海约束 | **成单锁定 ownerId** + **丢单自动入公海**：`status='lost'` → `ownerId=null`；`status='signed'` → 锁 `ownerId` | 需补 mock-crm-client `updateCustomer` 状态联动规则 |
| **D-G** | 公海权限 | 严格分级：<br/>• **admin**：全权（丢/抢/派/批量转移/看全部）<br/>• **businessdev**：领 + 丢自己的（不能派）<br/>• **operator**：只读，不能动 | 需补 `canMoveToSea` / `canAssignFromSea` 权限判断 |

### 2.2 未决（4 项 · spec 阶段继续拍）

| ID | 主题 | 关键问题 | 影响 |
|---|---|---|---|
| **Q1** | 线索状态机 | `new/contacting/qualified/converted/discarded` 之间流转规则？自动 vs 手动？跳级允许？ | Phase 3 线索详情页 / E2E `lead-to-customer.spec.ts` |
| **Q2** | 线索池入口 | 独立路由 `/dashboard/crm/leads/sea` 还是 scope 视图 `/dashboard/crm/leads?scope=sea`？ | sidebar 路由 + 客户列表复用模式 |
| **Q3** | follow 跨 owner 可见性 | 客户在公海后，老 owner 还能看历史 follow 吗？新 owner 抢单后能否看"前任"跟单？ | follow 列表 API 过滤逻辑 |
| **Q4** | 商机 won 是否回写 | plan 默认商机只读；要不要破例让 `opportunity.stage='won'` 触发 `customer.status='signed'`？ | mock-crm-client `updateOpportunity` 联动规则 |

> Q1-Q4 **不影响** §1.7 crm-advance-filter 推进，可在 Phase 1 Day 3-4 同步收口（开 §1.7 之前先聊 Q1-Q4 一轮即可）。

---

## 3. 业务域架构

### 3.1 实体关系图

```
        lead ──convertedToCustomerId──► customer ◄──customerId(强)── opportunity
              (线索转客户)                  │  (强外键：商机必挂客户)
                                            ▼
                                          follow
                              (entityType ∈ {customer, lead, opportunity},
                               entityId: 通用多态外键,
                               内容统一存储 · 按类型过滤)
```

### 3.2 5 个核心实体

| 实体 | 关键字段 | 状态机 |
|---|---|---|
| `customer` | `ownerId: string \| null`（null = 在公海），`status: active/lost/signed/on_hold` | 业务状态 × 公海归属 = 5 种合法组合（§4） |
| `lead` | `ownerId: string \| null`（null = 在线索池），`status: new/contacting/qualified/converted/discarded` | Q1 待定 |
| `opportunity` | `customerId: string`（**强外键**），`stage: lead_in/qualified/proposal/negotiation/won/lost`，`ownerId: string`（**非 null**，必填） | 6 阶段线性流转 |
| `follow` | `entityType: FollowEntityType`，`entityId: string` | 无状态（追加型） |
| `user` | `roleType: admin/businessdev/operator` | — |

### 3.3 关系说明

- **线索 → 客户**：`lead.convertedToCustomerId`（弱外键；转换时填入 + `convertedAt` 时间戳）
- **客户 → 商机**：`opportunity.customerId`（**强外键**；MVP 不允许孤儿商机；删除客户时 cascade 处理）
- **跨实体跟进**：`follow.entityType + entityId` 多态；列表/详情按类型过滤；同一客户的所有 follow 走同一种 entityType= customer
- **公海归属**：`customer.ownerId = null` 即"在公海"；`lead.ownerId = null` 即"在线索池"（Q2 待定入口形式）

---

## 4. 业务流程

### 4.1 主线（单线串联 · D-A 落点）

```
   [ 线索 ]                    [ 客户 ]                     [ 商机 ]
   new/contacting/qualified    active/on_hold               lead_in
   (Q1: 状态机待定)             (D-F: 可降级到 lost)            (MVP 只读详情)
         │                          │                             │
         │ "转客户"                 │ "创建商机"                  │
         │ (手动触发)                │ (手动触发)                  │
         ▼                          ▼                             ▼
   converted → customer.id    opportunity.customerId =     qualified → proposal
                              this.id (强外键)              → negotiation
                                                                → won | lost
                                                                     │
                                                                     ▼ (Q4 待定)
                                                              customer.status = signed
                                                              (MVP 阶段不联动)
```

### 4.2 公海流转（D-D + D-F 落点）

```
   客户(active/on_hold, owned)
        │
        │ "丢回" (owner 本人，状态必须 ∈ {active, on_hold}，必选原因)
        │              ↘── D-F 联动: status='lost' 自动落到这里
        ▼
   客户(?, ownerId = null)  ←── 公海视图
        │
        ├── 抢单 (任意权限内用户, ownerId = 自己)
        ├── 派单 (admin, ownerId = 目标人)
        └── V2 规则自动 (MVP 不做)
```

### 4.3 业务状态 × 公海归属 联动（D-F 落点）

`mock-crm-client.updateCustomer` 增加状态联动规则：

| 输入 | 联动效果 |
|---|---|
| `*` → `lost` | **强制 `ownerId = null`**（自动入公海） |
| `*` → `signed` | **锁定 `ownerId`**（后续任何丢/转移被拒；`canMoveToSea` / `canTransfer` 返回 false） |
| `signed` → `active` / `on_hold` | **V2 再说**（MVP 阶段仅 admin 可手动改；mock 客户端记录警告） |
| `*` → `lost` 后任何修改 | 拒绝（**`lost` 不可逆**） |

---

## 5. 客户状态机

### 5.1 合法组合矩阵（5 种）

| 业务状态 \ 公海归属 | owned（ownerId 有值） | sea（ownerId = null） |
|---|---|---|
| **active** | ✅ 正常持有 | ✅ 允许（被丢回但还想跟） |
| **on_hold** | ✅ 正常持有 | ✅ 允许（暂挂+在公海） |
| **signed** | ✅ **锁定**，禁止丢/转移 | ❌ **非法** |
| **lost** | ❌ **非法** | ✅ 自动入公海（**不可逆**） |

合法 5 种；`lost` 一旦设定**不可逆**（V2 再说"重建"）；`signed` 不可解锁（MVP 阶段仅 admin 可手动改）。

### 5.2 转换规则

| 起始 | 目标 | 规则 | 联动 |
|---|---|---|---|
| `active` | `on_hold` | 自由 | — |
| `on_hold` | `active` | 自由 | — |
| `active` / `on_hold` | `lost` | 自由 | **自动 `ownerId = null`** |
| `active` / `on_hold` | `signed` | admin 可；businessdev 需是 owner | **锁 `ownerId`** |
| `signed` | `active` / `on_hold` | 仅 admin 可（MVP 警告） | 解锁（V2 再说完整流程） |
| `lost` | 任何 | 拒绝 | `lost` 不可逆 |
| 任何 | `sea`（手动丢回） | owner 本人 + status ∈ {active, on_hold} + 必选原因 | `ownerId = null` |

---

## 6. 公海动作（D-D 落点）

### 6.1 动作通道

| 动作 | 触发者 | 前置条件 | 效果 | UI 入口 |
|---|---|---|---|---|
| **丢回** `moveToSea` | owner 本人 | `status ∈ {active, on_hold}` | `ownerId = null` + 必选原因 | 列表/详情"丢回公海"按钮 |
| **抢单** `claimFromSea` | 任意（权限内） | `ownerId = null` | `ownerId = 自己` | 公海列表"领取"按钮 |
| **派单** `assignFromSea` | admin | `ownerId = null` | `ownerId = 目标` | 公海列表/详情"派单给…"按钮 |

### 6.2 丢回原因枚举（必选）

1. **丢单**（客户明确不合作）
2. **长期无意向**（连续 N 天无跟进 / 客户响应消极）
3. **客户主动放弃**（客户来电/来信拒绝继续推进）
4. **其他**（自由文本兜底，限 200 字）

### 6.3 历史记录

**MVP 阶段**：丢回原因写入 `customer.remark` 末段（格式：`[sea:YYYY-MM-DD HH:mm reason="..." owner=...]`）
**V2 抽取**：`customer_sea_history` 表（独立表 + `sea_id` / `old_owner_id` / `new_owner_id` / `reason` / `timestamp` / `actor_id`）

---

## 7. 权限矩阵（D-G 落点）

| 动作 \ 角色 | admin | businessdev | operator |
|---|---|---|---|
| 看公海列表 | ✅ | ✅ | ✅ |
| 看"全部"客户（scope=all） | ✅ | ✅ | ❌（仅 mine） |
| 丢回自己的客户 | ✅ | ✅ | ❌ |
| 抢单（领取） | ✅ | ✅ | ❌ |
| 派单 | ✅ | ❌ | ❌ |
| 批量转移 owner | ✅ | ❌ | ❌ |
| 客户 → 商机（创建） | ✅ | ✅ | ❌ |
| 线索 → 客户（转化） | ✅ | ✅ | ❌ |

### 7.1 需新增的判断函数

`frontend/lib/crm/method/permission.ts` 补（D-G）：

```ts
export function canMoveToSea(user: User, customer: Customer): boolean {
  if (user.roleType === 'operator') return false
  return customer.ownerId === user.id || user.roleType === 'admin'
}

export function canAssignFromSea(user: User): boolean {
  return user.roleType === 'admin'
}
```

> plan §547-558 已有 `canEditCustomer` / `canClaimFromSea` / `canDeleteCustomer`；本次新增上面 2 个；`canClaimFromSea` 已写但需按 D-F 联动逻辑更新（`ownerId=null` + `status='lost'` 不可抢？答：lost 不可逆也即"在公海里但不能动"，需在抢单时校验 status ≠ lost）。

---

## 8. 范围声明

### 8.1 MVP 包含

- 5 实体列表 / 详情 / 编辑
- 线索 → 客户 转化（手动触发 + 转化时填 `convertedToCustomerId` + `convertedAt`）
- 客户 → 商机 创建（手动触发，商机 V2 浅做：仅列表 + 详情只读）
- 客户 ↔ 公海：丢回（必选原因） / 抢单 / 派单
- follow 跨实体（统一表 + `entityType`）
- scope 切换（`mine` / `all`，顶部 radiogroup，沿用 Phase 0 已实现）
- 业务状态 × 公海 联动规则（mock-crm-client 服务端实现）
- 权限判断（5 个 can* 函数）
- 路由调整：business-dev 拆出 crm 业务组

### 8.2 MVP 不做（V2 推迟 · 沿用 plan D6/D7/D8/D11/D13/D19）

- 商机 Kanban / 拖拽 / 报价单
- 自定义字段 / 公式引擎 / 表单设计器
- 线索池自动分配规则
- 公海自动回收规则
- 商机 `won/lost` 回写 `customer.status`（Q4 待定）
- 客户查重 / 合并 / 客户画像
- `signed` 解锁流程（仅 admin 手动改）
- `lost` 重建流程
- business-dev 模块（路由已拆但页面保留占位）
- `customer_sea_history` 独立表（V2 抽取）

---

## 9. plan 需要补的字段（v1.2 增量）

`docs/CRM-MVP-PLAN.md` v1.2 增量（不在本次 spec 范围；待 spec v0.2 拍板后另起 PR）：

- [ ] §1 决策表：补 D-A / D-B / D-C / D-D / D-E / D-F / D-G 共 7 项（本次 brainstorming 拍板）
- [ ] §4 类型：保留 `customer.ownerId: string | null`；`status` 4 选 1 不变（已对）
- [ ] §4 类型：保留 `follow.entityType ∈ {customer, lead, opportunity}`（已对）
- [ ] §5 接口：补 `moveToSea(id, reason)` / `claimFromSea(id)` / `assignFromSea(id, toOwnerId)`
- [ ] §5 接口：`updateCustomer` 加状态联动规则（D-F §4.3）
- [ ] §6 权限：补 `canMoveToSea` / `canAssignFromSea`；`canClaimFromSea` 加 status ≠ lost 校验
- [ ] §7 业务流程：补 §4.1 主线图 + §4.2 公海流转图 + §4.3 状态联动表
- [ ] §8 客户状态机：补 §5 合法组合矩阵 + 转换规则
- [ ] §10 sidebar：business-dev 三个 item 从 crm 业务组移出（D-E）
- [ ] §11 Phase 3：补线索池机制（Q2 待定）

---

## 10. 后续行动

1. **今天**（2026-07-17）
   - [x] brainstorming 拍板 7 项决策
   - [x] 写本 spec 文档 v0.1
   - [ ] commit + push 本 spec + 工作区其他未提交工作（不含 `.agent-contexts/` 速记）
2. **Phase 1 Day 3 同步**（§1.7 crm-advance-filter）
   - [ ] TDD 写 `crm-advance-filter/index.tsx` 4 case（添加 / 删除 / 重置 / 应用）
   - [ ] 实现 `crm-advance-filter/index.tsx`：3 字段筛选（状态 + 等级 + 来源，按 handoff §1.7 "Day 3 完不成 → 砍"）
   - [ ] URL 同步筛选条件
   - [ ] 接入 `customers/page.tsx`
3. **Phase 1 Day 3-4 同步**（Q1-Q4 收口）
   - [ ] 开下一轮 brainstorming 拍 Q1-Q4
   - [ ] spec v0.2 升级
4. **Phase 1 Day 4 末**（§1.13 PR）
   - [ ] 提 PR `feat(crm): customer list with advance filter`
5. **Phase 1 Day 5+**（按本 spec 推进）
   - [ ] 客户详情 Drawer（crm-overview-drawer）
   - [ ] 公海 UI（crm-sea-view，复用 customer-table + scope=sea）
   - [ ] 商机只读详情
   - [ ] 线索详情 + 转化

---

## 11. 变更日志

| 版本 | 日期 | 改动 | 拍板来源 |
|---|---|---|---|
| v0.1 | 2026-07-17 | 初稿：7 项已决 + 4 项未决 + 客户状态机 5 种合法组合 | 2026-07-17 brainstorming 会话 |
